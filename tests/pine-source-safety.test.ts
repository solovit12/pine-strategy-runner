import { describe, expect, it } from 'vitest';
import {
  assertNoUnsupportedExternalSeries,
  UnsupportedPineFeatureError,
} from '../packages/pine-runtime/src/pine-source-safety';

describe('Pine external-series fail-closed guard', () => {
  it.each([
    'request.security("HYPERLIQUID:ETHUSDC.P", "60", close)',
    'request . security_lower_tf("HYPERLIQUID:ETHUSDC.P", "1", close)',
  ])('rejects unsupported executable call: %s', (source) => {
    expect(() => assertNoUnsupportedExternalSeries(source)).toThrowError(UnsupportedPineFeatureError);
  });

  it('does not reject words inside comments or strings', () => {
    expect(() => assertNoUnsupportedExternalSeries(`
//@version=6
strategy("request.security( is only text")
// request.security("X", "60", close)
plot(close)
`)).not.toThrow();
  });
});
