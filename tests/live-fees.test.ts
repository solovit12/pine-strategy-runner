import { describe, expect, it } from 'vitest';

import { createLiveFeeReader } from '../apps/api/src/live-fees.js';
import { PythonLivePaperLaunchSettingsV1Schema } from '../packages/shared/src/paper-experiment-contracts.js';
import type { LiveAccountView } from '../packages/shared/src/paper-experiment-contracts.js';

const base = { name: 'A', enabled: true, keySaved: true, keySource: 'app' as const, runId: null };
const hyperliquid: LiveAccountView = { ...base, id: 'acc-hl-0001', exchange: 'hyperliquid', accountIndex: null, apiKeyIndex: null,
  accountAddress: `0x${'ab'.repeat(20)}` };
const lighter: LiveAccountView = { ...base, id: 'acc-li-0001', exchange: 'lighter', accountIndex: 562, apiKeyIndex: 5, accountAddress: null };

describe('LIVE fees of an account', () => {
  it("reads Hyperliquid's own rates for the address and Lighter's account type", async () => {
    const asked: string[] = [];
    let lighterType = 0;
    const reader = createLiveFeeReader(async (url, init) => {
      asked.push(`${url} ${init?.body ?? ''}`);
      if (url.includes('hyperliquid')) return Response.json({ userAddRate: '0.00012', userCrossRate: '0.0004' });
      return Response.json({ accounts: [{ account_type: lighterType }] });
    });
    expect(await reader(hyperliquid)).toMatchObject({ exchange: 'hyperliquid', makerPercent: 0.012, takerPercent: 0.04 });
    expect(asked[0]).toContain(`"type":"userFees","user":"0x${'ab'.repeat(20)}"`);
    expect(await reader(lighter)).toMatchObject({ exchange: 'lighter', makerPercent: 0, takerPercent: 0 });
    expect(asked[1]).toContain('account?by=index&value=562');
    // Cached for a while: no second request.
    await reader(hyperliquid);
    expect(asked).toHaveLength(2);
    lighterType = 1;
    await expect(createLiveFeeReader(async () => Response.json({ accounts: [{ account_type: 1 }] }))(lighter))
      .rejects.toThrow('not a standard account');
    await expect(createLiveFeeReader(async () => new Response('busy', { status: 429 }))(hyperliquid))
      .rejects.toThrow('Hyperliquid answered 429');
  });

  it('launches up to 30 markets (15 per exchange) and explains a larger choice in words', () => {
    const settings = (count: number) => ({
      accountModel: 'python_live_v1', strategyRef: 'pack/module:Strategy', params: {}, timeframe: '1h',
      tracks: Array.from({ length: count }, (_, index) => ({ venue: index % 2 ? 'Lighter' : 'Hyperliquid', market: `M${index}` })),
      capitalPerVenue: 1000, orderSizePercent: 10,
      hyperliquidMakerFeePercent: 0.015, hyperliquidTakerFeePercent: 0.045, lighterMakerFeePercent: 0, lighterTakerFeePercent: 0,
    });
    expect(PythonLivePaperLaunchSettingsV1Schema.safeParse(settings(30)).success).toBe(true);
    const tooMany = PythonLivePaperLaunchSettingsV1Schema.safeParse(settings(32));
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues.map((issue) => issue.message)).toContain('Choose no more than 30 markets (15 per exchange).');
  });
});
