import { PYTHON_STRATEGY_SOURCE_PREFIX, type StrategySummary } from '../../../../packages/shared/src/strategy-catalog-contracts';

async function sha256Hex(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Library source of a pack strategy: a reference only, its code stays in the pack. */
export function pythonStrategySource(ref: string): string {
  return `${PYTHON_STRATEGY_SOURCE_PREFIX}${ref}`;
}

/** The library entry that already holds this pack strategy's Paper settings, if any. */
export async function findSavedPythonStrategy(ref: string, strategies: readonly StrategySummary[]):
  Promise<StrategySummary | undefined> {
  const digest = await sha256Hex(pythonStrategySource(ref));
  return strategies.find((item) => item.sourceSha256 === digest);
}
