import { describe, expect, it } from 'vitest';
import { checkPublicRateLimit, PublicRateLimitError, rateLimitRetryAt } from '../apps/api/src/paper-execution/public-rate-limit.js';

const now = Date.UTC(2026, 9, 5, 12);
describe('Public HTTP 429', () => {
  it.each([
    ['120', now + 120_000], ['0', now],
    ['Mon, 05 Oct 2026 12:03:00 GMT', now + 180_000],
    ['Monday, 05-Oct-26 12:03:00 GMT', now + 180_000],
    ['Mon Oct  5 12:03:00 2026', now + 180_000],
    ['Mon, 05 Oct 2026 11:00:00 GMT', now],
    ['999999999999999999999999999999999', Number.MAX_SAFE_INTEGER],
    ['-1', null], ['1.5', null], ['soon', null], ['', null], [null, null],
  ])('preserves Retry-After timing: %s', async (header, expected) => {
    const response = new Response('private arbitrary error body', { status: 429,
      headers: header === null ? {} : { 'Retry-After': header } });
    const error = await checkPublicRateLimit(response, 'Hyperliquid metadata', now).catch(e => e);
    expect(error).toBeInstanceOf(PublicRateLimitError);
    expect(error).toMatchObject({ retryAtMs: expected, retryAfter: header });
    expect(error.message).not.toContain('private');
    expect(response.bodyUsed).toBe(true);
  });

  it('never retries before the venue time and backs off without a header', () => {
    const error = new PublicRateLimitError('Lighter', new Response(null, { status: 429 }), now);
    expect([1, 2, 3, 4, 1_000_000].map(i => rateLimitRetryAt(error, i, now) - now))
      .toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
    const delayed = new PublicRateLimitError('Hyperliquid', new Response(null, { status: 429, headers: { 'Retry-After': '900' } }), now);
    expect(rateLimitRetryAt(delayed, 1, now)).toBe(now + 900_000);
  });

  it.each([200, 400, 401, 403, 500, 503])('does not turn status %i into a rate-limit retry', async status => {
    const response = new Response('body', { status });
    await expect(checkPublicRateLimit(response, 'Public request')).resolves.toBeUndefined();
    expect(await response.text()).toBe('body');
  });
});
