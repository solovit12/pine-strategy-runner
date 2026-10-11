/** Which build this is. The public edition replaces this file with `'public'`. */
export type Edition = 'full' | 'public';

export const EDITION: Edition = 'public';

/** Python strategies (strategy packs and the SDK) ship in the full edition only. */
export function pythonStrategiesAvailable(edition: Edition = EDITION): boolean {
  return edition === 'full';
}

export const PINE_ONLY_MESSAGE = 'This edition runs Pine strategies only.';
