import { existsSync } from 'node:fs';
import { readFile, readdir, readlink, stat } from 'node:fs/promises';
import { resolve4, resolve6 } from 'node:dns/promises';
import {
  EXCHANGE_LIMITS, RUN_LOAD, type ExchangeLoadRow, type ExchangeLoadView,
} from '../../../../packages/shared/src/exchange-load.js';
import type { PaperExperimentDetail, PaperExperimentSummary } from '../../../../packages/shared/src/paper-experiment-contracts.js';
import type { PaperVenueKey } from './venue-markets.js';

/**
 * Measures how much of each exchange limit this server uses (packages/shared/src/exchange-load.ts):
 * the requests this process sends (candles, market lists, fees), the Live runs' position checks
 * (by the engine's schedule), Hyperliquid connections — the runs' own by their setup, other
 * programs' as seen in the system's socket table — and each Hyperliquid account's order budget as
 * the exchange reports it. Requests the Nautilus clients make at a start or a reconnect are not counted.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A connection open this long is a stream, not a request's short-lived one. */
const STREAM_MIN_AGE_MS = 2 * MINUTE_MS;
const HYPERLIQUID_HOST = 'api.hyperliquid.xyz';
const HYPERLIQUID_INFO = `https://${HYPERLIQUID_HOST}/info`;
const ORDER_BUDGET_TTL_MS = 5 * MINUTE_MS;
const ACTIVE = new Set(['preparing', 'warming_up', 'waiting_for_data', 'running', 'recovering', 'stopping']);

const requests: Record<PaperVenueKey, Array<{ at: number; weight: number }>> = { lighter: [], hyperliquid: [] };
const refusals: Record<PaperVenueKey, number | null> = { lighter: null, hyperliquid: null };

/** One request this process sent to an exchange (weight: Hyperliquid's request weight). */
export function recordExchangeRequest(venue: PaperVenueKey, weight = 1, at = Date.now()): void {
  const log = requests[venue];
  log.push({ at, weight });
  while (log.length && log[0]!.at <= at - HOUR_MS) log.shift();
}

/** The exchange answered "too many requests". */
export function recordExchangeRefusal(venue: PaperVenueKey, at = Date.now()): void {
  refusals[venue] = at;
}

/** Requests and weight of the busiest rolling minute in the last hour. */
export function busiestMinute(venue: PaperVenueKey, now = Date.now()): { requests: number; weight: number } {
  const log = requests[venue].filter((row) => row.at > now - HOUR_MS);
  let best = { requests: 0, weight: 0 };
  let from = 0;
  let weight = 0;
  for (let to = 0; to < log.length; to += 1) {
    weight += log[to]!.weight;
    while (log[from]!.at <= log[to]!.at - MINUTE_MS) { weight -= log[from]!.weight; from += 1; }
    if (to - from + 1 > best.requests) best = { ...best, requests: to - from + 1 };
    if (weight > best.weight) best = { ...best, weight };
  }
  return best;
}

export function resetExchangeLoadForTests(): void {
  requests.lighter.length = 0;
  requests.hyperliquid.length = 0;
  refusals.lighter = refusals.hyperliquid = null;
}

interface SocketRow { readonly key: string; readonly ip: string; readonly port: number; readonly inode: string }

function hexIp(hex: string): string {
  if (hex.length === 8) {
    return [6, 4, 2, 0].map((index) => parseInt(hex.slice(index, index + 2), 16)).join('.');
  }
  // IPv6: four little-endian 32-bit words; an IPv4-mapped address reads as plain IPv4.
  const words = [0, 8, 16, 24].map((index) => hex.slice(index, index + 8).match(/../g)!.reverse().join(''));
  const full = words.join('').toLowerCase();
  if (full.startsWith('00000000000000000000ffff')) return hexIp(words[3]!.match(/../g)!.reverse().join(''));
  return full.match(/.{4}/g)!.map((group) => group.replace(/^0+(?=.)/, '')).join(':');
}

/** Established TCP connections from the system's socket table (Linux /proc/net/tcp and tcp6). */
export function parseSocketTable(text: string): SocketRow[] {
  const rows: SocketRow[] = [];
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '01') continue; // 01: ESTABLISHED
    const [remoteHex, portHex] = fields[2]!.split(':');
    if (!remoteHex || !portHex) continue;
    rows.push({ key: `${fields[1]}>${fields[2]}`, ip: hexIp(remoteHex), port: parseInt(portHex, 16), inode: fields[9]! });
  }
  return rows;
}

function normalizeIp(ip: string): string {
  return ip.includes(':') ? ip.toLowerCase().split(':').map((group) => group.replace(/^0+(?=.)/, '')).join(':') : ip;
}

export interface ExchangeLoadSources {
  /** Active runs: their exchanges, whether Live, their Live accounts and the orders sent so far. */
  readonly runs: () => readonly {
    readonly id: string;
    readonly lighter: boolean;
    readonly hyperliquid: boolean;
    readonly live: boolean;
    readonly accounts?: { readonly lighter?: string; readonly hyperliquid?: string };
    /** Orders sent per exchange so far (the runtime's intents). */
    readonly orders?: { readonly lighter?: number; readonly hyperliquid?: number };
  }[];
  /** Live accounts by id: name and, for Hyperliquid, the account address. */
  readonly account?: (id: string) => { readonly name: string; readonly accountAddress?: string | null } | null;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Tests: the system's socket table and this process family's socket inodes. */
  readonly sockets?: () => Promise<{ readonly table: string; readonly own: ReadonlySet<string> } | null>;
  readonly resolveHost?: (host: string) => Promise<string[]>;
}

/** The system socket table and the inodes of sockets held by this user's processes, or null. */
async function systemSockets(): Promise<{ table: string; own: Set<string> } | null> {
  if (process.platform !== 'linux' || !existsSync('/proc/net/tcp')) return null;
  const table = (await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((file) => readFile(file, 'utf8').catch(() => ''))))
    .map((text, index) => (index === 0 ? text : text.split('\n').slice(1).join('\n'))).join('\n');
  const own = new Set<string>();
  const uid = process.getuid?.();
  for (const pid of (await readdir('/proc').catch(() => [] as string[])).filter((name) => /^\d+$/.test(name))) {
    try {
      if ((await stat(`/proc/${pid}`)).uid !== uid) continue;
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode) own.add(inode);
      }
    } catch {
      // A process that ended meanwhile, or one this user may not read.
    }
  }
  return { table, own };
}

async function resolveAll(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([resolve4(host).catch(() => [] as string[]), resolve6(host).catch(() => [] as string[])]);
  return [...v4, ...v6];
}

export class ExchangeLoadMonitor {
  readonly #sources: ExchangeLoadSources;
  readonly #now: () => number;
  /** Hyperliquid addresses seen in DNS answers in the last day (its edge servers rotate). */
  readonly #hyperliquidIps = new Map<string, number>();
  /** First sight of each connection to Hyperliquid, to tell streams from requests. */
  readonly #firstSeen = new Map<string, number>();
  /** Orders sent per run and exchange over the last hour, sampled. */
  readonly #orderSamples = new Map<string, Array<{ at: number; orders: number }>>();
  readonly #orderBudget = new Map<string, { at: number; used: number; cap: number } | { at: number; error: true }>();
  #otherConnections: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(sources: ExchangeLoadSources) {
    this.#sources = sources;
    this.#now = sources.now ?? Date.now;
  }

  /** Samples every 30 s so that streams and order rates are known before anyone looks. */
  start(intervalMs = 30_000): void {
    if (this.#timer) return;
    void this.sample();
    this.#timer = setInterval(() => { void this.sample(); }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async sample(): Promise<void> {
    const now = this.#now();
    for (const run of this.#sources.runs()) {
      for (const venue of ['lighter', 'hyperliquid'] as const) {
        const orders = run.orders?.[venue];
        if (!run.live || orders === undefined) continue;
        const key = `${run.id}:${venue}`;
        const samples = this.#orderSamples.get(key) ?? [];
        samples.push({ at: now, orders });
        while (samples.length && samples[0]!.at <= now - HOUR_MS) samples.shift();
        this.#orderSamples.set(key, samples);
      }
    }
    this.#otherConnections = await this.#countOtherConnections(now).catch(() => null);
  }

  async #countOtherConnections(now: number): Promise<number | null> {
    const sockets = await (this.#sources.sockets ?? systemSockets)();
    if (!sockets) return null;
    for (const ip of await (this.#sources.resolveHost ?? resolveAll)(HYPERLIQUID_HOST)) this.#hyperliquidIps.set(normalizeIp(ip), now);
    for (const [ip, at] of this.#hyperliquidIps) if (at <= now - 24 * HOUR_MS) this.#hyperliquidIps.delete(ip);
    const open = new Set<string>();
    let count = 0;
    for (const row of parseSocketTable(sockets.table)) {
      if (row.port !== 443 || !this.#hyperliquidIps.has(normalizeIp(row.ip))) continue;
      open.add(row.key);
      const first = this.#firstSeen.get(row.key) ?? now;
      this.#firstSeen.set(row.key, first);
      // The runs' own connections are counted by their setup; others only once they last.
      if (!sockets.own.has(row.inode) && now - first >= STREAM_MIN_AGE_MS) count += 1;
    }
    for (const key of this.#firstSeen.keys()) if (!open.has(key)) this.#firstSeen.delete(key);
    return count;
  }

  /** Orders sent by one account's runs in the busiest minute of the last hour. */
  #accountOrders(accountId: string, venue: PaperVenueKey, runs: ReturnType<ExchangeLoadSources['runs']>): number {
    let best = 0;
    const series = runs.filter((run) => run.live && run.accounts?.[venue] === accountId)
      .map((run) => this.#orderSamples.get(`${run.id}:${venue}`) ?? []);
    for (const samples of series) {
      for (const sample of samples) {
        let total = 0;
        for (const other of series) {
          const end = [...other].reverse().find((row) => row.at <= sample.at);
          const begin = other.find((row) => row.at >= sample.at - MINUTE_MS);
          if (end && begin) total += Math.max(0, end.orders - begin.orders);
        }
        best = Math.max(best, total);
      }
    }
    return best;
  }

  async #hyperliquidOrderBudget(address: string): Promise<{ used: number; cap: number } | null> {
    const now = this.#now();
    const cached = this.#orderBudget.get(address);
    if (cached && now - cached.at < ORDER_BUDGET_TTL_MS) return 'error' in cached ? null : cached;
    try {
      const response = await (this.#sources.fetchImpl ?? fetch)(HYPERLIQUID_INFO, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userRateLimit', user: address }), signal: AbortSignal.timeout(10_000),
      });
      recordExchangeRequest('hyperliquid', 20, now);
      if (response.status === 429) recordExchangeRefusal('hyperliquid', now);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { nRequestsUsed?: unknown; nRequestsCap?: unknown };
      const used = Number(body.nRequestsUsed);
      const cap = Number(body.nRequestsCap);
      if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) throw new Error('unexpected answer');
      this.#orderBudget.set(address, { at: now, used, cap });
      return { used, cap };
    } catch {
      this.#orderBudget.set(address, { at: now, error: true });
      return null;
    }
  }

  async view(): Promise<ExchangeLoadView> {
    const now = this.#now();
    const runs = this.#sources.runs();
    const recent = (venue: PaperVenueKey) => {
      const at = refusals[venue];
      return at !== null && at > now - HOUR_MS ? new Date(at).toISOString() : null;
    };
    const liveLighter = runs.filter((run) => run.live && run.lighter).length;
    const liveHyperliquid = runs.filter((run) => run.live && run.hyperliquid).length;
    const paperHyperliquid = runs.filter((run) => !run.live && run.hyperliquid).length;
    const lighter = busiestMinute('lighter', now);
    const hyperliquid = busiestMinute('hyperliquid', now);
    const ownConnections = paperHyperliquid * RUN_LOAD.hyperliquidConnections.paper
      + liveHyperliquid * RUN_LOAD.hyperliquidConnections.live;
    const others = this.#otherConnections;
    const rows: ExchangeLoadRow[] = [
      {
        key: 'lighter-requests', exchange: 'Lighter', label: 'Lighter requests', scope: 'server',
        used: lighter.requests + liveLighter * RUN_LOAD.lighterLiveRequestsPerMinute,
        limit: EXCHANGE_LIMITS.lighterRequests, perMinute: true,
        parts: [{ label: 'candles and market lists', value: lighter.requests },
          { label: `position checks of ${liveLighter} Live run(s)`, value: liveLighter * RUN_LOAD.lighterLiveRequestsPerMinute }],
        refusedAt: recent('lighter'),
      },
      {
        key: 'hyperliquid-weight', exchange: 'Hyperliquid', label: 'Hyperliquid request weight', scope: 'server',
        used: hyperliquid.weight + liveHyperliquid * RUN_LOAD.hyperliquidLiveWeightPerMinute,
        limit: EXCHANGE_LIMITS.hyperliquidWeight, perMinute: true,
        parts: [{ label: 'candles and market lists', value: hyperliquid.weight },
          { label: `position checks of ${liveHyperliquid} Live run(s)`, value: liveHyperliquid * RUN_LOAD.hyperliquidLiveWeightPerMinute }],
        refusedAt: recent('hyperliquid'),
      },
      {
        key: 'hyperliquid-connections', exchange: 'Hyperliquid', label: 'Hyperliquid connections', scope: 'server',
        used: ownConnections + (others ?? 0), limit: EXCHANGE_LIMITS.hyperliquidConnections, perMinute: false,
        parts: [{ label: `${paperHyperliquid + liveHyperliquid} run(s) on Hyperliquid`, value: ownConnections },
          ...(others === null ? [] : [{ label: 'other programs on this server', value: others }])],
        ...(others === null ? { note: "Other programs' connections are not visible here." } : {}),
      },
    ];
    const accountIds = (venue: PaperVenueKey) => [...new Set(runs.flatMap((run) => (run.live && run.accounts?.[venue] ? [run.accounts[venue]!] : [])))];
    for (const id of accountIds('lighter')) {
      const name = this.#sources.account?.(id)?.name ?? id;
      rows.push({
        key: 'lighter-orders', exchange: 'Lighter', label: 'Lighter orders', scope: 'account', account: name,
        used: this.#accountOrders(id, 'lighter', runs), limit: EXCHANGE_LIMITS.lighterOrders, perMinute: true,
        parts: [], note: 'Sub-accounts of one wallet share this limit.',
      });
    }
    for (const id of accountIds('hyperliquid')) {
      const account = this.#sources.account?.(id);
      const budget = account?.accountAddress ? await this.#hyperliquidOrderBudget(account.accountAddress) : null;
      if (!budget) continue;
      rows.push({
        key: 'hyperliquid-orders', exchange: 'Hyperliquid', label: 'Hyperliquid orders', scope: 'account', account: account!.name,
        used: budget.used, limit: budget.cap, perMinute: false, parts: [],
        note: 'Grows by one for every 1 USDC traded; reported by Hyperliquid.',
      });
    }
    return {
      observedAt: new Date(now).toISOString(), rows,
      otherProgramsVisible: others !== null && !existsSync('/.dockerenv'),
    };
  }
}

export function activeRunsFrom(list: () => readonly PaperExperimentSummary[],
  detail: (id: string) => PaperExperimentDetail | null): ExchangeLoadSources['runs'] {
  return () => list().filter((run) => ACTIVE.has(run.status)).map((run) => {
    const full = run.live ? detail(run.id) : null;
    const accounts = full && 'live' in full.settings ? full.settings.live?.accounts : undefined;
    const intents = (venue: string) => full?.runtime?.accounts.find((account) => account.venue === venue)?.intents;
    return {
      id: run.id,
      lighter: (run.venues ?? []).includes('Lighter'),
      hyperliquid: (run.venues ?? []).includes('Hyperliquid'),
      live: Boolean(run.live),
      ...(accounts ? { accounts } : {}),
      ...(full?.runtime ? { orders: { lighter: intents('Lighter'), hyperliquid: intents('Hyperliquid') } } : {}),
    };
  });
}
