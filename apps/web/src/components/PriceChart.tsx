import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestResponse } from '../../../../packages/shared/src/contracts';
import { buildTradeMarkers } from '../lib/chart-markers';
import { InfoTooltip } from './TranslatedText';

interface PriceChartProps {
  result: BacktestResponse | null;
  loading: boolean;
}

export function PriceChart({ result, loading }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !result) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#101416' }, textColor: '#b3bec2', fontSize: 14 },
      grid: { vertLines: { color: '#1b2225' }, horzLines: { color: '#1b2225' } },
      rightPriceScale: { borderColor: '#2a3337' },
      timeScale: { borderColor: '#2a3337', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: '#6f7d83' }, horzLine: { color: '#6f7d83' } },
    });
    const mintick = result.data.instrument.mintick;
    const precision = Math.max(0, Math.ceil(-Math.log10(mintick)));
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#39c78a', downColor: '#f05d5e', borderVisible: false,
      wickUpColor: '#39c78a', wickDownColor: '#f05d5e',
      priceFormat: { type: 'price', precision, minMove: mintick },
    });
    series.setData(result.chart.candles.map((candle): CandlestickData => ({
      ...candle,
      time: candle.time as UTCTimestamp,
    })));
    createSeriesMarkers(series, buildTradeMarkers(result.trades));
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, result.chart.candles.length - 2_200),
      to: result.chart.candles.length + 5,
    });
    const observer = new ResizeObserver(() => chart.applyOptions({
      width: container.clientWidth,
      height: container.clientHeight,
    }));
    observer.observe(container);
    return () => { observer.disconnect(); chart.remove(); };
  }, [result]);

  return (
    <div className="chart-shell">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">MARKET / RESULT</span>
          <h2>{result ? result.data.symbol : 'Binance Futures'} <small>{result ? `${result.data.timeframe} · Binance USDⓈ-M Perpetual` : 'Historical Binance candles'}</small></h2>
        </div>
        <div className="legend"><i className="long" />LONG <i className="exit" />EXIT</div>
      </div>
      <div ref={containerRef} className="chart-canvas">
        {!result && !loading && (
          <div className="chart-empty">
            <span>01</span>
            <strong>Chart waiting for the first run</strong>
            <p>Run a backtest <InfoTooltip label="chart preview" en="Candles and trade markers will appear here after the first run." ru="После первого запуска здесь появятся свечи и точки сделок." /></p>
          </div>
        )}
        {loading && <div className="chart-loading"><span />Loading candles and executing Pine…</div>}
      </div>
    </div>
  );
}
