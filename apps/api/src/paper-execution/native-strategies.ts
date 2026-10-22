import type { PaperExperimentRuntimeFactory } from './paper-experiment-controller.js';

/** This edition has no built-in (native) strategies: Paper runs Pine strategies and the user's own Python strategies. */
export function createNativePaperFactory(_options: unknown): PaperExperimentRuntimeFactory | null {
  return null;
}

/** Without a native factory, the Paper router refuses such launches itself. */
export function nativeLaunchRefusal(_version: { readonly sourceSha256: string; readonly origin?: string },
  _markets: readonly string[]): string | null {
  return null;
}
