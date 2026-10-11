/** HTTP 429 is temporary admission pressure, not invalid market data. */
export class PublicRateLimitError extends Error {
  readonly retryAtMs: number | null;
  readonly retryAfter: string | null;

  constructor(readonly label: string, response: Response, nowMs = Date.now()) {
    super(`${label} HTTP 429.`);
    this.name = 'PublicRateLimitError';
    const raw = response.headers.get('retry-after');
    this.retryAfter = raw === null ? null : raw.slice(0, 128);
    this.retryAtMs = retryAfterAt(raw, nowMs);
  }
}

function retryAfterAt(raw: string | null, nowMs: number): number | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    // A huge valid delay must never wrap a timer or cause an early retry.
    return Math.min(Number.MAX_SAFE_INTEGER, nowMs + Number(value) * 1000);
  }
  const current = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
  const obsolete = /^[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
  const asctime = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  if (!current.test(value) && !obsolete.test(value) && !asctime.test(value)) return null;
  const parsed = Date.parse(asctime.test(value) ? `${value} GMT` : value);
  return Number.isFinite(parsed) ? Math.max(nowMs, parsed) : null;
}

export async function checkPublicRateLimit(response: Response, label: string, nowMs = Date.now()): Promise<void> {
  if (response.status !== 429) return;
  const error = new PublicRateLimitError(label, response, nowMs);
  // Do not download or log an arbitrary error body. Release its connection.
  await response.body?.cancel().catch(() => undefined);
  throw error;
}

export function rateLimitRetryAt(error: PublicRateLimitError, attempt: number, nowMs = Date.now()): number {
  const backoffMs = 30_000 * 2 ** Math.min(2, Math.max(0, attempt - 1));
  return Math.max(nowMs + backoffMs, error.retryAtMs ?? 0);
}
