import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NautilusPaperLedger, readNautilusPaperLedgerSnapshot, readNautilusPaperSnapshot, reconcileNautilusPaperOutbox,
} from '../apps/api/src/paper-execution/nautilus-paper-ledger.js';
import { readPaperExperimentActivityV1 } from '../apps/api/src/paper-execution/paper-experiment-activity.js';
import { PaperExperimentStoreV1 } from '../apps/api/src/paper-execution/paper-experiment-store.js';

const NAUTILUS_PAPER_MARKETS = ['HYPE', 'SOL', 'XRP', 'SUI', 'DOGE'] as const;

const roots: string[] = [];
const source = '//@version=6\nstrategy("Nautilus ledger")\n';
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const at = '2026-09-30T11:00:00.000Z';
const settings = {
  accountModel: 'venue_shared_v2' as const, timeframe: '1h' as const,
  tracks: [{ venue: 'Hyperliquid' as const, market: 'HYPE' as const },
    { venue: 'Lighter' as const, market: 'HYPE' as const }],
  capitalPerVenue: 1_000, orderSizePercentOfRealizedEquity: 10,
  hyperliquidMakerEntryFeePercent: 0.1, hyperliquidTakerExitFeePercent: 0.2,
  lighterMakerEntryFeePercent: 0.1, lighterTakerExitFeePercent: 0.2,
};

function fixture(tracks: readonly { venue: 'Hyperliquid' | 'Lighter'; market: typeof NAUTILUS_PAPER_MARKETS[number] }[] = settings.tracks,
  runSettings: object = { ...settings, tracks }) {
  const root = mkdtempSync(path.join(tmpdir(), 'nautilus-ledger-'));
  roots.push(root);
  const store = new PaperExperimentStoreV1(path.join(root, 'control'), () => Date.UTC(2026, 8, 30, 11));
  const detail = store.reserve({ request: { strategyId: randomUUID(), version: 1,
    sourceSha256, settings: runSettings as typeof settings, idempotencyKey: randomUUID() },
  strategyName: 'Nautilus ledger', source }).experiment;
  const snapshot = store.snapshot(detail.id)!;
  store.close();
  const runs = path.join(root, 'runs');
  const directory = path.join(runs, detail.id);
  mkdirSync(directory, { recursive: true });
  return { root, runs, directory, detail, snapshot };
}

function envelope(runId: string, seq: number) {
  return { v: 1 as const, seq, at, runId };
}

function accounts() {
  return (['Lighter', 'Hyperliquid'] as const).map((venue) => ({
    venue, cashBalance: '1000.00000000 USDC', brokerRevision: 1,
    publicFrames: venue === 'Lighter' ? 3 : 2,
    pendingOrders: 0, signals: 1, intents: 1, fills: 0,
    rejectedSignals: 0, priceReady: true,
    stalePriceObservationsSkipped: 0,
    positions: [],
  }));
}

function fill(runId: string, seq: number, venue: 'Lighter' | 'Hyperliquid', id: string) {
  return { ...envelope(runId, seq), type: 'fill' as const, venue, id,
    market: 'HYPE' as const, kind: 'entry' as const,
    side: 'buy' as const, positionSide: 'long' as const,
    quantity: '1', quote: '100', price: '100', fee: '0.1', realizedPnl: null };
}

function childFiles(directory: string, experimentId: string, childPid: number): void {
  writeFileSync(path.join(directory, 'nautilus-child.json'), JSON.stringify({
    experimentId, parentPid: process.pid, childPid,
  }));
  writeFileSync(path.join(directory, 'nautilus-owner.json'), JSON.stringify({
    experimentId, parentPid: process.pid, childPid, exited: true,
  }));
}

function outbox(directory: string, messages: readonly object[], complete = true): void {
  writeFileSync(path.join(directory, 'nautilus-events.jsonl'),
    messages.map((message) => JSON.stringify(message)).join('\n') + (complete ? '\n' : ''));
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Nautilus Paper durable ledger', () => {
  it('persists the exact failure market and reason, rejects foreign pairs, and reads older unscoped failures', () => {
    const { directory, runs, detail, snapshot } = fixture([
      ...NAUTILUS_PAPER_MARKETS.map(market => ({ venue: 'Lighter' as const, market })),
      { venue: 'Hyperliquid', market: 'HYPE' }, { venue: 'Hyperliquid', market: 'DOGE' },
    ]);
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const incident = { ...envelope(detail.id, 1), type: 'failure', venue: 'Lighter', market: 'SOL',
      message: 'Paper book callback failed: ValueError: SOL instrument quantity step changed' };
    expect(() => ledger.append({ ...incident, venue: 'Hyperliquid' })).toThrow(/not selected/);
    const { venue: _venue, ...withoutVenue } = incident;
    expect(() => ledger.append(withoutVenue)).toThrow(/not selected/);
    ledger.append(incident);
    const historical = { ...envelope(detail.id, 2), type: 'failure', venue: 'Hyperliquid', message: 'Historical venue failure' };
    const global = { ...envelope(detail.id, 3), type: 'failure', message: 'Historical process failure' };
    ledger.append(historical);
    ledger.append(global);
    ledger.close();
    const reopened = new NautilusPaperLedger(directory, snapshot);
    reopened.close();
    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'), { readOnly: true });
    const rows = db.prepare('SELECT payload_json FROM nautilus_records ORDER BY seq').all() as { payload_json: string }[];
    expect(rows.map(row => JSON.parse(row.payload_json))).toEqual([incident, historical, global]);
    db.close();
    const activity = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(activity.coverage).toBe('durable_journal');
    expect(activity.events.find(row => row.id === 'nautilus:1')).toMatchObject({
      kind: 'status', venue: 'Lighter', market: 'SOL', message: 'Paper runtime failed; the experiment is stopping.',
    });
    expect(activity.events.find(row => row.id === 'nautilus:2')).not.toHaveProperty('market');
    expect(activity.events.find(row => row.id === 'nautilus:3')).not.toHaveProperty('venue');
  });

  it('restores ten market tracks on two shared accounts and keeps fill and event markets distinct', () => {
    const selected = NAUTILUS_PAPER_MARKETS.flatMap(market => [
      { venue: 'Lighter' as const, market }, { venue: 'Hyperliquid' as const, market },
    ]);
    const { directory, runs, detail, snapshot } = fixture(selected);
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const tracks = selected.map((track, index) => ({ ...track, publicFrames: index + 1,
      pendingOrders: 0, signals: index + 2, intents: index + 3, fills: 1, rejectedSignals: 0,
      priceReady: index % 2 === 0, stalePriceObservationsSkipped: index }));
    const shared = accounts().map(account => ({ ...account, positions: NAUTILUS_PAPER_MARKETS.map(market => ({
      market, side: 'long' as const, remainingBaseQuantity: '1',
    })) }));
    ledger.append({ ...envelope(detail.id, 1), type: 'snapshot', stage: 'recovering', accounts: shared, tracks });
    for (const [index, track] of selected.entries()) {
      ledger.append({ ...fill(detail.id, index + 2, track.venue, `${track.venue}:${track.market}`), market: track.market });
    }
    ledger.append({ ...envelope(detail.id, 12), type: 'event', venue: 'Lighter', market: 'DOGE', message: 'long level touched' });
    ledger.close();
    const restored = readNautilusPaperSnapshot(detail, directory)!;
    expect(restored.tracks).toEqual(tracks);
    expect(restored.accounts).toHaveLength(2);
    expect(restored.accounts.every(account => account.positions.length === 5)).toBe(true);
    expect(new Set(detail.tracks.map(track => track.accountId)).size).toBe(2);
    const first = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs, limit: 6 });
    const second = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs, limit: 6, fillsCursor: first.nextFillsCursor! });
    expect(first).toMatchObject({ coverage: 'durable_journal', totalFills: 10 });
    expect([...first.fills, ...second.fills].map(row => `${row.venue}:${row.market}`).sort())
      .toEqual(selected.map(row => `${row.venue}:${row.market}`).sort());
    expect(first.events.find(row => row.id === 'nautilus:12')).toMatchObject({ venue: 'Lighter', market: 'DOGE' });
    for (const row of first.events.filter(row => row.kind === 'fill')) {
      const committed = [...first.fills, ...second.fills].find(fill => fill.venue === row.venue && fill.market === row.market);
      expect(committed).toBeDefined();
    }
  });

  it('binds fifteen markets on each venue', () => {
    const markets = ['HYPE', 'SOL', 'XRP', 'SUI', 'DOGE', 'LIT', 'ADA', 'ZEC', 'NEAR', 'PUMP',
      'PRL', 'STRK', 'XMR', 'ZRO', 'SKR'];
    const selected = markets.flatMap(market => [
      { venue: 'Lighter' as const, market }, { venue: 'Hyperliquid' as const, market },
    ]) as unknown as Parameters<typeof fixture>[0];
    const { directory, detail, snapshot } = fixture(selected, {
      accountModel: 'pine_live_v1', timeframe: '1h', tracks: selected, capitalPerVenue: 1_000, orderSizePercent: 10,
      hyperliquidMakerFeePercent: null, hyperliquidTakerFeePercent: null, lighterMakerFeePercent: null, lighterTakerFeePercent: null,
    });
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const tracks = selected.map(track => ({ ...track, publicFrames: 1, pendingOrders: 0, signals: 0, intents: 0,
      fills: 0, rejectedSignals: 0, priceReady: true, stalePriceObservationsSkipped: 0 }));
    ledger.append({ ...envelope(detail.id, 1), type: 'snapshot', stage: 'running', accounts: accounts(), tracks });
    ledger.close();
    expect(readNautilusPaperSnapshot(detail, directory)!.tracks).toHaveLength(30);
  });

  it('rejects foreign, missing and repeated track facts before any SQLite append', () => {
    const { directory, detail, snapshot } = fixture([
      { venue: 'Lighter', market: 'SOL' }, { venue: 'Lighter', market: 'HYPE' },
      { venue: 'Hyperliquid', market: 'DOGE' },
    ]);
    expect(() => new NautilusPaperLedger(directory, { ...snapshot, settings: { ...snapshot.settings,
      tracks: [snapshot.settings.tracks[0]!, snapshot.settings.tracks[0]!, snapshot.settings.tracks[2]!],
    } })).toThrow(/selected markets/);
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const base = { ...envelope(detail.id, 1), type: 'snapshot', stage: 'running', accounts: accounts() };
    const tracks = snapshot.tracks.map(({ venue, market }) => ({ venue, market,
      publicFrames: 0, pendingOrders: 0, signals: 0, intents: 0, fills: 0, rejectedSignals: 0,
      priceReady: false, stalePriceObservationsSkipped: 0 }));
    expect(() => ledger.append({ ...fill(detail.id, 1, 'Hyperliquid', 'foreign'), market: 'SOL' })).toThrow(/not selected/);
    expect(() => ledger.append({ ...envelope(detail.id, 1), type: 'event', market: 'SOL', message: 'no venue' })).toThrow(/not selected/);
    expect(() => ledger.append({ ...base, tracks: tracks.slice(1) })).toThrow(/tracks differ/);
    expect(() => ledger.append({ ...base, tracks: [tracks[0], tracks[0], tracks[2]] })).toThrow(/tracks differ/);
    expect(() => ledger.append({ ...base, accounts: accounts().map(account => ({ ...account,
      positions: [{ market: 'XRP', side: 'long', remainingBaseQuantity: '1' }],
    })) })).toThrow(/unselected/);
    ledger.append({ ...base, tracks });
    expect(ledger.snapshot()?.tracks).toEqual(tracks);
    ledger.close();
    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'), { readOnly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM nautilus_records').get()).toMatchObject({ n: 1 });
    const binding = db.prepare("SELECT value FROM nautilus_metadata WHERE key='binding'").get() as { value: string };
    expect(Object.keys(JSON.parse(binding.value)).sort()).toEqual([
      'accounts', 'experimentId', 'schema', 'settingsSha256', 'sourceSha256', 'strategyId', 'strategyVersion',
    ]);
    db.close();
  });

  it.each(['Recovery diagnostic: ', 'Paper diagnostic: ', 'Paper latency: '])(
    'persists %s rows without showing them or crowding gap milestones out of activity', (prefix) => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const rawMessages: string[] = [];
    function record(message: string): void {
      rawMessages.push(message);
      ledger.append({ ...envelope(detail.id, rawMessages.length), type: 'event', venue: 'Hyperliquid', message });
    }
    record('Public data gap started: Hyperliquid; gap 1; timeout 60000 ms.');
    for (let i = 1; i <= 60; i++) record(prefix + JSON.stringify({ stage: 'waiting', elapsedMs: i * 500 }));
    record('Public data gap recovered: Hyperliquid; gap 1; duration 30500 ms; discarded 12 observations.');
    for (let i = 1; i <= 60; i++) record(prefix + JSON.stringify({ stage: 'audited', sample: i }));
    ledger.close();

    const activity = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(activity).toMatchObject({ coverage: 'durable_journal', totalFills: 0 });
    expect(activity.events.filter((event) => event.id.startsWith('nautilus:')).map((event) => event.message)).toEqual([
      'Public data recovered after 30500 ms; 12 observations skipped during the gap.',
      'Public data interrupted; recovering for up to 60 seconds.',
    ]);
    expect(activity.events.some((event) => event.message.startsWith(prefix))).toBe(false);
    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'), { readOnly: true });
    const rows = db.prepare('SELECT payload_json FROM nautilus_records ORDER BY seq').all() as { payload_json: string }[];
    db.close();
    expect(rows.map((row) => JSON.parse(row.payload_json).message)).toEqual(rawMessages);
  });

  it.each([
    ['timeout 60000 ms.', 'Public data interrupted; recovering for up to 60 seconds.'],
    ['waiting for verified recovery.', 'Public data interrupted; trading paused until fresh data and accounts are verified.'],
  ])('restores accounts and preserves current or historical gap events: %s', (policy, label) => {
    const { directory, runs, detail, snapshot } = fixture();
    let ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append({ ...envelope(detail.id, 1), type: 'snapshot', stage: 'running', accounts: accounts() });
    const before = ledger.snapshot()!;
    const started = `Public data gap started: Hyperliquid; gap 1; ${policy}`;
    const recovered = 'Public data gap recovered: Hyperliquid; gap 1; duration 1234 ms; discarded 12 observations.';
    ledger.append({ ...envelope(detail.id, 2), type: 'event', venue: 'Hyperliquid', message: started });
    ledger.append({ ...envelope(detail.id, 3), type: 'phase', stage: 'recovering',
      message: 'Public data interrupted; waiting for reconnection and fresh market data' });
    ledger.append({ ...envelope(detail.id, 4), type: 'snapshot', stage: 'recovering',
      accounts: accounts().map((account) => ({ ...account, priceReady: false })) });
    const recovering = ledger.snapshot()!;
    expect(recovering).toMatchObject({ stage: 'recovering', engine: 'nautilus' });
    expect(recovering.accounts).toEqual(before.accounts.map((account) => ({ ...account, priceReady: false })));
    ledger.close();
    expect(readNautilusPaperSnapshot(detail, directory)).toEqual(recovering);
    ledger = new NautilusPaperLedger(directory, snapshot);
    expect(ledger.snapshot()).toEqual(recovering);
    ledger.append({ ...envelope(detail.id, 5), type: 'event', venue: 'Hyperliquid', message: recovered });
    ledger.append({ ...envelope(detail.id, 6), type: 'phase', stage: 'running',
      message: 'Public data recovered; Paper accounts preserved' });
    ledger.append({ ...envelope(detail.id, 7), type: 'snapshot', stage: 'running', accounts: accounts() });
    expect(ledger.snapshot()!.accounts).toEqual(before.accounts);
    ledger.close();
    expect(readNautilusPaperSnapshot(detail, directory)).toEqual(before);
    const activity = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(activity).toMatchObject({ coverage: 'durable_journal', totalFills: 0 });
    expect(activity.events.map((event) => event.message)).toContain(label);
    expect(activity.events.map((event) => event.message)).toContain('Public data recovered after 1234 ms; 12 observations skipped during the gap.');
    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'), { readOnly: true });
    const rows = db.prepare("SELECT payload_json FROM nautilus_records WHERE type = 'event' ORDER BY seq").all() as { payload_json: string }[];
    db.close();
    expect(rows.map((row) => JSON.parse(row.payload_json).message)).toEqual([started, recovered]);
  });

  it('binds two accounts, serves a stopped snapshot and pages committed fills across venues', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append({ ...envelope(detail.id, 1), type: 'phase', stage: 'warming_up', message: 'Loading history.' });
    ledger.append({ ...envelope(detail.id, 2), type: 'snapshot', stage: 'running', accounts: accounts() });
    ledger.append(fill(detail.id, 3, 'Lighter', 'lighter-fill-1'));
    ledger.append(fill(detail.id, 4, 'Hyperliquid', 'hyperliquid-fill-1'));
    const live = ledger.snapshot()!;
    expect(live).toMatchObject({ stage: 'running', fundingTreatment: 'excluded', engine: 'nautilus' });
    for (const observed of live.accounts) {
      const control = detail.accounts.find((account) => account.venue === observed.venue)!;
      expect(observed).toMatchObject({ accountId: control.accountId, runId: control.runId });
    }
    ledger.close();
    expect(readNautilusPaperSnapshot(detail, directory)).toEqual(live);

    const first = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs, limit: 1 });
    expect(first).toMatchObject({ coverage: 'durable_journal', totalFills: 2 });
    expect(first.fills).toMatchObject([{ id: 'hyperliquid-fill-1', venue: 'Hyperliquid',
      market: 'HYPE', kind: 'entry', price: '100', fee: '0.1' }]);
    expect(first.nextFillsCursor).toBeTruthy();
    const second = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs,
      limit: 1, fillsCursor: first.nextFillsCursor! });
    expect(second.fills).toMatchObject([{ id: 'lighter-fill-1', venue: 'Lighter' }]);
    expect(second.nextFillsCursor).toBeNull();
    expect(first.events.some((event) => event.kind === 'fill')).toBe(true);
    expect(first.events.some((event) => event.kind === 'created')).toBe(true);
  });

  it('rejects missing or foreign sequence and malformed sidecar facts before committing', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    expect(() => ledger.append(fill(detail.id, 2, 'Lighter', 'missing-1'))).toThrow(/sequence/);
    expect(() => ledger.append(fill(randomUUID(), 1, 'Lighter', 'foreign-1'))).toThrow(/run ID/);
    expect(() => ledger.append({ ...envelope(detail.id, 1), type: 'snapshot',
      stage: 'running', accounts: [accounts()[0]] })).toThrow();
    expect(() => ledger.append({ ...fill(detail.id, 1, 'Lighter', 'bad-side'), side: 'sell' })).toThrow(/side/);
    ledger.append(fill(detail.id, 1, 'Lighter', 'valid-1'));
    expect(() => ledger.append(fill(detail.id, 2, 'Hyperliquid', 'valid-1'))).toThrow();
    ledger.append(fill(detail.id, 2, 'Hyperliquid', 'valid-2'));
    ledger.close();
    const activity = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(activity).toMatchObject({ coverage: 'durable_journal', totalFills: 2 });
  });

  it('keeps technical stop and hourly refresh reasons in the journal but hides them from activity', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    const stopReason = 'Nautilus process exited unexpectedly (code null, signal SIGKILL).';
    const refreshReason = 'Hourly data refresh failed: upstream DNS lookup timed out';
    ledger.append({ ...envelope(detail.id, 1), type: 'event', message: refreshReason });
    ledger.append({ ...envelope(detail.id, 2), type: 'phase', stage: 'stopping', message: stopReason });
    ledger.close();

    const activity = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs });
    expect(activity.events.map((event) => event.message)).toContain('Stopping both virtual accounts.');
    expect(activity.events.map((event) => event.message)).toContain('Waiting to verify the next closed hour.');
    expect(activity.events.some((event) => event.message.includes('SIGKILL') || event.message.includes('DNS'))).toBe(false);

    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'));
    const rows = db.prepare('SELECT payload_json FROM nautilus_records ORDER BY seq').all() as { payload_json: string }[];
    db.close();
    expect(rows.map((row) => JSON.parse(row.payload_json).message)).toEqual([refreshReason, stopReason]);
  });

  it('never presents foreign or corrupt records as zero trades', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append(fill(detail.id, 1, 'Lighter', 'fill-1'));
    ledger.close();
    const foreign = { ...detail, sourceSha256: '0'.repeat(64) };
    expect(readPaperExperimentActivityV1({ detail: foreign, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'partial', totalFills: null, fills: [] });
    expect(() => readNautilusPaperSnapshot(foreign, directory)).toThrow(/another launch/);

    const db = new DatabaseSync(path.join(directory, 'nautilus.sqlite'));
    db.prepare("UPDATE nautilus_records SET payload_json = '{}' WHERE seq = 1").run();
    db.close();
    expect(readPaperExperimentActivityV1({ detail, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'partial', totalFills: null, fills: [] });
  });

  it('rejects another run cursor at the HTTP reader boundary', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append(fill(detail.id, 1, 'Lighter', 'fill-1'));
    ledger.append(fill(detail.id, 2, 'Hyperliquid', 'fill-2'));
    ledger.close();
    const first = readPaperExperimentActivityV1({ detail, runtimeDirectory: runs, limit: 1 });
    const cursor = JSON.parse(Buffer.from(first.nextFillsCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    cursor.id = randomUUID();
    const foreign = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
    expect(() => readPaperExperimentActivityV1({ detail, runtimeDirectory: runs,
      limit: 1, fillsCursor: foreign })).toThrow(/Invalid fills cursor/);
  });

  it('recovers a fsynced child fill tail after proven process death without duplicating earlier fills', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const firstChild = fill(detail.id, 1, 'Lighter', 'child-fill-1');
    const secondChild = fill(detail.id, 2, 'Hyperliquid', 'child-fill-2');
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append({ ...firstChild, sourceSeq: 1 });
    ledger.append({ ...envelope(detail.id, 2), type: 'phase', stage: 'stopping', message: 'API owner stopped.' });
    ledger.close();
    outbox(directory, [firstChild, secondChild]);
    childFiles(directory, detail.id, 2_147_483_647);
    const terminal = { ...detail, status: 'interrupted' as const };
    expect(reconcileNautilusPaperOutbox(terminal, directory)).toEqual({ recovered: 1 });
    expect(reconcileNautilusPaperOutbox(terminal, directory)).toEqual({ recovered: 0 });
    const result = readPaperExperimentActivityV1({ detail: terminal, runtimeDirectory: runs });
    expect(result).toMatchObject({ coverage: 'durable_journal', totalFills: 2 });
    expect(result.fills.map((row) => row.id)).toEqual(['child-fill-2', 'child-fill-1']);
    expect(result.events.some((event) => event.message.includes('Recovered 1 durable Nautilus event'))).toBe(true);
  });

  it('reads the ledger snapshot for lists without replaying the outbox; the full read replays it', () => {
    const { directory, detail, snapshot } = fixture();
    const first = { ...envelope(detail.id, 1), type: 'snapshot', stage: 'running', accounts: accounts() };
    const second = { ...envelope(detail.id, 2), type: 'snapshot', stage: 'stopping',
      accounts: accounts().map((account) => ({ ...account, cashBalance: '4990' })) };
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append({ ...first, sourceSeq: 1 });
    const inLedger = ledger.snapshot()!;
    ledger.close();
    outbox(directory, [first, second]);
    childFiles(directory, detail.id, 2_147_483_647);
    const terminal = { ...detail, status: 'interrupted' as const };
    expect(readNautilusPaperLedgerSnapshot(terminal, directory)).toEqual(inLedger);
    expect(readNautilusPaperLedgerSnapshot(terminal, directory)).toEqual(inLedger);
    expect(readNautilusPaperSnapshot(terminal, directory)!.accounts.map((account) => account.cashBalance))
      .toEqual(['4990', '4990']);
    expect(readNautilusPaperLedgerSnapshot(terminal, directory)!.stage).toBe('stopping');
  });

  it('does not recover while the child may still be running', () => {
    const { directory, runs, detail, snapshot } = fixture();
    new NautilusPaperLedger(directory, snapshot).close();
    outbox(directory, [fill(detail.id, 1, 'Lighter', 'live-fill')]);
    childFiles(directory, detail.id, process.pid);
    const terminal = { ...detail, status: 'interrupted' as const };
    expect(() => reconcileNautilusPaperOutbox(terminal, directory)).toThrow(/still be running/);
    expect(readPaperExperimentActivityV1({ detail: terminal, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'partial', totalFills: null, fills: [] });
  });

  it('treats a stopped warmup with no spawned child as an empty, bound ledger', () => {
    const { directory, runs, detail, snapshot } = fixture();
    const ledger = new NautilusPaperLedger(directory, snapshot);
    ledger.append({ ...envelope(detail.id, 1), type: 'phase', stage: 'warming_up', message: 'Loading history.' });
    ledger.close();
    writeFileSync(path.join(directory, 'nautilus-owner.json'), JSON.stringify({
      experimentId: detail.id, parentPid: process.pid, childPid: null, exited: false,
    }));
    const terminal = { ...detail, status: 'interrupted' as const };
    expect(reconcileNautilusPaperOutbox(terminal, directory)).toEqual({ recovered: 0 });
    expect(readPaperExperimentActivityV1({ detail: terminal, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'durable_journal', totalFills: 0, fills: [] });
  });

  it('rejects an out-of-order or incomplete child outbox without appending a guessed trade', () => {
    const { directory, runs, detail, snapshot } = fixture();
    new NautilusPaperLedger(directory, snapshot).close();
    childFiles(directory, detail.id, 2_147_483_647);
    const terminal = { ...detail, status: 'interrupted' as const };
    outbox(directory, [fill(detail.id, 1, 'Lighter', 'fill-1'),
      fill(detail.id, 3, 'Hyperliquid', 'fill-3')]);
    expect(() => reconcileNautilusPaperOutbox(terminal, directory)).toThrow(/sequence/);
    outbox(directory, [fill(detail.id, 1, 'Lighter', 'fill-1')], false);
    expect(() => reconcileNautilusPaperOutbox(terminal, directory)).toThrow(/incomplete trailing/);
    expect(readPaperExperimentActivityV1({ detail: terminal, runtimeDirectory: runs }))
      .toMatchObject({ coverage: 'partial', totalFills: null, fills: [] });
  });
});
