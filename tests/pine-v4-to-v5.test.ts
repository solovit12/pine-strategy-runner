import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Indicator, PineTS } from 'pinets';
import { FrozenCsvMarketDataProvider } from './fixtures/frozen-csv-provider.js';
import { normalizeStrategy } from '../packages/pine-runtime/src/normalize.js';
import { pineCodeError } from '../packages/pine-runtime/src/pine-errors.js';
import { convertPineForService, pineFixAvailable, pineWhenLine } from '../packages/shared/src/pine-v4-to-v5.js';

const v4 = (body: string) => `//@version=4\nstrategy("T", overlay=true)\n${body}\n`;
const converted = (body: string) => convertPineForService(v4(body)).source.split('\n').slice(2, -1).join('\n');
const fixture = (name: string) => readFile(new URL(`./fixtures/pine-v4/${name}`, import.meta.url), 'utf8');

describe('Pine v4 → v5 converter', () => {
  it('converts a typical v4 strategy as TradingView would, and the result runs here', async () => {
    const result = convertPineForService(await fixture('atr-trail-v4.pine'));
    expect(result.source).toBe(await fixture('atr-trail-v5.expected.pine'));
    expect(result.notes).toEqual([]);
    expect(pineCodeError(result.source)).toBeNull();

    const base = 'binance-btcusdt-1h-20241231T230000Z-20260901T020000Z';
    const provider = new FrozenCsvMarketDataProvider(
      fileURLToPath(new URL(`./fixtures/qualification/data/${base}.csv`, import.meta.url)),
      fileURLToPath(new URL(`./fixtures/qualification/data/${base}.metadata.json`, import.meta.url)),
    );
    const candles = (await provider.getSnapshot()).candles.slice(0, 1000);
    const strategy = new Indicator(result.source);
    strategy.prop.initial_capital = 100_000;
    strategy.prop.default_qty_type = 'fixed';
    strategy.prop.default_qty_value = 1;
    const context = await new PineTS(candles as never, 'BINANCE:BTCUSDT', '60').run(strategy) as any;
    const { trades } = normalizeStrategy(context.strategy);
    // Orders only where the old when= condition held: far fewer trades than bars.
    expect(trades.length).toBeGreaterThan(10);
    expect(trades.length).toBeLessThan(candles.length / 4);
  });

  it('moves functions into namespaces but keeps the script\'s own names', () => {
    expect(converted('a = sma(close, 10) + max(1, 2) + cum(volume)\nb = security(syminfo.tickerid, "D", close)'))
      .toBe('a = ta.sma(close, 10) + math.max(1, 2) + ta.cum(volume)\nb = request.security(syminfo.tickerid, "D", close)');
    expect(converted('x = tr + vwap\ny = tr(true)')).toBe('x = ta.tr + ta.vwap\ny = ta.tr(true)');
    expect(converted('tr = high - low\nx = tr * 2')).toBe('tr = high - low\nx = tr * 2');
    expect(converted('atr(n) => sma(high - low, n)\nx = atr(14)')).toBe('atr(n) => ta.sma(high - low, n)\nx = atr(14)');
    expect(converted('x = array.max(a) + strategy.position_size')).toBe('x = array.max(a) + strategy.position_size');
    expect(converted('str = "a"\ns = tostring(close) + str')).toBe('str_ = "a"\ns = str.tostring(close) + str_');
  });

  it('gives input() its type', () => {
    expect(converted([
      'a = input(14, "Length", input.integer, 1, 100)',
      'b = input(title="Src", type=input.source, defval=close)',
      'c = input("D", type=input.resolution)',
      'd = input("Fast", options=["Fast", "Slow"])',
      'e = input(1.5)',
      'f = input(close)',
      'g = input(color.red)',
      'h = input(2 * 7, minval=1)',
      'i = input(len, minval=1)',
    ].join('\n'))).toBe([
      'a = input.int(14, "Length", minval=1, maxval=100)',
      'b = input.source(title="Src", defval=close)',
      'c = input.timeframe("D")',
      'd = input.string("Fast", options=["Fast", "Slow"])',
      'e = input.float(1.5)',
      'f = input.source(close)',
      'g = input.color(color.red)',
      'h = input.int(2 * 7, minval=1)',
      'i = input(len, minval=1)',
    ].join('\n'));
    expect(convertPineForService(v4('i = input(len, minval=1)')).notes).toHaveLength(1);
  });

  it('rewrites iff, transp, study, true/false directions and lookahead', () => {
    expect(converted('x = iff(close > open, 1, iff(close < open, -1, 0))')).toBe('x = (close > open ? 1 : (close < open ? -1 : 0))');
    expect(converted('plot(x, color=color.red, transp=70)\nplot(x, "X", color.red, 1, plot.style_line, 0)\nfill(p1, p2, transp=90)'))
      .toBe('plot(x, color=color.new(color.red, 70))\nplot(x, "X", color.red, 1, plot.style_line)\nfill(p1, p2, color=color.new(color.blue, 90))');
    expect(convertPineForService('//@version=4\nstudy("S", resolution="60")\n').source).toBe('//@version=5\nindicator("S", timeframe="60")\n');
    expect(converted('strategy.order("A", long=close > open)\nstrategy.entry("B", strategy.short)'))
      .toBe('strategy.order("A", direction=(close > open) ? strategy.long : strategy.short)\nstrategy.entry("B", strategy.short)');
    expect(converted('x = security(syminfo.tickerid, "D", close, false, true)'))
      .toBe('x = request.security(syminfo.tickerid, "D", close, barmerge.gaps_off, barmerge.lookahead_on)');
  });

  it('moves when= into if, keeping the indentation, in v4 and v5 code', () => {
    expect(converted('if barstate.isconfirmed\n    strategy.close("L", when = close < open) // out\nstrategy.exit("X", "L", profit=10,\n   when=go)'))
      .toBe('if barstate.isconfirmed\n    if close < open\n        strategy.close("L") // out\nif go\n    strategy.exit("X", "L", profit=10)');
    const v5 = '//@version=5\nstrategy("T")\nstrategy.entry("L", strategy.long, when = ta.crossover(close, open))\nstrategy.close_all(when=true)\n';
    expect(pineFixAvailable(v5)).toBe('when');
    expect(pineWhenLine(v5)).toBe(3);
    const result = convertPineForService(v5);
    expect(result.source).toBe('//@version=5\nstrategy("T")\nif ta.crossover(close, open)\n    strategy.entry("L", strategy.long)\nstrategy.close_all()\n');
    expect(result.changes).toBe(2);
    expect(pineFixAvailable(result.source)).toBeNull();
    const inside = convertPineForService('//@version=5\nstrategy("T")\nx = go ? strategy.close("L", when=go) : na\n');
    expect(inside.notes).toHaveLength(1);
  });

  it('also moves the unnamed v4/v5 condition (strategy.close("L", cond)), but not in v6 or a comment', () => {
    const v5 = '//@version=5\nstrategy("T")\nstrategy.close("L", exitLong)\nstrategy.close_all(flat)\nstrategy.close("S", "reason")\n';
    expect(pineWhenLine(v5)).toBe(3);
    expect(convertPineForService(v5).source)
      .toBe('//@version=5\nstrategy("T")\nif exitLong\n    strategy.close("L")\nif flat\n    strategy.close_all()\nstrategy.close("S", "reason")\n');
    expect(converted('strategy.close("L", close < open)')).toBe('if close < open\n    strategy.close("L")');
    expect(pineWhenLine('//@version=6\nstrategy("T")\nstrategy.close("L", "reason")\nstrategy.close_all("done")\n')).toBeNull();
    expect(pineWhenLine('//@version=5\nstrategy("T")\nstrategy.close("S", "reason")\n')).toBeNull();
  });

  it('offers a fix only for v4 code or when=, and the run stops on when= with a clear message', () => {
    expect(pineFixAvailable(v4('x = 1'))).toBe('v4');
    expect(pineFixAvailable('//@version=6\nstrategy("T")\nstrategy.entry("L", strategy.long)\n')).toBeNull();
    expect(pineFixAvailable('//@version=3\nstrategy("T")\n')).toBeNull();
    expect(pineCodeError('//@version=6\nstrategy("T")\nstrategy.entry("L", strategy.long, when=close > open)\n')?.message)
      .toMatch(/^Line 3: the order's condition \(when\) is not supported here/);
    expect(pineCodeError(v4('x = 1'))?.message).toMatch(/press "Convert to v5" under the editor/);
  });
});
