import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  LIVE_ALREADY_ACTIVE_MESSAGE,
  MAX_CONCURRENT_PAPER_EXPERIMENTS,
  type PaperExperimentDetail,
  type PaperExperimentAccount,
  type PaperExperimentStatus,
  type PaperExperimentSummary,
  type PaperExperimentTrack,
  type StartPaperExperimentRequest,
} from '../../../../packages/shared/src/paper-experiment-contracts.js';
import {
  PaperStrategySettingsSchema,
  type PaperStrategySettings,
} from '../../../../packages/shared/src/strategy-catalog-contracts.js';

const ACTIVE_STATUSES = [
  'preparing', 'waiting_for_data', 'warming_up', 'running', 'recovering', 'stopping',
] as const;
const TERMINAL_STATUSES = new Set<PaperExperimentStatus>(['completed', 'interrupted']);
const MAX_EXPERIMENT_HISTORY = 1_000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ExperimentRow = {
  id: string;
  idempotency_key: string;
  request_sha256: string;
  strategy_id: string;
  strategy_version: number;
  strategy_name: string;
  source: string;
  source_sha256: string;
  settings_json: string;
  status: PaperExperimentStatus;
  reason: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  track_count: number;
  owner_pid: number;
  owner_host: string;
};

type TrackRow = {
  run_id: string;
  venue: PaperExperimentTrack['venue'];
  market: PaperExperimentTrack['market'];
  status: PaperExperimentStatus;
  reason: string | null;
  updated_at: string;
  events: number;
  signals: number;
  intents: number;
  fills: number;
};

export interface PaperExperimentSnapshot {
  readonly experimentId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly strategyName: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly settings: StartPaperExperimentRequest['settings'];
  readonly accounts: readonly PaperExperimentAccount[];
  readonly tracks: readonly Pick<PaperExperimentTrack, 'trackId' | 'accountId' | 'runId' | 'venue' | 'market'>[];
  readonly createdAt: string;
}

export type PaperExperimentStoreErrorKind =
  | 'INVALID_STORE'
  | 'EXPERIMENT_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'NOT_FOUND';

export class PaperExperimentStoreError extends Error {
  constructor(readonly kind: PaperExperimentStoreErrorKind, message: string) {
    super(message);
    this.name = 'PaperExperimentStoreError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function summary(row: ExperimentRow, settings: PaperStrategySettings = readSettings(row)): PaperExperimentSummary {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    strategyName: row.strategy_name,
    sourceSha256: row.source_sha256,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    trackCount: row.track_count,
    venues: [...new Set(settings.tracks.map((track) => track.venue))],
    markets: [...new Set(settings.tracks.map((track) => track.market))],
    timeframe: settings.timeframe,
    capitalPerVenue: 'capitalPerVenue' in settings ? settings.capitalPerVenue : null,
    ...('live' in settings && settings.live ? { live: true } : {}),
  };
}

function readSettings(row: ExperimentRow): PaperStrategySettings {
  if (sha256(row.source) !== row.source_sha256) {
    throw new PaperExperimentStoreError('INVALID_STORE', 'Pinned Pine source hash does not match the stored source.');
  }
  try {
    const settings = PaperStrategySettingsSchema.parse(JSON.parse(row.settings_json));
    const pinnedRequest = {
      strategyId: row.strategy_id,
      version: row.strategy_version,
      sourceSha256: row.source_sha256,
      settings,
      idempotencyKey: row.idempotency_key,
    };
    if (sha256(JSON.stringify(pinnedRequest)) !== row.request_sha256) {
      throw new PaperExperimentStoreError('INVALID_STORE', 'Pinned Paper settings differ from the admitted launch request.');
    }
    return settings;
  } catch (error) {
    if (error instanceof PaperExperimentStoreError) throw error;
    throw new PaperExperimentStoreError('INVALID_STORE', `Stored Paper settings are invalid: ${String(error)}`);
  }
}

function accountFor(experimentId: string, venue: PaperExperimentAccount['venue'], startingCash: number): PaperExperimentAccount {
  const suffix = venue.toLowerCase();
  return {
    venue,
    accountId: `paper-account:${experimentId}:${suffix}`,
    runId: `paper-run:${experimentId}:${suffix}`,
    currency: 'USDC',
    startingCash,
  };
}

/** Durable experiment metadata only. Broker SQLite remains the order/fill authority. */
export class PaperExperimentStoreV1 {
  readonly databasePath: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(directory: string, now: () => number = Date.now) {
    if (!directory.trim()) throw new TypeError('Paper experiment directory must be non-empty.');
    const resolved = path.resolve(directory);
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    this.databasePath = path.join(resolved, 'experiments.sqlite');
    if (existsSync(this.databasePath) && lstatSync(this.databasePath).isSymbolicLink()) {
      throw new PaperExperimentStoreError('INVALID_STORE', 'Paper experiment database must not be a symlink.');
    }
    this.#now = now;
    this.#db = new DatabaseSync(this.databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const tables = this.#db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      if (tables.length === 0) {
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
          this.#db.exec(`
            CREATE TABLE paper_experiment_identity (
              identity TEXT PRIMARY KEY CHECK (identity = 'paper-experiment-control-v1'),
              schema_version INTEGER NOT NULL CHECK (schema_version = 1)
            );
            CREATE TABLE paper_experiments (
              id TEXT PRIMARY KEY,
              idempotency_key TEXT NOT NULL UNIQUE,
              request_sha256 TEXT NOT NULL,
              strategy_id TEXT NOT NULL,
              strategy_version INTEGER NOT NULL,
              strategy_name TEXT NOT NULL,
              source TEXT NOT NULL,
              source_sha256 TEXT NOT NULL,
              settings_json TEXT NOT NULL,
              status TEXT NOT NULL,
              reason TEXT,
              created_at TEXT NOT NULL,
              started_at TEXT,
              ended_at TEXT,
              track_count INTEGER NOT NULL,
              owner_pid INTEGER NOT NULL,
              owner_host TEXT NOT NULL
            );
            CREATE TABLE paper_experiment_tracks (
              run_id TEXT PRIMARY KEY,
              experiment_id TEXT NOT NULL REFERENCES paper_experiments(id),
              venue TEXT NOT NULL,
              market TEXT NOT NULL,
              status TEXT NOT NULL,
              reason TEXT,
              updated_at TEXT NOT NULL,
              events INTEGER NOT NULL DEFAULT 0,
              signals INTEGER NOT NULL DEFAULT 0,
              intents INTEGER NOT NULL DEFAULT 0,
              fills INTEGER NOT NULL DEFAULT 0,
              UNIQUE(experiment_id, venue, market)
            );
            INSERT INTO paper_experiment_identity(identity, schema_version)
              VALUES ('paper-experiment-control-v1', 1);
          `);
          this.#db.exec('COMMIT;');
        } catch (error) {
          this.#db.exec('ROLLBACK;');
          throw error;
        }
      } else {
        const expected = new Set(['paper_experiment_identity', 'paper_experiments', 'paper_experiment_tracks']);
        if (tables.length !== expected.size || tables.some(({ name }) => !expected.has(name))) {
          throw new PaperExperimentStoreError('INVALID_STORE', 'Refusing an unrelated or incomplete Paper experiment database.');
        }
      }
      const identity = this.#db.prepare("SELECT schema_version FROM paper_experiment_identity WHERE identity = 'paper-experiment-control-v1'")
        .get() as { schema_version: number } | undefined;
      if (identity?.schema_version !== 1) {
        throw new PaperExperimentStoreError('INVALID_STORE', 'Unsupported Paper experiment schema.');
      }
      // Older stores allowed one active experiment via an index; the limit is
      // now MAX_CONCURRENT_PAPER_EXPERIMENTS, checked inside reserve()'s transaction.
      this.#db.exec('DROP INDEX IF EXISTS paper_one_active_experiment;');
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void { this.#db.close(); }

  list(): PaperExperimentSummary[] {
    const rows = this.#db.prepare('SELECT * FROM paper_experiments ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(MAX_EXPERIMENT_HISTORY) as ExperimentRow[];
    return rows.map((row) => summary(row));
  }

  activeExperimentId(): string | null {
    const active = this.#db.prepare(`SELECT id FROM paper_experiments
      WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`)
      .get(...ACTIVE_STATUSES) as { id: string } | undefined;
    return active?.id ?? null;
  }

  /** The active run that trades real money, if any: one at a time (one Lighter account and API key). */
  activeLiveExperimentId(): string | null {
    const rows = this.#db.prepare(`SELECT id, settings_json FROM paper_experiments
      WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
      .all(...ACTIVE_STATUSES) as Array<{ id: string; settings_json: string }>;
    return rows.find((row) => {
      try {
        return Boolean((JSON.parse(row.settings_json) as { live?: unknown }).live);
      } catch {
        return false;
      }
    })?.id ?? null;
  }

  activeExperimentCount(): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM paper_experiments
      WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
      .get(...ACTIVE_STATUSES) as { count: number };
    return row.count;
  }

  get(id: string): PaperExperimentDetail | null {
    if (!ID_PATTERN.test(id)) return null;
    const row = this.#db.prepare('SELECT * FROM paper_experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
    if (!row) return null;
    const settings = readSettings(row);
    const tracks = this.#db.prepare('SELECT run_id, venue, market, status, reason, updated_at, events, signals, intents, fills FROM paper_experiment_tracks WHERE experiment_id = ? ORDER BY rowid')
      .all(id) as TrackRow[];
    if (tracks.length !== row.track_count || tracks.length !== settings.tracks.length) {
      throw new PaperExperimentStoreError('INVALID_STORE', 'Paper experiment track count is inconsistent.');
    }
    for (const [index, track] of tracks.entries()) {
      const configured = settings.tracks[index];
      if (!configured || track.venue !== configured.venue || track.market !== configured.market) {
        throw new PaperExperimentStoreError('INVALID_STORE', 'Paper experiment tracks differ from the pinned launch settings.');
      }
    }
    const shared = 'accountModel' in settings
      && (settings.accountModel === 'venue_shared_v1' || settings.accountModel === 'venue_shared_v2'
        || settings.accountModel === 'pine_live_v1' || settings.accountModel === 'python_live_v1');
    const accounts: PaperExperimentAccount[] = shared
      ? [
          accountFor(row.id, 'Hyperliquid', settings.capitalPerVenue),
          accountFor(row.id, 'Lighter', settings.capitalPerVenue),
        ]
      : tracks.map((track) => ({
          venue: track.venue,
          accountId: `legacy-paper-account:${row.id}:${track.run_id}`,
          runId: track.run_id,
          currency: 'USDC',
          startingCash: 'capitalPerTrack' in settings
            ? settings.capitalPerTrack
            : (() => { throw new PaperExperimentStoreError('INVALID_STORE', 'Legacy Paper capital is missing.'); })(),
        }));
    return {
      ...summary(row, settings),
      accountModel: shared ? settings.accountModel as 'venue_shared_v1' | 'venue_shared_v2' | 'pine_live_v1' | 'python_live_v1' : 'legacy_per_track',
      settings,
      accounts,
      tracks: tracks.map((track) => ({
        trackId: track.run_id, // v1 SQLite column predates the explicit shared-account model.
        accountId: (shared
          ? accounts.find((account) => account.venue === track.venue)
          : accounts.find((account) => account.runId === track.run_id))!.accountId,
        runId: (shared
          ? accounts.find((account) => account.venue === track.venue)
          : accounts.find((account) => account.runId === track.run_id))!.runId,
        venue: track.venue,
        market: track.market,
        status: track.status,
        reason: track.reason,
        updatedAt: track.updated_at,
        events: track.events,
        signals: track.signals,
        intents: track.intents,
        fills: track.fills,
      })),
    };
  }

  snapshot(id: string): PaperExperimentSnapshot | null {
    const row = this.#db.prepare('SELECT * FROM paper_experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
    if (!row) return null;
    const detail = this.get(id)!;
    if (detail.accountModel !== 'venue_shared_v2' && detail.accountModel !== 'pine_live_v1' && detail.accountModel !== 'python_live_v1') {
      throw new PaperExperimentStoreError('INVALID_STORE', 'Only fee-split venue-shared V2 or Pine live experiments can supply a new runtime snapshot.');
    }
    return {
      experimentId: row.id,
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      strategyName: row.strategy_name,
      source: row.source,
      sourceSha256: row.source_sha256,
      settings: detail.settings as StartPaperExperimentRequest['settings'],
      accounts: detail.accounts,
      tracks: detail.tracks.map(({ trackId, accountId, runId, venue, market }) => ({ trackId, accountId, runId, venue, market })),
      createdAt: row.created_at,
    };
  }

  findByIdempotency(request: StartPaperExperimentRequest): PaperExperimentDetail | null {
    const prior = this.#db.prepare('SELECT id, request_sha256 FROM paper_experiments WHERE idempotency_key = ?')
      .get(request.idempotencyKey) as { id: string; request_sha256: string } | undefined;
    if (!prior) return null;
    if (prior.request_sha256 !== sha256(JSON.stringify(request))) {
      throw new PaperExperimentStoreError('IDEMPOTENCY_CONFLICT', 'This launch key was already used with different settings.');
    }
    return this.get(prior.id);
  }

  reserve(input: {
    readonly request: StartPaperExperimentRequest;
    readonly strategyName: string;
    readonly source: string;
  }): { readonly experiment: PaperExperimentDetail; readonly existing: boolean } {
    if (sha256(input.source) !== input.request.sourceSha256) {
      throw new PaperExperimentStoreError('INVALID_STORE', 'Cannot pin Pine source with a different hash.');
    }
    const requestSha256 = sha256(JSON.stringify(input.request));
    const timestamp = new Date(this.#now()).toISOString();
    let id: string | null = null;
    let existing = false;
    this.#transaction(() => {
      const prior = this.#db.prepare('SELECT id, request_sha256 FROM paper_experiments WHERE idempotency_key = ?')
        .get(input.request.idempotencyKey) as { id: string; request_sha256: string } | undefined;
      if (prior) {
        if (prior.request_sha256 !== requestSha256) {
          throw new PaperExperimentStoreError('IDEMPOTENCY_CONFLICT', 'This launch key was already used with different settings.');
        }
        id = prior.id;
        existing = true;
        return;
      }
      if (this.activeExperimentCount() >= MAX_CONCURRENT_PAPER_EXPERIMENTS) {
        throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', `${MAX_CONCURRENT_PAPER_EXPERIMENTS} Paper experiments are already active.`);
      }
      // Checked inside the same transaction, so two simultaneous Live launches cannot both pass.
      if ('live' in input.request.settings && input.request.settings.live && this.activeLiveExperimentId()) {
        throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', LIVE_ALREADY_ACTIVE_MESSAGE);
      }
      const count = this.#db.prepare('SELECT COUNT(*) AS count FROM paper_experiments').get() as { count: number };
      if (count.count >= MAX_EXPERIMENT_HISTORY) {
        throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', 'Paper experiment history is full; an operator must review retention before further launches.');
      }
      id = randomUUID();
      this.#db.prepare(`INSERT INTO paper_experiments
        (id,idempotency_key,request_sha256,strategy_id,strategy_version,strategy_name,source,source_sha256,
         settings_json,status,reason,created_at,started_at,ended_at,track_count,owner_pid,owner_host)
        VALUES (?,?,?,?,?,?,?,?,?,'preparing',NULL,?,NULL,NULL,?,?,?)`)
        .run(
          id, input.request.idempotencyKey, requestSha256, input.request.strategyId,
          input.request.version, input.strategyName, input.source, input.request.sourceSha256,
          JSON.stringify(input.request.settings), timestamp, input.request.settings.tracks.length,
          process.pid, hostname(),
        );
      const insertTrack = this.#db.prepare(`INSERT INTO paper_experiment_tracks
        (run_id,experiment_id,venue,market,status,reason,updated_at)
        VALUES (?,?,?,?,'preparing',NULL,?)`);
      for (const track of input.request.settings.tracks) {
        insertTrack.run(randomUUID(), id, track.venue, track.market, timestamp);
      }
    });
    return { experiment: this.get(id!)!, existing };
  }

  setStatus(id: string, status: PaperExperimentStatus, reason: string | null = null): PaperExperimentDetail {
    const current = this.get(id);
    if (!current) throw new PaperExperimentStoreError('NOT_FOUND', 'Paper experiment not found.');
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const timestamp = new Date(this.#now()).toISOString();
    this.#transaction(() => {
      this.#db.prepare(`UPDATE paper_experiments SET status = ?, reason = ?,
        started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
        ended_at = CASE WHEN ? IN ('completed','interrupted') THEN ? ELSE ended_at END
        WHERE id = ?`).run(status, reason, status, timestamp, status, timestamp, id);
      if (status === 'waiting_for_data') {
        this.#db.prepare(`UPDATE paper_experiment_tracks SET status = 'waiting_for_data', updated_at = ?
          WHERE experiment_id = ? AND status = 'preparing'`).run(timestamp, id);
      } else if (TERMINAL_STATUSES.has(status)) {
        this.#db.prepare(`UPDATE paper_experiment_tracks SET status = ?, reason = COALESCE(reason, ?), updated_at = ?
          WHERE experiment_id = ? AND status NOT IN ('completed','interrupted')`)
          .run(status, reason, timestamp, id);
      }
    });
    return this.get(id)!;
  }

  updateTrack(id: string, trackId: string, update: Partial<Pick<PaperExperimentTrack, 'status' | 'reason' | 'events' | 'signals' | 'intents' | 'fills'>>): PaperExperimentDetail {
    const experiment = this.get(id);
    if (!experiment) throw new PaperExperimentStoreError('NOT_FOUND', 'Paper experiment not found.');
    if (TERMINAL_STATUSES.has(experiment.status)) return experiment;
    const track = experiment.tracks.find((candidate) => candidate.trackId === trackId);
    if (!track) throw new PaperExperimentStoreError('NOT_FOUND', 'Paper track not found.');
    if (TERMINAL_STATUSES.has(track.status)) return experiment;
    for (const counter of ['events', 'signals', 'intents', 'fills'] as const) {
      const next = update[counter];
      if (next !== undefined && (!Number.isSafeInteger(next) || next < track[counter])) {
        throw new RangeError(`${counter} must be a non-decreasing non-negative integer.`);
      }
    }
    const timestamp = new Date(this.#now()).toISOString();
    this.#db.prepare(`UPDATE paper_experiment_tracks SET status=?,reason=?,updated_at=?,events=?,signals=?,intents=?,fills=?
      WHERE run_id=? AND experiment_id=?`).run(
        update.status ?? track.status, update.reason === undefined ? track.reason : update.reason,
        timestamp, update.events ?? track.events, update.signals ?? track.signals,
        update.intents ?? track.intents, update.fills ?? track.fills, trackId, id,
      );
    return this.get(id)!;
  }

  /** Called only after an unequivocal local-process death. */
  #interruptUnowned(reason: string): void {
    const timestamp = new Date(this.#now()).toISOString();
    this.#transaction(() => {
      this.#db.prepare(`UPDATE paper_experiment_tracks SET status='interrupted',
        reason=CASE WHEN reason IS NULL OR TRIM(reason) = '' THEN ? ELSE reason || ' ' || ? END,
        updated_at=?
        WHERE experiment_id IN (SELECT id FROM paper_experiments WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}))
        AND status NOT IN ('completed','interrupted')`).run(reason, reason, timestamp, ...ACTIVE_STATUSES);
      this.#db.prepare(`UPDATE paper_experiments SET status='interrupted',
        reason=CASE WHEN reason IS NULL OR TRIM(reason) = '' THEN ? ELSE reason || ' ' || ? END,
        ended_at=?
        WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`).run(reason, reason, timestamp, ...ACTIVE_STATUSES);
    });
  }

  /** A live owner is never silently displaced. A dead local owner is interrupted. */
  reconcileAfterRestart(): void {
    const active = this.#db.prepare(`SELECT owner_pid, owner_host FROM paper_experiments
      WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
      .all(...ACTIVE_STATUSES) as Pick<ExperimentRow, 'owner_pid' | 'owner_host'>[];
    if (!active.length) return;
    // Every active row must belong to a proven-dead local owner before any is interrupted.
    for (const row of active) {
      if (row.owner_host !== hostname() || row.owner_pid === process.pid) {
        throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', 'An active Paper experiment has an owner that cannot be safely displaced.');
      }
      try {
        process.kill(row.owner_pid, 0);
        throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', 'Another Paper controller process still owns an active experiment.');
      } catch (error) {
        if (error instanceof PaperExperimentStoreError) throw error;
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
          throw new PaperExperimentStoreError('EXPERIMENT_LIMIT', 'Cannot prove the previous Paper controller process has stopped.');
        }
      }
    }
    this.#interruptUnowned('Paper controller process ended; ambiguous market events cannot be replayed.');
  }

  #transaction(body: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE;');
    try { body(); this.#db.exec('COMMIT;'); }
    catch (error) { this.#db.exec('ROLLBACK;'); throw error; }
  }
}
