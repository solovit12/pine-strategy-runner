import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  CreateLiveAccountRequest, LiveAccountView, LiveAccountsView, LiveExchange, UpdateLiveAccountRequest,
} from '../../../packages/shared/src/paper-experiment-contracts.js';

/**
 * Live accounts (owner, 2026-10-20): each is one exchange account with its API key, kept on the
 * machine that runs the engine. A Live run picks one account per exchange; one account trades in one
 * run at a time (the run store checks it at launch).
 *
 * `<dir>/live.json` lists the accounts (names and public ids, never a key). A key saved from the
 * Accounts page is written once into `<dir>/accounts/<id>.env` (folders 0700, file 0600, the format
 * the engine reads) and is never returned by the API, written to a log or put into a run's config:
 * the run's config names the file and the engine reads it itself. A key the server operator placed
 * in a closed folder of its own (`/etc/psr-secrets/<exchange>-mainnet.env`) becomes an account on
 * first start and stays there.
 */
export const LIVE_SECRETS_FILE = 'lighter-mainnet.env';
/** Hyperliquid API (agent) wallet key and the main account it trades for; same rules as Lighter's file. */
export const HYPERLIQUID_SECRETS_FILE = 'hyperliquid-mainnet.env';
const LEGACY_FILES: Record<LiveExchange, string> = { lighter: LIVE_SECRETS_FILE, hyperliquid: HYPERLIQUID_SECRETS_FILE };
const SETTINGS_FILE = 'live.json';
const ACCOUNTS_DIR = 'accounts';
const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{40,200}$/;
/** An EVM private key: 32 bytes in hex. */
const HYPERLIQUID_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const EXCHANGE_NAMES: Record<LiveExchange, string> = { lighter: 'Lighter', hyperliquid: 'Hyperliquid' };

interface StoredAccount {
  readonly id: string;
  readonly name: string;
  readonly exchange: LiveExchange;
  readonly enabled: boolean;
  readonly accountIndex?: number;
  readonly apiKeyIndex?: number;
  readonly accountAddress?: string;
  /** 'server': the operator's file in the closed server folder (from before accounts existed). */
  readonly keySource: 'app' | 'server';
  /** Made from the single key of each exchange that existed before accounts. */
  readonly legacy?: boolean;
}

interface StoredFile {
  readonly version: 2;
  readonly accounts: readonly StoredAccount[];
}

/** What a run's engine needs to trade one account: never the key itself, only where it is. */
export interface LiveAccountForRun {
  readonly id: string;
  readonly name: string;
  readonly exchange: LiveExchange;
  readonly file: string;
}

export class LiveSettingsError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

function readEnv(file: string): Record<string, string> | null {
  try {
    return existsSync(file) ? parseEnvFile(file) : null;
  } catch {
    return null; // unreadable (e.g. a closed server folder)
  }
}

function lighterKey(key: string): string {
  if (!KEY_PATTERN.test(key)) {
    throw new LiveSettingsError('The API private key must be the hexadecimal key Lighter gave you (40 to 200 characters, 0x optional).');
  }
  return key;
}

function hyperliquidKey(key: string): string {
  if (!HYPERLIQUID_KEY_PATTERN.test(key)) {
    throw new LiveSettingsError('The API wallet private key must be the 64-character hexadecimal key Hyperliquid showed when you created the API wallet (0x optional).');
  }
  return key.startsWith('0x') ? key : `0x${key}`;
}

export class LiveSettingsStore {
  constructor(
    /** The app's own folder for Live accounts (in the data folder, next to the run history). */
    readonly directory: string,
    /** A server-managed closed folder with the operator's keys from before accounts existed. */
    readonly serverDirectory: string | null = '/etc/psr-secrets',
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Account id -> the active Live run trading it (from the run store). */
    private readonly busy: () => ReadonlyMap<string, string> = () => new Map(),
  ) {}

  /** The operator can switch Live off for the whole server (PSR_LIVE_DISABLED=1). */
  get disabledByServer(): boolean {
    return this.env.PSR_LIVE_DISABLED === '1';
  }

  #file(): string {
    return path.join(this.directory, SETTINGS_FILE);
  }

  #keyFile(account: StoredAccount): string {
    return account.keySource === 'server' && this.serverDirectory
      ? path.join(this.serverDirectory, LEGACY_FILES[account.exchange])
      : path.join(this.directory, ACCOUNTS_DIR, `${account.id}.env`);
  }

  /** The accounts, after turning the single key of each exchange from before accounts into one. */
  #accounts(): StoredAccount[] {
    let stored: unknown = null;
    try {
      if (existsSync(this.#file())) stored = JSON.parse(readFileSync(this.#file(), 'utf8'));
    } catch { /* unreadable: treated as the old format */ }
    if (stored && typeof stored === 'object' && (stored as { version?: unknown }).version === 2
      && Array.isArray((stored as StoredFile).accounts)) {
      return [...(stored as StoredFile).accounts];
    }
    return this.#migrate(stored as { enabled?: unknown; hyperliquid?: { enabled?: unknown } } | null);
  }

  #migrate(old: { enabled?: unknown; hyperliquid?: { enabled?: unknown } } | null): StoredAccount[] {
    const accounts: StoredAccount[] = [];
    const moves: Array<[string, StoredAccount]> = [];
    for (const exchange of ['lighter', 'hyperliquid'] as const) {
      const enabled = exchange === 'lighter'
        ? (old ? old.enabled === true : this.env.PSR_LIVE_ENABLED === '1')
        : old?.hyperliquid?.enabled === true;
      for (const [directory, keySource] of [[this.directory, 'app'], [this.serverDirectory, 'server']] as const) {
        if (!directory) continue;
        const file = path.join(directory, LEGACY_FILES[exchange]);
        const values = readEnv(file);
        if (!values) continue;
        const base = { id: randomUUID(), name: `${EXCHANGE_NAMES[exchange]} main`, exchange, enabled, keySource, legacy: true } as const;
        let account: StoredAccount | null = null;
        if (exchange === 'lighter') {
          const accountIndex = Number(values.LIGHTER_ACCOUNT_INDEX);
          const apiKeyIndex = Number(values.LIGHTER_API_KEY_INDEX);
          if (Number.isSafeInteger(accountIndex) && Number.isSafeInteger(apiKeyIndex) && values.LIGHTER_API_SECRET) {
            account = { ...base, accountIndex, apiKeyIndex };
          }
        } else if (/^0x[0-9a-fA-F]{40}$/.test(values.HYPERLIQUID_ACCOUNT_ADDRESS ?? '') && values.HYPERLIQUID_PK) {
          account = { ...base, accountAddress: values.HYPERLIQUID_ACCOUNT_ADDRESS!.toLowerCase() };
        }
        if (!account) continue;
        accounts.push(account);
        if (keySource === 'app') moves.push([file, account]);
        break;
      }
    }
    if (!existsSync(this.directory) && accounts.length === 0) return accounts; // nothing to keep yet
    this.#ensureDirectories();
    // The app's own key files move into the accounts folder unchanged (same format, same rights).
    for (const [file, account] of moves) {
      const target = this.#keyFile(account);
      writeFileSync(`${target}.tmp`, readFileSync(file), { mode: 0o600 });
      chmodSync(`${target}.tmp`, 0o600);
      renameSync(`${target}.tmp`, target);
    }
    this.#write(accounts);
    for (const [file] of moves) rmSync(file, { force: true });
    return accounts;
  }

  #ensureDirectories(): void {
    for (const directory of [this.directory, path.join(this.directory, ACCOUNTS_DIR)]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
  }

  #write(accounts: readonly StoredAccount[]): void {
    const file = this.#file();
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 2, accounts } satisfies StoredFile)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  #writeKey(account: StoredAccount, key: string): void {
    this.#ensureDirectories();
    const file = this.#keyFile(account);
    const lines = account.exchange === 'lighter'
      ? ['# Lighter API key for Live trading, written by Svit Runner. Keep this file private.',
        `LIGHTER_ACCOUNT_INDEX=${account.accountIndex}`, `LIGHTER_API_KEY_INDEX=${account.apiKeyIndex}`, `LIGHTER_API_SECRET=${key}`]
      : ['# Hyperliquid API wallet for Live trading, written by Svit Runner. Keep this file private.',
        `HYPERLIQUID_ACCOUNT_ADDRESS=${account.accountAddress}`, `HYPERLIQUID_PK=${key}`];
    writeFileSync(`${file}.tmp`, [...lines, ''].join('\n'), { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  }

  /** The saved key's values, or null (never leaves this class except as a check's environment). */
  #key(account: StoredAccount): Record<string, string> | null {
    const values = readEnv(this.#keyFile(account));
    if (!values) return null;
    return account.exchange === 'lighter'
      ? (values.LIGHTER_API_SECRET ? values : null)
      : (values.HYPERLIQUID_PK ? values : null);
  }

  #view(account: StoredAccount, busy: ReadonlyMap<string, string>): LiveAccountView {
    return {
      id: account.id, name: account.name, exchange: account.exchange, enabled: account.enabled,
      accountIndex: account.accountIndex ?? null, apiKeyIndex: account.apiKeyIndex ?? null,
      accountAddress: account.accountAddress ?? null,
      keySaved: this.#key(account) !== null, keySource: account.keySource, runId: busy.get(account.id) ?? null,
    };
  }

  view(): LiveAccountsView {
    const busy = this.busy();
    return { accounts: this.#accounts().map((account) => this.#view(account, busy)), disabledByServer: this.disabledByServer };
  }

  account(id: string): LiveAccountView | null {
    const found = this.#accounts().find((account) => account.id === id);
    return found ? this.#view(found, this.busy()) : null;
  }

  /** Exchanges Live can trade on: an account there with a key, switched on, and Live not switched off for the server. */
  liveExchanges(): LiveExchange[] {
    if (this.disabledByServer) return [];
    const usable = this.view().accounts.filter((account) => account.enabled && account.keySaved);
    return (['lighter', 'hyperliquid'] as const).filter((exchange) => usable.some((account) => account.exchange === exchange));
  }

  /** Live can be offered on at least one exchange. */
  liveTrading(): boolean {
    return this.liveExchanges().length > 0;
  }

  /** The made-from-old-key account of an exchange: what a Live run from before accounts trades. */
  legacyAccountId(exchange: LiveExchange): string | null {
    return this.#accounts().find((account) => account.exchange === exchange && account.legacy)?.id ?? null;
  }

  /**
   * The account a Live run trades on one exchange, checked for a launch: it exists, belongs to that
   * exchange, is switched on and has a key. (Whether another run trades it is checked by the run store.)
   */
  accountForRun(id: string | undefined, exchange: LiveExchange): LiveAccountForRun {
    const name = EXCHANGE_NAMES[exchange];
    if (this.disabledByServer) throw new LiveSettingsError('LIVE trading is switched off on this server by its operator.');
    if (!id) throw new LiveSettingsError(`Choose the ${name} account for this LIVE run (Accounts page).`);
    const account = this.#accounts().find((row) => row.id === id);
    if (!account) throw new LiveSettingsError(`The chosen ${name} account no longer exists. Choose another one.`);
    if (account.exchange !== exchange) throw new LiveSettingsError(`The account "${account.name}" is not a ${name} account.`);
    if (!account.enabled) throw new LiveSettingsError(`LIVE is switched off for the account "${account.name}" (Accounts page).`);
    if (!this.#key(account)) throw new LiveSettingsError(`The account "${account.name}" has no saved key (Accounts page).`);
    return { id: account.id, name: account.name, exchange, file: this.#keyFile(account) };
  }

  #refuseDuplicate(accounts: readonly StoredAccount[], candidate: StoredAccount): void {
    const lower = candidate.name.toLowerCase();
    if (accounts.some((account) => account.id !== candidate.id && account.name.toLowerCase() === lower)) {
      throw new LiveSettingsError(`An account named "${candidate.name}" already exists. Choose another name.`, 409);
    }
    const same = accounts.find((account) => account.id !== candidate.id && account.exchange === candidate.exchange
      && (candidate.exchange === 'lighter' ? account.accountIndex === candidate.accountIndex
        : account.accountAddress === candidate.accountAddress));
    if (same) {
      throw new LiveSettingsError(`This ${EXCHANGE_NAMES[candidate.exchange]} account is already added as "${same.name}": one exchange account can be added once, so two runs never trade it together.`, 409);
    }
  }

  create(request: CreateLiveAccountRequest): LiveAccountView {
    const accounts = this.#accounts();
    const key = request.apiKey.trim();
    if (!key) throw new LiveSettingsError(request.exchange === 'lighter' ? 'Enter the API private key.' : 'Enter the API wallet private key.');
    const base = { id: randomUUID(), name: request.name.trim(), exchange: request.exchange, enabled: request.enabled, keySource: 'app' } as const;
    const account: StoredAccount = request.exchange === 'lighter'
      ? { ...base, accountIndex: request.accountIndex, apiKeyIndex: request.apiKeyIndex }
      : { ...base, accountAddress: request.accountAddress.toLowerCase() };
    const secret = request.exchange === 'lighter' ? lighterKey(key) : hyperliquidKey(key);
    this.#refuseDuplicate(accounts, account);
    this.#writeKey(account, secret);
    this.#write([...accounts, account]);
    return this.#view(account, this.busy());
  }

  update(id: string, request: UpdateLiveAccountRequest): LiveAccountView {
    const accounts = this.#accounts();
    const at = accounts.findIndex((account) => account.id === id);
    if (at < 0) throw new LiveSettingsError('This account no longer exists.', 404);
    const current = accounts[at]!;
    const busyRun = this.busy().get(id);
    const onlyName = Object.keys(request).every((field) => field === 'name');
    if (busyRun && !onlyName) {
      throw new LiveSettingsError(`The account "${current.name}" is trading in a LIVE run; stop that run before changing its key or settings.`, 409);
    }
    if (current.exchange === 'lighter' && request.accountAddress !== undefined
      || current.exchange === 'hyperliquid' && (request.accountIndex !== undefined || request.apiKeyIndex !== undefined)) {
      throw new LiveSettingsError(`These fields do not belong to a ${EXCHANGE_NAMES[current.exchange]} account.`);
    }
    const identityChanged = request.accountIndex !== undefined && request.accountIndex !== current.accountIndex
      || request.apiKeyIndex !== undefined && request.apiKeyIndex !== current.apiKeyIndex
      || request.accountAddress !== undefined && request.accountAddress.toLowerCase() !== current.accountAddress;
    const key = request.apiKey?.trim() ?? '';
    if ((identityChanged || key) && current.keySource === 'server') {
      throw new LiveSettingsError('This account\'s key was set up by the server operator and can be changed only on the server. Add a new account instead.');
    }
    const next: StoredAccount = {
      ...current,
      ...(request.name !== undefined ? { name: request.name.trim() } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.accountIndex !== undefined ? { accountIndex: request.accountIndex } : {}),
      ...(request.apiKeyIndex !== undefined ? { apiKeyIndex: request.apiKeyIndex } : {}),
      ...(request.accountAddress !== undefined ? { accountAddress: request.accountAddress.toLowerCase() } : {}),
    };
    this.#refuseDuplicate(accounts, next);
    if (key || identityChanged) {
      // The key file carries the account's ids too: a new key, or the saved one under the new ids.
      const saved = this.#key(current);
      const secret = key
        ? (next.exchange === 'lighter' ? lighterKey(key) : hyperliquidKey(key))
        : saved?.LIGHTER_API_SECRET ?? saved?.HYPERLIQUID_PK;
      if (!secret) throw new LiveSettingsError('Enter the key again: the saved one could not be read.');
      this.#writeKey(next, secret);
    }
    accounts[at] = next;
    this.#write(accounts);
    return this.#view(next, this.busy());
  }

  /** Forgets an account and deletes its key file (a server operator's file is left alone). */
  remove(id: string): void {
    const accounts = this.#accounts();
    const account = accounts.find((row) => row.id === id);
    if (!account) throw new LiveSettingsError('This account no longer exists.', 404);
    if (this.busy().has(id)) {
      throw new LiveSettingsError(`The account "${account.name}" is trading in a LIVE run; stop that run before removing it.`, 409);
    }
    this.#write(accounts.filter((row) => row.id !== id));
    if (account.keySource === 'app') rmSync(this.#keyFile(account), { force: true });
  }

  /** Environment for the read-only connection check of one account; never logged. */
  checkEnvironment(id: string): { readonly exchange: LiveExchange; readonly env: Record<string, string> } {
    const account = this.#accounts().find((row) => row.id === id);
    if (!account) throw new LiveSettingsError('This account no longer exists.', 404);
    const values = this.#key(account);
    if (!values) throw new LiveSettingsError(`The account "${account.name}" has no saved key.`);
    if (account.exchange === 'hyperliquid') {
      return { exchange: 'hyperliquid', env: { HYPERLIQUID_PK: values.HYPERLIQUID_PK!, HYPERLIQUID_ACCOUNT_ADDRESS: account.accountAddress! } };
    }
    return { exchange: 'lighter', env: {
      LIGHTER_ACCOUNT_INDEX: String(account.accountIndex), LIGHTER_API_KEY_INDEX: String(account.apiKeyIndex),
      LIGHTER_API_SECRET: values.LIGHTER_API_SECRET!,
    } };
  }
}
