import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { LiveSettingsView, SaveLiveSettingsRequest } from '../../../packages/shared/src/paper-experiment-contracts.js';

/**
 * Live trading credentials and the on/off switch, kept on the machine that runs the engine.
 *
 * The API private key is written once into `<dir>/lighter-mainnet.env` (folder 0700, file 0600,
 * the format the engine reads) and is never returned by the API, written to a log or put into a
 * run's config: the engine reads it from that file itself. A server may also hold the same file in
 * a closed folder of its own (`/etc/psr-secrets`), read as a fallback.
 */
export const LIVE_SECRETS_FILE = 'lighter-mainnet.env';
const SETTINGS_FILE = 'live.json';
const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{40,200}$/;

interface StoredCredentials {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly secret: string;
}

export class LiveSettingsError extends Error {}

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

export class LiveSettingsStore {
  constructor(
    /** The app's own folder for Live credentials (in the data folder, next to the run history). */
    readonly directory: string,
    /** A server-managed closed folder read when the app's own file is absent. */
    readonly serverDirectory: string | null = '/etc/psr-secrets',
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** The operator can switch Live off for the whole server (PSR_LIVE_DISABLED=1). */
  get disabledByServer(): boolean {
    return this.env.PSR_LIVE_DISABLED === '1';
  }

  #credentials(): (StoredCredentials & { readonly source: 'app' | 'server' }) | null {
    const candidates: Array<[string | null, 'app' | 'server']> = [
      [this.directory, 'app'], [this.serverDirectory, 'server']];
    for (const [directory, source] of candidates) {
      if (!directory) continue;
      const file = path.join(directory, LIVE_SECRETS_FILE);
      let values: Record<string, string>;
      try {
        if (!existsSync(file)) continue;
        values = parseEnvFile(file);
      } catch {
        continue; // unreadable (e.g. a closed server folder): not this source
      }
      const accountIndex = Number(values.LIGHTER_ACCOUNT_INDEX);
      const apiKeyIndex = Number(values.LIGHTER_API_KEY_INDEX);
      const secret = values.LIGHTER_API_SECRET ?? '';
      if (Number.isSafeInteger(accountIndex) && Number.isSafeInteger(apiKeyIndex) && secret) {
        return { accountIndex, apiKeyIndex, secret, source };
      }
    }
    return null;
  }

  #enabledSetting(): boolean {
    try {
      const file = path.join(this.directory, SETTINGS_FILE);
      if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { enabled?: unknown }).enabled === true;
    } catch { /* treated as off */ }
    // A server that enabled Live before this setting existed keeps it on.
    return this.env.PSR_LIVE_ENABLED === '1';
  }

  view(): LiveSettingsView {
    const credentials = this.#credentials();
    return {
      exchange: 'lighter',
      enabled: this.#enabledSetting(),
      accountIndex: credentials?.accountIndex ?? null,
      apiKeyIndex: credentials?.apiKeyIndex ?? null,
      keySaved: Boolean(credentials),
      keySource: credentials?.source ?? null,
      disabledByServer: this.disabledByServer,
    };
  }

  /** Live can be offered: switched on, a key saved, and not switched off for the server. */
  liveTrading(): boolean {
    const view = this.view();
    return view.enabled && view.keySaved && !view.disabledByServer;
  }

  save(request: SaveLiveSettingsRequest): LiveSettingsView {
    const current = this.#credentials();
    const key = request.apiKey?.trim();
    if (key !== undefined && key !== '' && !KEY_PATTERN.test(key)) {
      throw new LiveSettingsError('The API private key must be the hexadecimal key Lighter gave you (40 to 200 characters, 0x optional).');
    }
    const secret = key || current?.secret;
    if (!secret) throw new LiveSettingsError('Enter the API private key.');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const file = path.join(this.directory, LIVE_SECRETS_FILE);
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, [
      '# Lighter API key for Live trading, written by Pine Strategy Runner. Keep this file private.',
      `LIGHTER_ACCOUNT_INDEX=${request.accountIndex}`,
      `LIGHTER_API_KEY_INDEX=${request.apiKeyIndex}`,
      `LIGHTER_API_SECRET=${secret}`,
      '',
    ].join('\n'), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    this.#writeEnabled(request.enabled);
    return this.view();
  }

  setEnabled(enabled: boolean): LiveSettingsView {
    if (enabled && !this.#credentials()) throw new LiveSettingsError('Save the Lighter API key first.');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.#writeEnabled(enabled);
    return this.view();
  }

  /** Deletes the app's own key file and switches Live off (a server-managed file is left alone). */
  removeKey(): LiveSettingsView {
    rmSync(path.join(this.directory, LIVE_SECRETS_FILE), { force: true });
    if (existsSync(this.directory)) this.#writeEnabled(false);
    return this.view();
  }

  /** Environment for the read-only connection check; never logged. */
  checkEnvironment(): Record<string, string> {
    const credentials = this.#credentials();
    if (!credentials) throw new LiveSettingsError('Save the Lighter API key first.');
    return {
      LIGHTER_ACCOUNT_INDEX: String(credentials.accountIndex),
      LIGHTER_API_KEY_INDEX: String(credentials.apiKeyIndex),
      LIGHTER_API_SECRET: credentials.secret,
    };
  }

  #writeEnabled(enabled: boolean): void {
    const file = path.join(this.directory, SETTINGS_FILE);
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ exchange: 'lighter', enabled })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}
