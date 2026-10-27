/** Which build this is. The public edition replaces this file with `'public'`. */
export type Edition = 'full' | 'public';

export const EDITION: Edition = 'public';

/**
 * Python strategies run in both editions: each user configures folders of their own strategy files
 * (strategy packs, PSR_STRATEGY_PACKS); no pack ships with the service.
 */
export function pythonStrategiesAvailable(_edition: Edition = EDITION): boolean {
  return true;
}

/** Live trading with real money ships in both editions; each user connects their own account. */
export function liveTradingAvailable(_edition: Edition = EDITION): boolean {
  return true;
}

/** Backtest reports to the owner's Google Sheet and Telegram channel: the private edition only. */
export function reportSharingAvailable(edition: Edition = EDITION): boolean {
  return edition === 'full';
}

export const PINE_ONLY_MESSAGE = 'This edition runs Pine strategies only.';
