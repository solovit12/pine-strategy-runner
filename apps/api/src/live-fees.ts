import type { LiveAccountFees, LiveAccountView } from '../../../packages/shared/src/paper-experiment-contracts.js';

/**
 * The fees an exchange charges one Live account, read from the exchange's public API (no key):
 * Hyperliquid's own rates for the address (its volume tier), Lighter's account type (a standard
 * account trades without fees). A LIVE run's fee fields show these instead of typed values.
 */
const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const LIGHTER_ACCOUNT = 'https://mainnet.zklighter.elliot.ai/api/v1/account';
const CACHE_MS = 10 * 60_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A fraction as the fee fields write it: "0.00045" -> 0.045 (percent). */
const percent = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number((number * 100).toFixed(6)) : null;
};

export function createLiveFeeReader(fetchImpl: Fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { readonly at: number; readonly fees: LiveAccountFees }>();

  async function read(account: LiveAccountView): Promise<LiveAccountFees> {
    const signal = AbortSignal.timeout(10_000);
    if (account.exchange === 'hyperliquid') {
      const response = await fetchImpl(HYPERLIQUID_INFO, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'userFees', user: account.accountAddress }) });
      if (!response.ok) throw new Error(`Hyperliquid answered ${response.status}.`);
      const body = await response.json() as { userAddRate?: unknown; userCrossRate?: unknown };
      const makerPercent = percent(body.userAddRate);
      const takerPercent = percent(body.userCrossRate);
      if (makerPercent === null || takerPercent === null) throw new Error('Hyperliquid did not report the account\'s fees.');
      return { exchange: 'hyperliquid', makerPercent, takerPercent,
        source: 'Your Hyperliquid account\'s rates (its volume tier); xyz: markets pay their own multiple.' };
    }
    const response = await fetchImpl(`${LIGHTER_ACCOUNT}?by=index&value=${account.accountIndex}`, { signal });
    if (!response.ok) throw new Error(`Lighter answered ${response.status}.`);
    const body = await response.json() as { accounts?: Array<{ account_type?: unknown }> };
    const type = body.accounts?.[0]?.account_type;
    if (type === 0) {
      return { exchange: 'lighter', makerPercent: 0, takerPercent: 0, source: 'Lighter standard account: no trading fees.' };
    }
    throw new Error('This Lighter account is not a standard account; enter its fees from Lighter\'s fee schedule.');
  }

  return async (account: LiveAccountView): Promise<LiveAccountFees> => {
    const key = `${account.exchange}:${account.accountIndex ?? account.accountAddress}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < CACHE_MS) return cached.fees;
    const fees = await read(account);
    cache.set(key, { at: now(), fees });
    return fees;
  };
}
