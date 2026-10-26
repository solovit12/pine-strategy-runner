/**
 * Exchange request limits that every run of one server shares, what each run adds to them, and the
 * forecast shown before a launch. Limits from the exchanges' documentation (2026-10-25):
 * https://apidocs.lighter.xyz/docs/rate-limits and Hyperliquid's "Rate limits and user limits".
 */

export const EXCHANGE_LIMITS = {
  /** Lighter, Standard account: requests without a key per server address per minute. */
  lighterRequests: 60,
  /** Lighter: orders (sendTx) per wallet per minute; the sub-accounts of one wallet share it. */
  lighterOrders: 60,
  /** Hyperliquid: request weight per server address per minute. */
  hyperliquidWeight: 1200,
  /** Hyperliquid: open websocket connections per server address. */
  hyperliquidConnections: 10,
} as const;

/** What one run adds by the engine's own schedule (a Live run checks its positions every 10 s). */
export const RUN_LOAD = {
  /** One account read per position check. */
  lighterLiveRequestsPerMinute: 6,
  /** Spot and two perp-dex account reads (weight 2 each) per position check. */
  hyperliquidLiveWeightPerMinute: 36,
  /** Prices; a Live run also keeps its account's own connection. */
  hyperliquidConnections: { paper: 1, live: 2 },
} as const;

export type ExchangeLoadKey = 'lighter-requests' | 'hyperliquid-weight' | 'hyperliquid-connections'
  | 'lighter-orders' | 'hyperliquid-orders';

export interface ExchangeLoadRow {
  readonly key: ExchangeLoadKey;
  readonly exchange: 'Lighter' | 'Hyperliquid';
  readonly label: string;
  /** server: shared by everything on this server's address; account: one exchange account. */
  readonly scope: 'server' | 'account';
  /** The account (scope account): its name on the Accounts page. */
  readonly account?: string;
  /** Rates: the busiest minute of the last hour. Connections and the order budget: now. */
  readonly used: number;
  readonly limit: number;
  readonly perMinute: boolean;
  /** Who uses it. */
  readonly parts: readonly { readonly label: string; readonly value: number }[];
  /** The last time the exchange answered "too many requests" (ISO), if within the hour. */
  readonly refusedAt?: string | null;
  readonly note?: string;
}

export interface ExchangeLoadView {
  readonly observedAt: string;
  readonly rows: readonly ExchangeLoadRow[];
  /** False when other programs' connections cannot be seen (not Linux, or inside a container). */
  readonly otherProgramsVisible: boolean;
}

export type LimitLevel = 'ok' | 'near' | 'over';

export const NEAR_SHARE = 0.7;
export const OVER_SHARE = 0.9;

export function limitLevel(row: Pick<ExchangeLoadRow, 'used' | 'limit' | 'refusedAt'>): LimitLevel {
  if (row.refusedAt) return 'over';
  const share = row.limit > 0 ? row.used / row.limit : 0;
  return share > OVER_SHARE ? 'over' : share >= NEAR_SHARE ? 'near' : 'ok';
}

/** The fullest limit, percent (0..), for the header. */
export function loadPercent(view: Pick<ExchangeLoadView, 'rows'>): number {
  return Math.round(Math.max(0, ...view.rows.map((row) => (row.limit > 0 ? (row.used / row.limit) * 100 : 0))));
}

export function viewLevel(view: Pick<ExchangeLoadView, 'rows'>): LimitLevel {
  const levels = view.rows.map(limitLevel);
  return levels.includes('over') ? 'over' : levels.includes('near') ? 'near' : 'ok';
}

/** What a run about to start uses. */
export interface RunLoadPlan {
  readonly lighter: boolean;
  readonly hyperliquid: boolean;
  readonly live: boolean;
}

export function runLoadPlan(settings: { readonly tracks: readonly { readonly venue: string }[]; readonly live?: unknown }): RunLoadPlan {
  return {
    lighter: settings.tracks.some((track) => track.venue === 'Lighter'),
    hyperliquid: settings.tracks.some((track) => track.venue === 'Hyperliquid'),
    live: Boolean(settings.live),
  };
}

/** How much one run adds to a server row. */
export function runAdds(key: ExchangeLoadKey, plan: RunLoadPlan): number {
  if (key === 'hyperliquid-connections' && plan.hyperliquid) {
    return plan.live ? RUN_LOAD.hyperliquidConnections.live : RUN_LOAD.hyperliquidConnections.paper;
  }
  if (key === 'lighter-requests' && plan.live && plan.lighter) return RUN_LOAD.lighterLiveRequestsPerMinute;
  if (key === 'hyperliquid-weight' && plan.live && plan.hyperliquid) return RUN_LOAD.hyperliquidLiveWeightPerMinute;
  return 0;
}

export interface LoadForecast {
  /** Server rows after the run starts. */
  readonly rows: readonly (ExchangeLoadRow & { readonly added: number })[];
  /** Plain warnings for rows at 70 % or more after the start. */
  readonly warnings: readonly string[];
  /** Why a Live run must not start: Hyperliquid would not open its connections. */
  readonly refusal: string | null;
}

export function forecastRun(view: Pick<ExchangeLoadView, 'rows'>, plan: RunLoadPlan): LoadForecast {
  const rows = view.rows.filter((row) => row.scope === 'server').map((row) => {
    const added = runAdds(row.key, plan);
    return { ...row, used: row.used + added, added };
  });
  const warnings = rows.filter((row) => row.added > 0 && limitLevel({ ...row, refusedAt: null }) !== 'ok')
    .map((row) => `${row.label}: ${row.used} of ${row.limit}${row.perMinute ? ' a minute' : ''} after this run starts.`);
  const connections = rows.find((row) => row.key === 'hyperliquid-connections');
  const refusal = plan.live && connections && connections.added > 0 && connections.used > connections.limit
    ? `This Live run needs ${connections.added} more Hyperliquid connections: ${connections.used} of ${connections.limit}. `
      + 'Hyperliquid would not open the extra ones, and the run would be left without prices or its account. '
      + 'Stop a run, or wait until another program on this server closes its connections.'
    : null;
  return { rows, warnings, refusal };
}
