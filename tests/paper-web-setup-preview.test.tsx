import { DEFAULT_PAPER_MARKETS } from '../apps/web/src/components/PaperScreens';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PineLivePaperSettingsV1, StrategyDetail } from '../packages/shared/src/strategy-catalog-contracts';
import {
  DEFAULT_PAPER_FEES, PaperRunsPreview, PaperSetupPreview, baseMarket, paperSettingsEqual, paramError, parseMarketList, parseParam, rankMarkets,
  validPaperSettings,
} from '../apps/web/src/components/PaperScreens';
import { findSavedPythonStrategy, pythonStrategySource } from '../apps/web/src/lib/python-strategy-library';
import { createHash } from 'node:crypto';
import { PaperRunEngineLabel } from '../apps/web/src/components/PaperRuns';

const callbacks = {
  onSelectStrategy: () => undefined,
  onPrepareVersion: async () => { throw new Error('not used'); },
  onBack: () => undefined,
  onRuns: () => undefined,
};

const settings: PineLivePaperSettingsV1 = {
  accountModel: 'pine_live_v1', timeframe: '15m',
  tracks: [{ venue: 'Hyperliquid', market: 'kPEPE' }, { venue: 'Lighter', market: 'BTC' }],
  capitalPerVenue: 5000, orderSizePercent: 20, ...DEFAULT_PAPER_FEES,
};

const savedStrategy = {
  strategy: { id: 'my-strategy', name: 'Breakout', currentVersion: 3 },
  version: {
    strategyId: 'my-strategy', version: 3, name: 'Breakout',
    source: 'strategy("Breakout")', sourceSha256: 'a'.repeat(64), metadata: {},
    paperSettings: settings,
  },
} as unknown as StrategyDetail;

describe('generic Pine Paper setup', () => {
  it('validates any perpetual markets, at most fifteen per exchange, one exchange is enough', () => {
    expect(validPaperSettings(settings, null)).toBeNull();
    expect(validPaperSettings({ ...settings, tracks: [{ venue: 'Lighter', market: 'SOL' }] }, null)).toBeNull();
    expect(validPaperSettings({ ...settings, tracks: [] }, null)).toBe('Choose at least one market.');
    const fifteen = Array.from({ length: 15 }, (_, index) => ({ venue: 'Lighter' as const, market: `M${index}` }));
    expect(validPaperSettings({ ...settings, tracks: fifteen }, null)).toBeNull();
    const sixteen = [...fifteen, { venue: 'Lighter' as const, market: 'M15' }];
    expect(validPaperSettings({ ...settings, tracks: sixteen }, null)).toBe('Choose at most 15 Lighter markets.');
    expect(validPaperSettings({ ...settings, orderSizePercent: 0 }, null)).toMatch(/Order size/);
    expect(validPaperSettings({ ...settings, lighterTakerFeePercent: Number.NaN }, null)).toMatch(/four fees/);
    expect(validPaperSettings({ ...settings, capitalPerVenue: 50 }, null)).toMatch(/at least 100 USDC/);
  });

  it('validates Live settings: both exchanges, every limit required, leverage at most 50x', () => {
    const live = { ...settings, tracks: [{ venue: 'Lighter' as const, market: 'BTC' }],
      live: { dailyLossLimitPercent: 10, maxLeverage: 3, exchangeStopPercent: 0.5, exchangeStopFrom: 'strategy_stop' as const } };
    expect(validPaperSettings(live, null)).toBeNull();
    expect(validPaperSettings({ ...live, tracks: settings.tracks }, null)).toBeNull(); // Lighter and Hyperliquid in one Live run
    expect(validPaperSettings({ ...live, live: { ...live.live, dailyLossLimitPercent: Number.NaN } }, null)).toMatch(/daily loss limit/);
    expect(validPaperSettings({ ...live, live: { ...live.live, dailyLossLimitPercent: 0.5 } }, null)).toMatch(/from 1% to 99%/);
    expect(validPaperSettings({ ...live, live: { ...live.live, dailyLossLimitPercent: 100 } }, null)).toMatch(/from 1% to 99%/);
    const { dailyLossLimitPercent: _off, ...noLimit } = live.live;
    expect(validPaperSettings({ ...live, live: noLimit }, null)).toBeNull(); // empty: no daily limit
    expect(validPaperSettings({ ...live, live: { ...live.live, maxLeverage: 51 } }, null)).toMatch(/at most 50x/);
    expect(validPaperSettings({ ...live, live: { ...live.live, exchangeStopPercent: 0 } }, null)).toMatch(/exchange stop distance/);
    expect(validPaperSettings({ ...live, live: { ...live.live, maxSlippagePercent: 0.01 } }, null)).toMatch(/max slippage from 0.05% to 50%/);
    expect(validPaperSettings({ ...live, live: { ...live.live, maxSlippagePercent: 3 } }, null)).toBeNull();
    expect(validPaperSettings({ ...live, live: { ...live.live, maxPositionUsdc: 0 } }, null)).toMatch(/max position above 0 USDC/);
    expect(validPaperSettings({ ...live, live: { ...live.live, maxPositionUsdc: 13 } }, null)).toBeNull();
    expect(paperSettingsEqual(live, { ...live, live: { ...live.live, maxPositionUsdc: 13 } })).toBe(false);
    expect(paperSettingsEqual(live, { ...live, live: { ...live.live, minimumOrderSize: true } })).toBe(false);
    expect(paperSettingsEqual(live, { ...live, live: { ...live.live, minimumOrderSize: false } })).toBe(true);
    expect(paperSettingsEqual(live, { ...live, live: { ...live.live, exchangeStopFrom: 'entry_price' } })).toBe(false);
    expect(paperSettingsEqual(live, live)).toBe(true);
    expect(paperSettingsEqual(live, { ...live, live: { ...live.live, maxLeverage: 2 } })).toBe(false);
    const { live: _live, ...paper } = live;
    expect(paperSettingsEqual(live, paper)).toBe(false);
  });

  it('offers no Live mode until the engine answers', () => {
    const setup = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: savedStrategy.version.source, fromBacktest: false,
      strategies: [savedStrategy.strategy], savedStrategy, catalogBusy: false, ...callbacks,
    }));
    expect(setup).not.toContain('LIVE — real money');
    expect(setup).not.toContain('Start LIVE');
  });

  it('derives the default market from the backtest symbol and compares settings independent of order', () => {
    expect(baseMarket('BTCUSDT')).toBe('BTC');
    expect(baseMarket('HYPE')).toBe('HYPE');
    expect(baseMarket('ETH-USD-PERP')).toBe('ETH');
    expect(paperSettingsEqual(settings, { ...settings, tracks: [...settings.tracks].reverse() })).toBe(true);
    expect(paperSettingsEqual(settings, { ...settings, orderSizePercent: 10 })).toBe(false);
  });

  it('shows the saved settings, flat start and real-time execution rules', () => {
    const setup = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: savedStrategy.version.source, fromBacktest: false,
      strategies: [savedStrategy.strategy], savedStrategy, catalogBusy: false, ...callbacks,
    }));
    expect(setup).toContain('Run a strategy in Paper');
    expect(setup).toContain('Breakout');
    expect(setup).toContain('kPEPE');
    expect(setup).toContain('BTC');
    expect(setup).toContain('Flat, no positions');
    expect(setup).toContain('Stops, stop-losses and trailing stops trigger on the live best price');
    expect(setup).toContain('Launches saved Breakout.');
    expect(setup).toMatch(/<button[^>]*disabled=""[^>]*>Start Paper<\/button>/); // until the server admits Paper
  });

  it('prefills the backtested editor code with the standard market set and fees', () => {
    const setup = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: 'strategy("Fresh idea")', fromBacktest: true, backtestTimeframe: '5m', backtestSymbol: 'SOLUSDT',
      strategies: [], savedStrategy: null, catalogBusy: false, ...callbacks,
    }));
    expect(setup).toContain('Fresh idea');
    expect(setup).toContain('Current editor (just backtested)');
    expect(setup).toContain('<option value="5m" selected="">5m</option>');
    for (const market of [...DEFAULT_PAPER_MARKETS.Hyperliquid, ...DEFAULT_PAPER_MARKETS.Lighter]) {
      expect(setup).toContain(`<span>${market}</span>`);
    }
    expect(setup).toContain('20 markets');
    expect(setup).toContain('value="0.045"');
    expect(setup).toContain('Start saves this Pine code and these settings to the strategy library');
    // A preselected saved Python strategy must not replace the just-backtested editor code.
    const python = { ...settings, accountModel: 'python_live_v1' as const, strategyRef: 'examples/ema_cross:EmaCross',
      params: {}, timeframe: '1h' as const };
    const otherSaved = { ...savedStrategy, version: { ...savedStrategy.version,
      source: 'psr-python-strategy:examples/ema_cross:EmaCross', paperSettings: python } } as unknown as StrategyDetail;
    const fromEditor = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: 'strategy("Fresh idea")', fromBacktest: true, backtestTimeframe: '15m', backtestSymbol: 'HYPEUSDT',
      strategies: [], savedStrategy: otherSaved, catalogBusy: false, ...callbacks,
    }));
    expect(fromEditor).toContain('<option value="pine" selected="">Pine code</option>');
    expect(fromEditor).toContain('Current editor (just backtested)');
    expect(fromEditor).toContain('<option value="15m" selected="">15m</option>');
    expect(fromEditor).toContain('20 markets');
    expect(fromEditor).not.toContain('kPEPE');
    // Paper without a backtest: the editor page still leads, without the "just backtested" label.
    const notBacktested = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: 'strategy("Fresh idea")', fromBacktest: false, fromEditor: true, backtestTimeframe: '15m', backtestSymbol: 'HYPEUSDT',
      strategies: [], savedStrategy: otherSaved, catalogBusy: false, ...callbacks,
    }));
    expect(notBacktested).toContain('<option value="pine" selected="">Pine code</option>');
    expect(notBacktested).toContain('<option value="editor" selected="">Current editor</option>');
    const runs = renderToStaticMarkup(createElement(PaperRunsPreview, { onPrepare: () => undefined }));
    expect(runs).toContain('Loading server runs');
  });

  it('validates Python strategy parameters and keeps Python settings distinct from Pine', () => {
    const length = { type: 'int' as const, default: 20, min: 2, max: 500, choices: null, label: 'Length', help: '' };
    expect(parseParam(length, '30')).toBe(30);
    expect(paramError('length', length, parseParam(length, '1'))).toBe('Length must be at least 2.');
    expect(paramError('length', length, parseParam(length, '2.5'))).toBe('Length must be a whole number.');
    expect(paramError('length', length, parseParam(length, ''))).toBe('Length must be a whole number.');
    const flag = { type: 'bool' as const, default: true, min: null, max: null, choices: null, label: 'Flag', help: '' };
    expect(parseParam(flag, 'false')).toBe(false);
    const python = { ...settings, accountModel: 'python_live_v1' as const, strategyRef: 'examples/ema_cross:EmaCross', params: { fast: 12 } };
    expect(paperSettingsEqual(python, settings)).toBe(false);
    expect(paperSettingsEqual(python, { ...python, params: { fast: 13 } })).toBe(false);
    expect(paperSettingsEqual(python, { ...python })).toBe(true);
    const saved = { ...savedStrategy, version: { ...savedStrategy.version, source: 'psr-python-strategy:examples/ema_cross:EmaCross',
      paperSettings: python } } as unknown as StrategyDetail;
    const setup = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: '', fromBacktest: false, strategies: [], savedStrategy: saved, catalogBusy: false, ...callbacks, edition: 'full',
    }));
    expect(setup).toContain('<option value="python" disabled="" selected="">Python strategy</option>');
    expect(setup).toContain('Start saves this strategy and its settings in the library');
  });

  it('as a tab of the Strategy page runs the editor code without its own heading or source choice', () => {
    const tab = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: 'strategy("Editor draft")', fromBacktest: false, fromEditor: true, strategies: [], savedStrategy: null,
      catalogBusy: false, ...callbacks, embedded: true,
    }));
    expect(tab).toContain('aria-label="Paper setup"');
    expect(tab).not.toContain('Run a strategy in Paper');
    expect(tab).not.toContain('Back to Backtest');
    expect(tab).not.toContain('Current editor');
    expect(tab).toContain('Start Paper');
  });

  it('keeps the public edition on Pine code: the type is locked and saved Python settings are not applied', () => {
    const python = { ...settings, accountModel: 'python_live_v1' as const, strategyRef: 'examples/ema_cross:EmaCross', params: { fast: 12 } };
    const saved = { ...savedStrategy, version: { ...savedStrategy.version, source: 'psr-python-strategy:examples/ema_cross:EmaCross',
      paperSettings: python } } as unknown as StrategyDetail;
    const setup = renderToStaticMarkup(createElement(PaperSetupPreview, {
      source: '', fromBacktest: false, strategies: [], savedStrategy: saved, catalogBusy: false, ...callbacks, edition: 'public',
    }));
    expect(setup).toContain('aria-label="Strategy type" disabled=""');
    expect(setup).toContain('<option value="pine" selected="">Pine code</option>');
    expect(setup).not.toContain('Python');
    expect(setup).not.toContain('Start saves this strategy and its settings in the library');
  });

  it('orders the market picker by match quality, then 24 h volume, and hides chosen markets', () => {
    const options = ['ADA', 'BTC', 'DOGE', 'ETH', 'ETHFI', 'HYPE', 'WETH'];
    const volumes = { BTC: 3e9, ETH: 2e9, HYPE: 5e8, DOGE: 1e8, ETHFI: 1e6, WETH: 9e9 };
    expect(rankMarkets(options, '', ['HYPE'], volumes)).toEqual(['BTC', 'ETH', 'DOGE', 'ETHFI', 'ADA', 'WETH'].sort(
      (a, b) => (volumes[b as keyof typeof volumes] ?? -1) - (volumes[a as keyof typeof volumes] ?? -1)));
    expect(rankMarkets(options, 'eth', [], volumes)).toEqual(['ETH', 'ETHFI', 'WETH']);
    expect(rankMarkets(options, 'zzz', [], volumes)).toEqual([]);
    expect(rankMarkets(options, '', [], null)).toEqual(options);
  });

  it('adds several markets typed or pasted at once: commas, spaces, any case; reports what it cannot add', () => {
    const options = ['ADA', 'BTC', 'DOGE', 'ETH', 'HYPE', 'SOL', 'xyz:NVDA'];
    expect(parseMarketList('btc, eth  sol;\nxyz:nvda', options, [], 15))
      .toEqual({ add: ['BTC', 'ETH', 'SOL', 'xyz:NVDA'], unknown: [], already: [], overLimit: [] });
    expect(parseMarketList('BTC, FOO eth ETH', options, ['BTC'], 15))
      .toEqual({ add: ['ETH'], unknown: ['FOO'], already: ['BTC', 'ETH'], overLimit: [] });
    expect(parseMarketList('ADA DOGE HYPE', options, ['BTC'], 3))
      .toEqual({ add: ['ADA', 'DOGE'], unknown: [], already: [], overLimit: ['HYPE'] });
    // The exchange's list not loaded yet: well-formed symbols pass, the server checks them at launch.
    expect(parseMarketList('BTC, b@d', null, [], 15)).toEqual({ add: ['BTC'], unknown: ['b@d'], already: [], overLimit: [] });
  });

  it('finds the library entry that holds a pack strategy settings', async () => {
    const ref = 'private_pack/levels:Levels';
    const digest = createHash('sha256').update(pythonStrategySource(ref)).digest('hex');
    const entry = { ...savedStrategy.strategy, id: 'saved-python', sourceSha256: digest } as never;
    expect(await findSavedPythonStrategy(ref, [savedStrategy.strategy as never, entry])).toBe(entry);
    expect(await findSavedPythonStrategy('other/pack:Other', [entry])).toBeUndefined();
  });

  it('labels the reported Nautilus runtime without guessing an engine for older runs', () => {
    const current = renderToStaticMarkup(createElement(PaperRunEngineLabel, { engine: 'nautilus' }));
    const historical = renderToStaticMarkup(createElement(PaperRunEngineLabel, {}));
    expect(current).toContain('Nautilus Sandbox');
    expect(current).toContain('does not place real exchange orders');
    expect(historical).toBe('');
  });
});
