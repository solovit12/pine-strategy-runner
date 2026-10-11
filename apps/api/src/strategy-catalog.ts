import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizedBacktestSettings,
  PaperStrategySettingsSchema,
  StrategyCatalogMetadataSchema,
  type CreateStrategyInput,
  type SaveStrategyVersionInput,
  type StrategyDetail,
  type StrategySummary,
  type StrategyVersion,
} from '../../../packages/shared/src/strategy-catalog-contracts.js';

const MAX_STRATEGIES = 100;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class StrategyCatalogError extends Error {
  constructor(readonly kind: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'CATALOG_LIMIT' | 'INVALID_CATALOG' | 'NAME_TAKEN', message: string) {
    super(message);
    this.name = 'StrategyCatalogError';
  }
}

type SummaryRow = {
  id: string;
  name: string;
  current_version: number;
  source_sha256: string;
  created_at: string;
  updated_at: string;
};

type VersionRow = {
  strategy_id: string;
  version: number;
  name: string;
  source: string;
  source_sha256: string;
  backtest_json: string;
  paper_json: string;
  metadata_json: string;
  created_at: string;
};

function summaryFromRow(row: SummaryRow): StrategySummary {
  return {
    id: row.id,
    name: row.name,
    currentVersion: row.current_version,
    sourceSha256: row.source_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionFromRow(row: VersionRow): StrategyVersion {
  if (sha256(row.source) !== row.source_sha256) {
    throw new StrategyCatalogError('INVALID_CATALOG', 'Stored Pine source hash does not match its content.');
  }
  try {
    const rawBacktest = JSON.parse(row.backtest_json) as Record<string, unknown>;
    const backtestSettings = normalizedBacktestSettings(rawBacktest, row.source);
    const paperSettings = PaperStrategySettingsSchema.parse(JSON.parse(row.paper_json));
    const metadata = StrategyCatalogMetadataSchema.parse(JSON.parse(row.metadata_json));
    return {
      strategyId: row.strategy_id,
      version: row.version,
      name: row.name,
      source: row.source,
      sourceSha256: row.source_sha256,
      backtestSettings,
      paperSettings,
      metadata,
      createdAt: row.created_at,
    };
  } catch (error) {
    throw new StrategyCatalogError('INVALID_CATALOG', `Stored strategy settings are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class StrategyCatalogV1 {
  readonly databasePath: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(directory: string, now: () => number = Date.now) {
    if (!directory.trim()) throw new TypeError('Strategy catalog directory must be non-empty.');
    const resolvedDirectory = path.resolve(directory);
    mkdirSync(resolvedDirectory, { recursive: true, mode: 0o700 });
    this.databasePath = path.join(resolvedDirectory, 'catalog.sqlite');
    if (existsSync(this.databasePath) && lstatSync(this.databasePath).isSymbolicLink()) {
      throw new StrategyCatalogError('INVALID_CATALOG', 'Strategy catalog database must not be a symlink.');
    }
    this.#now = now;
    this.#db = new DatabaseSync(this.databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const existingTables = this.#db.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;
      if (existingTables.length === 0) {
        this.#db.exec('BEGIN IMMEDIATE;');
        try {
          this.#db.exec(`
            CREATE TABLE strategy_catalog_identity (
              identity TEXT PRIMARY KEY CHECK (identity = 'pine-strategy-catalog-v1'),
              schema_version INTEGER NOT NULL CHECK (schema_version = 1)
            );
            CREATE TABLE strategies (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              current_version INTEGER NOT NULL CHECK (current_version > 0),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE strategy_versions (
              strategy_id TEXT NOT NULL REFERENCES strategies(id),
              version INTEGER NOT NULL CHECK (version > 0),
              name TEXT NOT NULL,
              source TEXT NOT NULL,
              source_sha256 TEXT NOT NULL,
              backtest_json TEXT NOT NULL,
              paper_json TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (strategy_id, version)
            );
          `);
          this.#db.prepare(`INSERT INTO strategy_catalog_identity(identity, schema_version) VALUES ('pine-strategy-catalog-v1', 1)`).run();
          this.#db.exec('COMMIT;');
        } catch (error) {
          this.#db.exec('ROLLBACK;');
          throw error;
        }
      } else {
        const names = new Set(existingTables.map((row) => row.name));
        const expected = new Set(['strategy_catalog_identity', 'strategies', 'strategy_versions']);
        if (names.size !== expected.size || [...names].some((name) => !expected.has(name))) {
          throw new StrategyCatalogError('INVALID_CATALOG', 'Refusing to modify an unrelated or incomplete SQLite database.');
        }
      }
      const identity = this.#db.prepare('SELECT schema_version FROM strategy_catalog_identity WHERE identity = ?')
        .get('pine-strategy-catalog-v1') as { schema_version: number } | undefined;
      if (identity?.schema_version !== 1) {
        throw new StrategyCatalogError('INVALID_CATALOG', 'Unsupported strategy catalog schema.');
      }
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  list(): StrategySummary[] {
    const rows = this.#db.prepare(`
      SELECT s.id, s.name, s.current_version, v.source_sha256, s.created_at, s.updated_at
      FROM strategies s
      JOIN strategy_versions v ON v.strategy_id = s.id AND v.version = s.current_version
      ORDER BY s.updated_at DESC, s.id
    `).all() as SummaryRow[];
    return rows.map(summaryFromRow);
  }

  get(id: string, version?: number): StrategyDetail | null {
    if (!ID_PATTERN.test(id)) return null;
    const summaryRow = this.#db.prepare(`
      SELECT s.id, s.name, s.current_version, v.source_sha256, s.created_at, s.updated_at
      FROM strategies s
      JOIN strategy_versions v ON v.strategy_id = s.id AND v.version = s.current_version
      WHERE s.id = ?
    `).get(id) as SummaryRow | undefined;
    if (!summaryRow) return null;
    const selectedVersion = version ?? summaryRow.current_version;
    if (!Number.isSafeInteger(selectedVersion) || selectedVersion <= 0) return null;
    const versionRow = this.#db.prepare(`
      SELECT strategy_id, version, name, source, source_sha256,
             backtest_json, paper_json, metadata_json, created_at
      FROM strategy_versions WHERE strategy_id = ? AND version = ?
    `).get(id, selectedVersion) as VersionRow | undefined;
    if (!versionRow) return null;
    return { strategy: summaryFromRow(summaryRow), version: versionFromRow(versionRow) };
  }

  listVersions(id: string): Array<Pick<StrategyVersion, 'strategyId' | 'version' | 'name' | 'sourceSha256' | 'createdAt'>> | null {
    if (!ID_PATTERN.test(id) || !this.get(id)) return null;
    const rows = this.#db.prepare(`
      SELECT strategy_id, version, name, source_sha256, created_at
      FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC
    `).all(id) as Array<{ strategy_id: string; version: number; name: string; source_sha256: string; created_at: string }>;
    return rows.map((row) => ({
      strategyId: row.strategy_id,
      version: row.version,
      name: row.name,
      sourceSha256: row.source_sha256,
      createdAt: row.created_at,
    }));
  }

  create(input: CreateStrategyInput): StrategyDetail {
    const id = randomUUID();
    const timestamp = new Date(this.#now()).toISOString();
    const backtest = normalizedBacktestSettings(input.backtestSettings, input.source);
    const sourceHash = sha256(input.source);
    this.#transaction(() => {
      const count = this.#db.prepare('SELECT COUNT(*) AS count FROM strategies').get() as { count: number };
      if (count.count >= MAX_STRATEGIES) {
        throw new StrategyCatalogError('CATALOG_LIMIT', `Strategy catalog is limited to ${MAX_STRATEGIES} strategies.`);
      }
      this.#assertNameFree(input.name, null);
      this.#db.prepare(`
        INSERT INTO strategies(id, name, current_version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(id, input.name, timestamp, timestamp);
      this.#insertVersion(id, 1, input, backtest, sourceHash, timestamp);
    });
    return this.get(id)!;
  }

  saveVersion(id: string, input: SaveStrategyVersionInput): StrategyDetail {
    if (!ID_PATTERN.test(id)) throw new StrategyCatalogError('NOT_FOUND', 'Strategy not found.');
    const timestamp = new Date(this.#now()).toISOString();
    const backtest = normalizedBacktestSettings(input.backtestSettings, input.source);
    const sourceHash = sha256(input.source);
    this.#transaction(() => {
      const current = this.#db.prepare('SELECT current_version FROM strategies WHERE id = ?').get(id) as { current_version: number } | undefined;
      if (!current) throw new StrategyCatalogError('NOT_FOUND', 'Strategy not found.');
      if (current.current_version !== input.expectedVersion) {
        throw new StrategyCatalogError('VERSION_CONFLICT', `Strategy has version ${current.current_version}; reload it before saving.`);
      }
      this.#assertNameFree(input.name, id);
      // Saving replaces the strategy: the version number only detects a stale editor.
      // Paper runs keep their own copy of what they launched, so older rows are dropped.
      const nextVersion = current.current_version + 1;
      this.#insertVersion(id, nextVersion, input, backtest, sourceHash, timestamp);
      this.#db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ? AND version < ?').run(id, nextVersion);
      this.#db.prepare('UPDATE strategies SET name = ?, current_version = ?, updated_at = ? WHERE id = ?')
        .run(input.name, nextVersion, timestamp, id);
    });
    return this.get(id)!;
  }

  /** Removes a strategy from the library. Paper runs already started keep their own copy. */
  delete(id: string): void {
    if (!ID_PATTERN.test(id)) throw new StrategyCatalogError('NOT_FOUND', 'Strategy not found.');
    this.#transaction(() => {
      const existing = this.#db.prepare('SELECT id FROM strategies WHERE id = ?').get(id);
      if (!existing) throw new StrategyCatalogError('NOT_FOUND', 'Strategy not found.');
      this.#db.prepare('DELETE FROM strategy_versions WHERE strategy_id = ?').run(id);
      this.#db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
    });
  }

  /** Names are unique in the library (ignoring case and surrounding spaces). */
  #assertNameFree(name: string, ownId: string | null): void {
    const clash = this.#db.prepare(`
      SELECT id FROM strategies WHERE lower(trim(name)) = lower(trim(?)) AND id IS NOT ?
    `).get(name, ownId);
    if (clash) throw new StrategyCatalogError('NAME_TAKEN', `A strategy named "${name.trim()}" already exists. Choose another name.`);
  }

  #insertVersion(
    id: string,
    version: number,
    input: CreateStrategyInput,
    backtest: ReturnType<typeof normalizedBacktestSettings>,
    sourceHash: string,
    timestamp: string,
  ): void {
    this.#db.prepare(`
      INSERT INTO strategy_versions(
        strategy_id, version, name, source, source_sha256,
        backtest_json, paper_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      version,
      input.name,
      input.source,
      sourceHash,
      JSON.stringify(backtest),
      JSON.stringify(input.paperSettings),
      JSON.stringify(input.metadata ?? {}),
      timestamp,
    );
  }

  #transaction(operation: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      operation();
      this.#db.exec('COMMIT;');
    } catch (error) {
      this.#db.exec('ROLLBACK;');
      throw error;
    }
  }
}
