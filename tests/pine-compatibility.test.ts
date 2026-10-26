import { describe, expect, it } from 'vitest';
import { pineCompatibility } from '../packages/pine-runtime/src/pine-compatibility.js';

const script = (body: string, declaration = 'strategy("Test", overlay=true)') => `//@version=6\n${declaration}\n${body}\n`;
const levels = (source: string, context = {}) => pineCompatibility(source, context).map((issue) => `${issue.level}:${issue.where}:${issue.line}`);

describe('Pine compatibility check', () => {
  it('finds nothing in a plain strategy', () => {
    const source = script('fast = ta.ema(close, 12)\nif ta.crossover(fast, ta.ema(close, 26))\n    strategy.entry("L", strategy.long)\nstrategy.exit("X", "L", profit=300, loss=150)');
    expect(pineCompatibility(source, { chartSymbol: 'BTCUSDT', chartTimeframe: '1h' })).toEqual([]);
  });

  it('stops on another market and allows the chart market', () => {
    const source = script([
      'eth = request.security("BINANCE:ETHUSDT", "60", close)',
      'own = request.security(syminfo.tickerid, "240", close)',
      'same = request.security("BINANCE:BTCUSDT.P", "D", close)',
      'other = request.security(ticker.new("BINANCE", "SOLUSDT"), "D", close)',
    ].join('\n'));
    const issues = pineCompatibility(source, { chartSymbol: 'BTCUSDT', chartTimeframe: '1h' });
    expect(issues.map((issue) => [issue.level, issue.line])).toEqual([['stop', 3], ['stop', 6]]);
    expect(issues[0]!.message).toContain('(BINANCE:ETHUSDT)');
    expect(issues[1]!.message).toContain('(SOLUSDT)');
    // Paper trades many markets: any fixed market is another market somewhere.
    expect(levels(script('x = request.security("BINANCE:BTCUSDT", "D", close)'))).toEqual(['stop:all:3']);
  });

  it('warns when the market is computed and when Heikin Ashi candles are asked', () => {
    const source = script('sym = input.symbol("BINANCE:ETHUSDT")\nx = request.security(sym, "D", close)\nha = request.security(ticker.heikinashi(syminfo.tickerid), timeframe.period, close)');
    expect(levels(source, { chartSymbol: 'BTCUSDT' })).toEqual(['differs:all:4', 'differs:all:5']);
  });

  it('checks timeframes: unavailable everywhere, below or not a multiple of the chart in Paper', () => {
    const source = script([
      'm = request.security(syminfo.tickerid, "M", close)',
      'odd = request.security(syminfo.tickerid, "7", close)',
      'low = request.security(syminfo.tickerid, "15", close)',
      'four = request.security(syminfo.tickerid, timeframe="240", expression=close)',
      'ltf = request.security_lower_tf(syminfo.tickerid, "1", close)',
    ].join('\n'));
    expect(levels(source, { chartSymbol: 'BTCUSDT', chartTimeframe: '1h' }))
      .toEqual(['stop:all:3', 'stop:all:4', 'stop:paper:5', 'stop:paper:7']);
  });

  it('stops on request functions this service does not have', () => {
    const issues = pineCompatibility(script('rate = request.currency_rate("USD", "EUR")\neps = request.earnings(syminfo.tickerid)'));
    expect(issues.map((issue) => issue.message)).toEqual([
      'request.currency_rate is not available here: this service has exchange prices only.',
      'request.earnings is not available here: this service has exchange prices only.',
    ]);
  });

  it('finds order shapes the minute backtest stops on', () => {
    const source = script([
      'strategy.entry("L", strategy.long, oca_name="g")',
      'strategy.exit("T", "L", trail_points=100)',
      'strategy.exit("X", "L", profit=200, loss=100, oca_name="g")',
      'strategy.exit("Y", "L", trail_points=100, trail_offset=20)',
      'strategy.close("L", immediately=true)',
    ].join('\n'));
    expect(levels(source)).toEqual(['stop:backtest:4', 'stop:backtest:5', 'stop:backtest:7']);
  });

  it('warns about per-tick settings and realtime-only code', () => {
    const source = script('varip int ticks = 0\nif barstate.isrealtime\n    ticks += 1\nlabel.new(bar_index, high, str.tostring(timenow))',
      'strategy("T", calc_on_every_tick=true, calc_on_order_fills = true)');
    expect(levels(source)).toEqual(['differs:all:2', 'differs:all:2', 'differs:paper:3', 'differs:paper:4', 'differs:paper:6']);
  });

  it('ignores comments, strings and unfinished calls', () => {
    const source = script([
      '// request.security("BINANCE:ETHUSDT", "60", close)',
      'note = "request.financial(x) and varip and timenow"',
      'x = request.security("BINANCE:ETHUSDT"',
    ].join('\n'));
    expect(pineCompatibility(source, { chartSymbol: 'BTCUSDT' })).toEqual([]);
  });
});

describe('POST /api/pine/check', () => {
  it('returns the code error and the compatibility issues for the editor', async () => {
    const { buildApp } = await import('../apps/api/src/server');
    const app = await buildApp({});
    try {
      const ok = await app.inject({ method: 'POST', url: '/api/pine/check', payload: {
        source: script('x = request.security("BINANCE:ETHUSDT", "60", close)'), symbol: 'BTCUSDT', timeframe: '1h' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ codeError: null, issues: [{ level: 'stop', line: 3, where: 'all' }] });

      const indicator = await app.inject({ method: 'POST', url: '/api/pine/check', payload: { source: '//@version=6\nindicator("I")\nplot(close)\n' } });
      expect(indicator.json().codeError).toContain('indicator');

      const invalid = await app.inject({ method: 'POST', url: '/api/pine/check', payload: { source: 'x', timeframe: '2h' } });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
