import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';
import {
  MAX_MARKETS_PER_RUN, MAX_MARKETS_PER_VENUE, PAPER_MARKET_SYMBOL_PATTERN,
} from '../../../../packages/shared/src/strategy-catalog-contracts.js';

import type {
  PaperExperimentActivity,
  PaperExperimentActivityEvent,
  PaperExperimentActivityFill,
  PaperExperimentDetail,
  PaperExperimentRuntimeView,
} from '../../../../packages/shared/src/paper-experiment-contracts.js';
import type { PaperExperimentSnapshot } from './paper-experiment-store.js';

const FILE = 'nautilus.sqlite';
const OUTBOX_FILE = 'nautilus-events.jsonl';
const OWNER_FILE = 'nautilus-owner.json';
const CHILD_FILE = 'nautilus-child.json';
const SCHEMA = 'nautilus-paper-ledger-v1';
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_OUTBOX_BYTES = 512 * 1024 * 1024; // matches the Python outbox cap (multi-day runs)
const MAX_PAGE_SIZE = 100;
const RECOVERY_DIAGNOSTIC_PREFIX = 'Recovery diagnostic: ';
const PAPER_DIAGNOSTIC_PREFIX = 'Paper diagnostic: ';
const PAPER_LATENCY_PREFIX = 'Paper latency: ';
const VENUES = ['Hyperliquid', 'Lighter'] as const;
const Venue = z.enum(VENUES);
const Market = z.string().regex(PAPER_MARKET_SYMBOL_PATTERN);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Decimal = z.string().min(1).max(64).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const NonnegativeDecimal = Decimal.refine((value) => !value.startsWith('-'));
const PositiveDecimal = NonnegativeDecimal.refine((value) => !/^0(?:\.0+)?$/.test(value));
const CashBalance = z.string().min(1).max(80)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?: USDC)?$/);
const Text = z.string().min(1).max(2048);
const Timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/)
  .refine((value) => Number.isFinite(Date.parse(value)));
const Base = {
  v: z.literal(1),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: Timestamp,
  runId: z.string().min(1).max(128),
  venue: Venue.optional(),
  /** Original contiguous sequence from the Python process, before API events are interleaved. */
  sourceSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
};
const Position = z.object({
  market: Market,
  side: z.enum(['long', 'short']),
  remainingBaseQuantity: PositiveDecimal,
  /** Display facts for the positions table; older snapshots omit them. */
  avgEntryPrice: PositiveDecimal.optional(),
  markPrice: PositiveDecimal.optional(),
  unrealizedPnl: Decimal.optional(),
  openedAt: Timestamp.optional(),
}).strict();
const SnapshotAccount = z.object({
  venue: Venue,
  cashBalance: CashBalance,
  /** Live: the real balance when the run started (its realized and total PnL are counted from it). */
  startBalance: CashBalance.optional(),
  /** Live on several exchanges: why this exchange stopped trading while the others trade on. */
  halted: z.string().min(1).max(2_000).optional(),
  brokerRevision: Count,
  publicFrames: Count,
  pendingOrders: Count,
  signals: Count,
  intents: Count,
  fills: Count,
  rejectedSignals: Count,
  priceReady: z.boolean(),
  stalePriceObservationsSkipped: Count,
  positions: z.array(Position).max(MAX_MARKETS_PER_VENUE),
}).strict();
/** A market waiting for fresh data after a gap: since when, whether its venue reconnected, retries. */
const DataGap = z.object({
  sinceMs: z.number().int().nonnegative(),
  connected: z.boolean(),
  resubscribes: Count,
}).strict();
const SnapshotTrack = SnapshotAccount.omit({ cashBalance: true, startBalance: true, halted: true, brokerRevision: true, positions: true })
  .extend({ market: Market, dataGap: DataGap.optional() }).strict();
const Message = z.discriminatedUnion('type', [
  z.object({ ...Base, type: z.literal('phase'),
    stage: z.enum(['preparing', 'warming_up', 'waiting_for_data', 'running', 'recovering', 'stopping']),
    message: Text }).strict(),
  z.object({ ...Base, type: z.literal('snapshot'),
    stage: z.enum(['waiting_for_data', 'running', 'recovering', 'stopping']),
    accounts: z.array(SnapshotAccount).length(2), tracks: z.array(SnapshotTrack).min(1).max(MAX_MARKETS_PER_RUN).optional() }).strict(),
  z.object({ ...Base, type: z.literal('event'), market: Market.optional(), message: Text }).strict(),
  z.object({ ...Base, type: z.literal('failure'), market: Market.optional(), message: Text }).strict(),
  z.object({ ...Base, type: z.literal('fill'), venue: Venue,
    id: z.string().min(1).max(128), market: Market,
    kind: z.enum(['entry', 'exit']), side: z.enum(['buy', 'sell']),
    positionSide: z.enum(['long', 'short']), quantity: PositiveDecimal,
    quote: NonnegativeDecimal, price: PositiveDecimal, fee: NonnegativeDecimal,
    realizedPnl: Decimal.nullable() }).strict(),
  z.object({ ...Base, type: z.literal('stopped'), reason: Text }).strict(),
  /** Generic Pine Paper: one executed Pine order, reported back to the strategy. */
  z.object({ ...Base, type: z.literal('pine_fill'), venue: Venue, market: Market,
    reportSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    orderId: z.string().min(1).max(200), category: z.enum(['entry', 'exit']),
    leg: z.enum(['market', 'limit', 'stop', 'profit', 'loss', 'trail']),
    price: PositiveDecimal, time: z.number().int().positive(),
    qty: NonnegativeDecimal.optional(), tradeKey: z.string().min(1).max(260).optional() }).strict(),
  /** Generic Pine Paper: Pine evaluated one closed bar of a market (written by the API). */
  z.object({ ...Base, type: z.literal('pine_bar'), venue: Venue, market: Market,
    barCloseMs: z.number().int().positive(), orders: Count, openTrades: Count,
    positionSize: z.number().finite(), closedTrades: Count, netProfit: z.number().finite(),
    durationMs: Count, message: Text }).strict(),
]);

export type NautilusPaperMessageV1 = z.infer<typeof Message>;

type Binding = {
  readonly schema: typeof SCHEMA;
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly sourceSha256: string;
  readonly settingsSha256: string;
  /** Validation context only; settingsSha256 already pins it in the v1 disk identity. */
  readonly tracks: readonly { readonly venue: typeof VENUES[number]; readonly market: string }[];
  readonly accounts: readonly { readonly venue: typeof VENUES[number]; readonly accountId: string;
    readonly runId: string }[];
};
type Row = { readonly seq: number; readonly at: string; readonly type: string;
  readonly payload_json: string; readonly payload_sha256: string };
type FileIdentity = { readonly dev: number; readonly ino: number; readonly size: number;
  readonly mtimeMs: number; readonly ctimeMs: number };
const recoveredOutboxes = new Map<string, { readonly outbox: FileIdentity; readonly ledgerRows: number }>();

export class NautilusPaperLedgerQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'NautilusPaperLedgerQueryError'; }
}

export class NautilusPaperOutboxRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'NautilusPaperOutboxRecoveryError'; }
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function bindingIdentity({ tracks: _tracks, ...identity }: Binding): string {
  // Preserve exact v1 metadata bytes so historical HYPE ledgers remain readable.
  return canonical(identity);
}

function checkTracks(value: {
  readonly accounts: readonly { readonly venue: string }[];
  readonly tracks: Binding['tracks'];
  readonly settings: { readonly tracks: Binding['tracks'] };
}): void {
  const selected = value.tracks.map(track => `${track.venue}:${track.market}`);
  if (value.accounts.length !== 2 || value.tracks.length < 1 || value.tracks.length > MAX_MARKETS_PER_RUN
    || new Set(selected).size !== selected.length
    || value.tracks.some(track => !PAPER_MARKET_SYMBOL_PATTERN.test(track.market))
    || value.settings.tracks.length !== selected.length
    || new Set(value.settings.tracks.map(track => `${track.venue}:${track.market}`)).size !== selected.length
    || value.settings.tracks.some(track => !selected.includes(`${track.venue}:${track.market}`))
    || VENUES.some(venue => value.accounts.filter(account => account.venue === venue).length !== 1
      || value.tracks.filter(track => track.venue === venue).length > MAX_MARKETS_PER_VENUE)) {
    throw new Error(`Nautilus Paper requires one shared account per venue and at most ${MAX_MARKETS_PER_VENUE} selected markets on each venue.`);
  }
}

function bindingFromSnapshot(snapshot: PaperExperimentSnapshot): Binding {
  if (sha256(snapshot.source) !== snapshot.sourceSha256) throw new Error('Pinned Pine source hash differs.');
  checkTracks(snapshot);
  for (const track of snapshot.tracks) {
    const account = snapshot.accounts.find((candidate) => candidate.venue === track.venue)!;
    if (track.accountId !== account.accountId || track.runId !== account.runId) {
      throw new Error('Nautilus Paper track/account binding differs.');
    }
  }
  return {
    schema: SCHEMA,
    experimentId: snapshot.experimentId,
    strategyId: snapshot.strategyId,
    strategyVersion: snapshot.strategyVersion,
    sourceSha256: snapshot.sourceSha256,
    settingsSha256: sha256(canonical(snapshot.settings)),
    tracks: snapshot.tracks.map(({ venue, market }) => ({ venue, market })),
    accounts: VENUES.map((venue) => {
      const account = snapshot.accounts.find((candidate) => candidate.venue === venue)!;
      return { venue, accountId: account.accountId, runId: account.runId };
    }),
  };
}

function bindingFromDetail(detail: PaperExperimentDetail): Binding {
  checkTracks(detail);
  for (const track of detail.tracks) {
    const account = detail.accounts.find((candidate) => candidate.venue === track.venue)!;
    if (track.accountId !== account.accountId || track.runId !== account.runId) {
      throw new Error('Control track/account binding differs.');
    }
  }
  return {
    schema: SCHEMA,
    experimentId: detail.id,
    strategyId: detail.strategyId,
    strategyVersion: detail.strategyVersion,
    sourceSha256: detail.sourceSha256,
    settingsSha256: sha256(canonical(detail.settings)),
    tracks: detail.tracks.map(({ venue, market }) => ({ venue, market })),
    accounts: VENUES.map((venue) => {
      const account = detail.accounts.find((candidate) => candidate.venue === venue)!;
      return { venue, accountId: account.accountId, runId: account.runId };
    }),
  };
}

function checkedFile(directory: string, mustExist: boolean): string | null {
  const resolved = path.resolve(directory);
  if (!existsSync(resolved)) {
    if (mustExist) throw new Error('Nautilus Paper run directory is missing.');
    return null;
  }
  const dir = lstatSync(resolved);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Nautilus Paper run directory is unsafe.');
  const file = path.join(resolved, FILE);
  if (!existsSync(file)) {
    if (mustExist) return file;
    return null;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Nautilus Paper ledger path is unsafe.');
  return file;
}

function verifyIdentity(db: DatabaseSync, expected: Binding): void {
  const row = db.prepare("SELECT value FROM nautilus_metadata WHERE key = 'binding'").get() as
    { value: string } | undefined;
  if (!row || row.value !== bindingIdentity(expected)) throw new Error('Nautilus Paper ledger belongs to another launch.');
  const hash = db.prepare("SELECT value FROM nautilus_metadata WHERE key = 'binding_sha256'").get() as
    { value: string } | undefined;
  if (!hash || hash.value !== sha256(row.value)) throw new Error('Nautilus Paper binding checksum differs.');
}

function checkedMessage(value: unknown, expected: Binding): NautilusPaperMessageV1 {
  const message = Message.parse(value);
  if (message.runId !== expected.experimentId) throw new Error('Nautilus Paper run ID differs.');
  const selected = (venue: string | undefined, market: string) => expected.tracks.some(
    track => track.venue === venue && track.market === market);
  if ((message.type === 'fill' || message.type === 'event' || message.type === 'failure'
    || message.type === 'pine_fill' || message.type === 'pine_bar') && message.market
    && !selected(message.venue, message.market)) throw new Error('Nautilus Paper event market is not selected for this venue.');
  if (message.type === 'snapshot') {
    if (VENUES.some((venue) => message.accounts.filter((account) => account.venue === venue).length !== 1)) {
      throw new Error('Nautilus Paper snapshot must contain both venue accounts exactly once.');
    }
    for (const account of message.accounts) {
      if (account.positions.some(position => !selected(account.venue, position.market))
        || new Set(account.positions.map(position => position.market)).size !== account.positions.length) {
        throw new Error('Nautilus Paper positions contain an unselected or repeated market.');
      }
    }
    if (message.tracks && (message.tracks.length !== expected.tracks.length
      || new Set(message.tracks.map(track => `${track.venue}:${track.market}`)).size !== message.tracks.length
      || message.tracks.some(track => !selected(track.venue, track.market)))) {
      throw new Error('Nautilus Paper snapshot tracks differ from the selected markets.');
    }
  }
  if (message.type === 'fill') {
    if ((message.kind === 'entry' && ((message.side === 'buy') !== (message.positionSide === 'long')))
      || (message.kind === 'exit' && ((message.side === 'sell') !== (message.positionSide === 'long')))) {
      throw new Error('Nautilus Paper fill side and position side differ.');
    }
  }
  return message;
}

function checkedRow(row: Row, expected: Binding): NautilusPaperMessageV1 {
  if (!Number.isSafeInteger(row.seq) || row.seq < 1 || sha256(row.payload_json) !== row.payload_sha256) {
    throw new Error('Nautilus Paper record checksum differs.');
  }
  const message = checkedMessage(JSON.parse(row.payload_json), expected);
  if (message.seq !== row.seq || message.type !== row.type || message.at !== row.at) {
    throw new Error('Nautilus Paper record index differs.');
  }
  return message;
}

function view(message: Extract<NautilusPaperMessageV1, { type: 'snapshot' }>,
  expected: Binding): PaperExperimentRuntimeView {
  const runtime = {
    stage: message.stage,
    engine: 'nautilus' as const,
    fundingTreatment: 'excluded' as const,
    observedAt: new Date(message.at).toISOString(),
    ...(message.tracks ? { tracks: message.tracks } : {}),
    accounts: message.accounts.map((account) => {
      const identity = expected.accounts.find((candidate) => candidate.venue === account.venue)!;
      return { ...account, accountId: identity.accountId, runId: identity.runId };
    }),
  };
  return runtime;
}

function latestSnapshot(db: DatabaseSync, expected: Binding): PaperExperimentRuntimeView | null {
  const row = db.prepare("SELECT seq,at,type,payload_json,payload_sha256 FROM nautilus_records WHERE type = 'snapshot' ORDER BY seq DESC LIMIT 1")
    .get() as Row | undefined;
  if (!row) return null;
  const message = checkedRow(row, expected);
  if (message.type !== 'snapshot') throw new Error('Indexed Nautilus Paper snapshot differs.');
  return view(message, expected);
}

function openReadOnly(directory: string, expected: Binding): DatabaseSync | null {
  const file = checkedFile(directory, false);
  if (!file) return null;
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec('BEGIN;');
    verifyIdentity(db, expected);
    const counts = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS last FROM nautilus_records').get() as
      { n: number; last: number | null };
    if (!Number.isSafeInteger(counts.n) || counts.n !== (counts.last ?? 0)) {
      throw new Error('Nautilus Paper record sequence has a gap.');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function checkedCompanionIdentity(directory: string, name: string, maxBytes: number):
  { readonly file: string; readonly identity: FileIdentity } | null {
  const file = path.join(path.resolve(directory), name);
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new NautilusPaperOutboxRecoveryError(`Nautilus ${name} is unsafe or too large.`);
  }
  return { file, identity: { dev: info.dev, ino: info.ino, size: info.size,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } };
}

function checkedCompanionFile(directory: string, name: string, maxBytes: number): Buffer | null {
  const checked = checkedCompanionIdentity(directory, name, maxBytes);
  return checked ? readFileSync(checked.file) : null;
}

function identityFile(buffer: Buffer | null, name: string, experimentId: string):
  { readonly childPid: number | null; readonly parentPid: number } | null {
  if (!buffer) return null;
  let value: unknown;
  try { value = JSON.parse(buffer.toString('utf8')); }
  catch { throw new NautilusPaperOutboxRecoveryError(`Nautilus ${name} is invalid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NautilusPaperOutboxRecoveryError(`Nautilus ${name} is not an identity record.`);
  }
  const owner = value as Record<string, unknown>;
  if (owner.experimentId !== experimentId
    || !Number.isSafeInteger(owner.parentPid) || (owner.parentPid as number) < 1
    || !(owner.childPid === null || (Number.isSafeInteger(owner.childPid) && (owner.childPid as number) > 0))) {
    throw new NautilusPaperOutboxRecoveryError(`Nautilus ${name} identity differs.`);
  }
  return { childPid: owner.childPid as number | null, parentPid: owner.parentPid as number };
}

function proveChildDead(detail: PaperExperimentDetail, directory: string): boolean {
  const owner = identityFile(checkedCompanionFile(directory, OWNER_FILE, 8192), OWNER_FILE, detail.id);
  const child = identityFile(checkedCompanionFile(directory, CHILD_FILE, 8192), CHILD_FILE, detail.id);
  if (!owner && !child) return false;
  if (owner && child && (owner.parentPid !== child.parentPid
    || (owner.childPid !== null && owner.childPid !== child.childPid))) {
    throw new NautilusPaperOutboxRecoveryError('Nautilus child and API owner records disagree.');
  }
  const pid = child?.childPid ?? owner?.childPid ?? null;
  if (pid === null) throw new NautilusPaperOutboxRecoveryError('Nautilus child PID was not recorded.');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw new NautilusPaperOutboxRecoveryError('Nautilus child process death is not proven.');
  }
  throw new NautilusPaperOutboxRecoveryError('Nautilus child may still be running.');
}

function outboxMessages(buffer: Buffer, expected: Binding): NautilusPaperMessageV1[] {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 10) throw new NautilusPaperOutboxRecoveryError('Nautilus outbox has an incomplete trailing record.');
  const body = buffer.toString('utf8');
  if (!Buffer.from(body, 'utf8').equals(buffer)) {
    throw new NautilusPaperOutboxRecoveryError('Nautilus outbox is not valid UTF-8.');
  }
  const lines = body.slice(0, -1).split('\n');
  const messages: NautilusPaperMessageV1[] = [];
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new NautilusPaperOutboxRecoveryError('Nautilus outbox contains an invalid record length.');
    }
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { throw new NautilusPaperOutboxRecoveryError('Nautilus outbox contains invalid JSON.'); }
    let message: NautilusPaperMessageV1;
    try { message = checkedMessage(raw, expected); }
    catch { throw new NautilusPaperOutboxRecoveryError('Nautilus outbox contains an invalid or foreign event.'); }
    if (message.seq !== messages.length + 1 || message.sourceSeq !== undefined) {
      throw new NautilusPaperOutboxRecoveryError('Nautilus child event sequence is missing or duplicated.');
    }
    messages.push(message);
  }
  return messages;
}

function sameChildEvent(projected: NautilusPaperMessageV1, original: NautilusPaperMessageV1): boolean {
  const { seq: journalSeq, sourceSeq, ...body } = projected;
  const { seq: childSeq, ...originalBody } = original;
  return Number.isSafeInteger(journalSeq) && sourceSeq === childSeq
    && canonical(body) === canonical(originalBody);
}

/**
 * Recover fsynced child events that were not projected before an API crash.
 * Never mutate an active run or a run whose Python process might still live.
 */
export function reconcileNautilusPaperOutbox(
  detail: PaperExperimentDetail,
  directory: string,
): { readonly recovered: number } {
  if (detail.status !== 'completed' && detail.status !== 'interrupted') {
    throw new NautilusPaperOutboxRecoveryError('Nautilus outbox recovery requires a terminal run.');
  }
  const expected = bindingFromDetail(detail);
  const ledgerFile = checkedFile(directory, false);
  if (!ledgerFile) return { recovered: 0 };
  const outboxFile = checkedCompanionIdentity(directory, OUTBOX_FILE, MAX_OUTBOX_BYTES);
  if (!outboxFile) {
    const child = identityFile(checkedCompanionFile(directory, CHILD_FILE, 8192), CHILD_FILE, detail.id);
    const owner = identityFile(checkedCompanionFile(directory, OWNER_FILE, 8192), OWNER_FILE, detail.id);
    if (child || owner?.childPid !== null && owner !== null) {
      throw new NautilusPaperOutboxRecoveryError('Nautilus child outbox is missing.');
    }
    // Stopping during warmup can leave only the API's owner placeholder:
    // no Python child ever existed, so an outbox must not be invented.
    const read = openReadOnly(directory, expected);
    if (read) {
      try {
        const projected = read.prepare(`SELECT COUNT(*) AS n FROM nautilus_records
          WHERE json_extract(payload_json, '$.sourceSeq') IS NOT NULL`).get() as { n: number };
        if (projected.n !== 0) throw new NautilusPaperOutboxRecoveryError('Projected child events have no outbox.');
      } finally { read.close(); }
    }
    return { recovered: 0 };
  }
  if (!proveChildDead(detail, directory)) {
    throw new NautilusPaperOutboxRecoveryError('Nautilus child identity is missing.');
  }
  const cached = recoveredOutboxes.get(path.resolve(directory));
  if (cached && canonical(cached.outbox) === canonical(outboxFile.identity)) {
    const read = openReadOnly(directory, expected);
    if (read) {
      try {
        const count = read.prepare('SELECT COUNT(*) AS n FROM nautilus_records').get() as { n: number };
        if (count.n === cached.ledgerRows) return { recovered: 0 };
      } finally { read.close(); }
    }
  }
  const outbox = readFileSync(outboxFile.file);
  const afterRead = checkedCompanionIdentity(directory, OUTBOX_FILE, MAX_OUTBOX_BYTES);
  if (!afterRead || canonical(afterRead.identity) !== canonical(outboxFile.identity)) {
    throw new NautilusPaperOutboxRecoveryError('Nautilus outbox changed during verification.');
  }
  const messages = outboxMessages(outbox, expected);
  const db = new DatabaseSync(ledgerFile, { allowExtension: false });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
    try {
      verifyIdentity(db, expected);
      const counts = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS last FROM nautilus_records').get() as
        { n: number; last: number | null };
      if (!Number.isSafeInteger(counts.n) || counts.n !== (counts.last ?? 0)) {
        throw new NautilusPaperOutboxRecoveryError('Nautilus ledger event sequence has a gap.');
      }
      const projected = db.prepare(`SELECT seq,at,type,payload_json,payload_sha256 FROM nautilus_records
        WHERE json_extract(payload_json, '$.sourceSeq') IS NOT NULL
        ORDER BY json_extract(payload_json, '$.sourceSeq') ASC`).all() as Row[];
      if (projected.length > messages.length) {
        throw new NautilusPaperOutboxRecoveryError('Nautilus ledger has events absent from its child outbox.');
      }
      for (const [index, row] of projected.entries()) {
        const event = checkedRow(row, expected);
        if (event.sourceSeq !== index + 1 || !sameChildEvent(event, messages[index]!)) {
          throw new NautilusPaperOutboxRecoveryError('Nautilus ledger and child outbox disagree.');
        }
      }
      const insert = db.prepare('INSERT INTO nautilus_records(seq,at,type,payload_json,payload_sha256) VALUES (?,?,?,?,?)');
      let nextSeq = counts.n + 1;
      for (const event of messages.slice(projected.length)) {
        const replayed = checkedMessage({ ...event, sourceSeq: event.seq, seq: nextSeq++ }, expected);
        const payload = JSON.stringify(replayed);
        insert.run(replayed.seq, replayed.at, replayed.type, payload, sha256(payload));
      }
      const recovered = messages.length - projected.length;
      if (recovered) {
        const audit = checkedMessage({ v: 1, seq: nextSeq, at: new Date().toISOString(),
          runId: detail.id, type: 'phase', stage: 'recovering',
          message: `Recovered ${recovered} durable Nautilus event${recovered === 1 ? '' : 's'} after the API process ended.` }, expected);
        const payload = JSON.stringify(audit);
        insert.run(audit.seq, audit.at, audit.type, payload, sha256(payload));
      }
      db.exec('COMMIT;');
      recoveredOutboxes.set(path.resolve(directory), { outbox: outboxFile.identity,
        ledgerRows: nextSeq + (recovered ? 1 : 0) - 1 });
      return { recovered };
    } catch (error) { db.exec('ROLLBACK;'); throw error; }
  } finally { db.close(); }
}

function controlEvents(detail: PaperExperimentDetail): PaperExperimentActivityEvent[] {
  const run = detail.live ? 'LIVE run' : 'Paper experiment';
  const result: PaperExperimentActivityEvent[] = [
    { id: 'control:created', at: detail.createdAt, kind: 'created', message: `${run} created.` },
  ];
  if (detail.startedAt) result.push({ id: 'control:started', at: detail.startedAt,
    kind: 'started', message: detail.live ? 'LIVE trading started.' : 'Paper execution started.' });
  if (detail.endedAt) result.push({ id: 'control:ended', at: detail.endedAt,
    kind: 'stopped', message: detail.status === 'completed' ? `${run} completed.` : `${run} interrupted.` });
  return result;
}

function activityEvent(message: NautilusPaperMessageV1, live = false): PaperExperimentActivityEvent | null {
  const base = { id: `nautilus:${message.seq}`, at: new Date(message.at).toISOString(),
    ...(message.venue ? { venue: message.venue } : {}),
    ...('market' in message && message.market ? { market: message.market } : {}) };
  if (message.type === 'pine_fill') return { ...base, kind: 'signal',
    message: `Pine ${message.category} "${message.orderId}" executed (${message.leg}) at ${message.price}`
      + `${message.qty ? `, Pine qty ${message.qty}` : ''}.` };
  if (message.type === 'pine_bar') return { ...base, kind: 'signal', message: message.message };
  if (message.type === 'phase') return { ...base, kind: 'status',
    message: message.stage === 'stopping'
      ? (live ? 'Stopping LIVE; closing every position of this run.' : 'Stopping both virtual accounts.') : message.message };
  if (message.type === 'event' && (message.message.startsWith(RECOVERY_DIAGNOSTIC_PREFIX)
    || message.message.startsWith(PAPER_DIAGNOSTIC_PREFIX)
    || message.message.startsWith(PAPER_LATENCY_PREFIX))) return null;
  if (message.type === 'event') return { ...base, kind: 'status',
    message: message.message.startsWith('Hourly data refresh failed:')
      ? 'Waiting to verify the next closed hour.' : publicDataEventText(message.message) };
  if (message.type === 'failure') return { ...base, kind: 'status',
    message: live ? 'LIVE engine failed; the run stops and closes every position.' : 'Paper runtime failed; the experiment is stopping.' };
  if (message.type === 'stopped') return { ...base, kind: 'stopped', message: live ? 'LIVE engine stopped.' : 'Paper runtime stopped.' };
  if (message.type === 'fill') return { ...base, kind: 'fill', venue: message.venue, market: message.market,
    message: `${message.kind === 'entry' ? 'Entry' : 'Exit'} ${live ? `fill on ${message.venue}.` : 'virtual fill committed.'}` };
  return null;
}

function publicDataEventText(message: string): string {
  if (/^Public data gap started: (?:Hyperliquid|Lighter); gap \d+; waiting for verified recovery\.$/.test(message)) {
    return 'Public data interrupted; trading paused until fresh data and accounts are verified.';
  }
  const started = /^Public data gap started: (?:Hyperliquid|Lighter); gap \d+; timeout (\d+) ms\.$/.exec(message);
  if (started) return `Public data interrupted; recovering for up to ${Number(started[1]) / 1000} seconds.`;
  const recovered = /^Public data gap recovered: (?:Hyperliquid|Lighter); gap \d+; duration (\d+) ms; discarded (\d+) observations\.$/.exec(message);
  if (recovered) return `Public data recovered after ${recovered[1]} ms; ${recovered[2]} observations skipped during the gap.`;
  return message;
}

function newestEvent(left: PaperExperimentActivityEvent, right: PaperExperimentActivityEvent): number {
  const time = (right.at ?? '').localeCompare(left.at ?? '');
  if (time) return time;
  const leftSeq = /^nautilus:(\d+)$/.exec(left.id);
  const rightSeq = /^nautilus:(\d+)$/.exec(right.id);
  if (leftSeq && rightSeq) return Number(rightSeq[1]) - Number(leftSeq[1]);
  return right.id.localeCompare(left.id);
}

function fill(message: Extract<NautilusPaperMessageV1, { type: 'fill' }>): PaperExperimentActivityFill {
  return { id: message.id, at: new Date(message.at).toISOString(), venue: message.venue,
    market: message.market, kind: message.kind, side: message.side,
    positionSide: message.positionSide, quantity: message.quantity,
    quote: message.quote, price: message.price, fee: message.fee,
    realizedPnl: message.realizedPnl };
}

function cursorFor(detail: PaperExperimentDetail, cursor: string | undefined): number | null {
  if (!cursor) return null;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new NautilusPaperLedgerQueryError('Invalid fills cursor.');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid cursor.');
    const object = parsed as Record<string, unknown>;
    if (Object.keys(object).sort().join(',') !== 'beforeSeq,id,v'
      || object.v !== 1 || object.id !== detail.id
      || !Number.isSafeInteger(object.beforeSeq) || (object.beforeSeq as number) < 1) {
      throw new Error('Invalid cursor.');
    }
    return object.beforeSeq as number;
  } catch { throw new NautilusPaperLedgerQueryError('Invalid fills cursor.'); }
}

/** One synchronous SQLite transaction per accepted sidecar/control event. */
export class NautilusPaperLedger {
  readonly databasePath: string;
  readonly #db: DatabaseSync;
  readonly #binding: Binding;
  #nextSeq: number;
  #latestView: PaperExperimentRuntimeView | null;
  #closed = false;

  constructor(directory: string, snapshot: PaperExperimentSnapshot) {
    this.#binding = bindingFromSnapshot(snapshot);
    this.databasePath = checkedFile(directory, true)!;
    const db = new DatabaseSync(this.databasePath, { allowExtension: false });
    try {
      chmodSync(this.databasePath, 0o600);
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      db.exec(`CREATE TABLE IF NOT EXISTS nautilus_metadata (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS nautilus_records (
        seq INTEGER PRIMARY KEY CHECK (seq > 0), at TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS nautilus_records_type_seq ON nautilus_records(type,seq DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS nautilus_fill_id ON nautilus_records(
        json_extract(payload_json, '$.id')) WHERE type = 'fill';
      CREATE UNIQUE INDEX IF NOT EXISTS nautilus_source_seq ON nautilus_records(
        json_extract(payload_json, '$.sourceSeq'))
        WHERE json_extract(payload_json, '$.sourceSeq') IS NOT NULL;`);
      const identity = bindingIdentity(this.#binding);
      db.prepare("INSERT OR IGNORE INTO nautilus_metadata(key,value) VALUES ('binding',?)").run(identity);
      db.prepare("INSERT OR IGNORE INTO nautilus_metadata(key,value) VALUES ('binding_sha256',?)").run(sha256(identity));
      verifyIdentity(db, this.#binding);
      const counts = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS last FROM nautilus_records').get() as
        { n: number; last: number | null };
      if (!Number.isSafeInteger(counts.n) || counts.n !== (counts.last ?? 0)) {
        throw new Error('Nautilus Paper record sequence has a gap.');
      }
      this.#nextSeq = counts.n + 1;
      this.#latestView = latestSnapshot(db, this.#binding);
      this.#db = db;
    } catch (error) { db.close(); throw error; }
  }

  append(value: unknown): void {
    if (this.#closed) throw new Error('Nautilus Paper ledger is closed.');
    const message = checkedMessage(value, this.#binding);
    if (message.seq !== this.#nextSeq) throw new Error('Nautilus Paper event sequence is missing or duplicated.');
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('Nautilus Paper event is too large.');
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      this.#db.prepare('INSERT INTO nautilus_records(seq,at,type,payload_json,payload_sha256) VALUES (?,?,?,?,?)')
        .run(message.seq, message.at, message.type, payload, sha256(payload));
      this.#db.exec('COMMIT;');
    } catch (error) { this.#db.exec('ROLLBACK;'); throw error; }
    this.#nextSeq += 1;
    if (message.type === 'snapshot') this.#latestView = view(message, this.#binding);
  }

  snapshot(): PaperExperimentRuntimeView | null { return this.#latestView ? structuredClone(this.#latestView) : null; }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}

/** Read a saved snapshot even after the API no longer owns a running sidecar. */
export function readNautilusPaperSnapshot(detail: PaperExperimentDetail, directory: string): PaperExperimentRuntimeView | null {
  if (detail.status === 'completed' || detail.status === 'interrupted') {
    reconcileNautilusPaperOutbox(detail, directory);
  }
  return readNautilusPaperLedgerSnapshot(detail, directory);
}

/**
 * The last snapshot already in the ledger, without replaying the child outbox. Replay re-reads and
 * verifies the whole outbox (seconds per large run) and blocks the process, so lists use this.
 */
export function readNautilusPaperLedgerSnapshot(detail: PaperExperimentDetail, directory: string): PaperExperimentRuntimeView | null {
  const db = openReadOnly(directory, bindingFromDetail(detail));
  if (!db) return null;
  try { return latestSnapshot(db, bindingFromDetail(detail)); }
  finally { db.close(); }
}

/** Read all fills by stable append sequence, with no fabricated trades on error. */
export function readNautilusPaperActivity(
  detail: PaperExperimentDetail,
  directory: string,
  limit = 20,
  fillsCursor?: string,
): PaperExperimentActivity {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new NautilusPaperLedgerQueryError('Fill page size must be between 1 and 100.');
  }
  if (detail.status === 'completed' || detail.status === 'interrupted') {
    reconcileNautilusPaperOutbox(detail, directory);
  }
  const before = cursorFor(detail, fillsCursor);
  const expected = bindingFromDetail(detail);
  const db = openReadOnly(directory, expected);
  const control = controlEvents(detail);
  if (!db) return { events: control, eventCoverage: 'key_milestones', fills: [], totalFills: null,
    nextFillsCursor: null, coverage: 'control_only' };
  try {
    const rows = db.prepare(`SELECT seq,at,type,payload_json,payload_sha256 FROM nautilus_records
      WHERE type = 'fill' ${before === null ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT ?`)
      .all(...(before === null ? [limit + 1] : [before, limit + 1])) as Row[];
    const page = rows.slice(0, limit);
    const fills = page.map((row) => {
      const message = checkedRow(row, expected);
      if (message.type !== 'fill') throw new Error('Indexed Nautilus Paper fill differs.');
      return fill(message);
    });
    const total = db.prepare("SELECT COUNT(*) AS n FROM nautilus_records WHERE type = 'fill'").get() as { n: number };
    if (!Number.isSafeInteger(total.n) || total.n < 0) throw new Error('Invalid Nautilus Paper fill count.');
    const recent = db.prepare(`SELECT seq,at,type,payload_json,payload_sha256 FROM nautilus_records
      WHERE type IN ('phase','event','failure','stopped','fill','pine_fill','pine_bar')
        AND (type <> 'event' OR (
          substr(json_extract(payload_json, '$.message'), 1, ?) <> ?
          AND substr(json_extract(payload_json, '$.message'), 1, ?) <> ?
          AND substr(json_extract(payload_json, '$.message'), 1, ?) <> ?))
      ORDER BY seq DESC LIMIT 50`)
      // Frequent technical checks remain durable without displacing user milestones.
      .all(RECOVERY_DIAGNOSTIC_PREFIX.length, RECOVERY_DIAGNOSTIC_PREFIX,
        PAPER_DIAGNOSTIC_PREFIX.length, PAPER_DIAGNOSTIC_PREFIX,
        PAPER_LATENCY_PREFIX.length, PAPER_LATENCY_PREFIX) as Row[];
    const events = [...control, ...recent.map((row) => activityEvent(checkedRow(row, expected), Boolean(detail.live)))
      .filter((event): event is PaperExperimentActivityEvent => event !== null)]
      .sort(newestEvent)
      .slice(0, 50);
    const nextFillsCursor = rows.length > limit && page.length
      ? Buffer.from(JSON.stringify({ v: 1, id: detail.id, beforeSeq: page.at(-1)!.seq }), 'utf8').toString('base64url')
      : null;
    return { events, eventCoverage: 'key_milestones', fills, totalFills: total.n,
      nextFillsCursor, coverage: 'durable_journal' };
  } finally { db.close(); }
}
