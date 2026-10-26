import { AlertTriangle, Gauge, OctagonX } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  forecastRun, limitLevel, loadPercent, runLoadPlan, viewLevel, type ExchangeLoadView,
} from '../../../../packages/shared/src/exchange-load';
import { loadExchangeLoad } from '../lib/api';

const REFRESH_MS = 30_000;

/** One shared poll of the engine's exchange-load counter for every component that shows it. */
let current: ExchangeLoadView | null = null;
const listeners = new Set<(view: ExchangeLoadView | null) => void>();
let timer: number | null = null;

async function refresh(): Promise<void> {
  try {
    current = await loadExchangeLoad(AbortSignal.timeout(15_000));
  } catch {
    current = null; // no engine, or an older one without the counter: show nothing
  }
  for (const listener of listeners) listener(current);
}

export function useExchangeLoad(enabled = true): ExchangeLoadView | null {
  const [view, setView] = useState<ExchangeLoadView | null>(current);
  useEffect(() => {
    if (!enabled) return undefined;
    listeners.add(setView);
    if (timer === null) {
      void refresh();
      timer = window.setInterval(() => { void refresh(); }, REFRESH_MS);
    } else setView(current);
    return () => {
      listeners.delete(setView);
      if (listeners.size === 0 && timer !== null) { window.clearInterval(timer); timer = null; }
    };
  }, [enabled]);
  return enabled ? view : null;
}

/** Header: the fullest limit; a click opens the table on the Accounts page. */
export function ExchangeLimitsChip({ view, onOpen }: { view: ExchangeLoadView | null; onOpen: () => void }) {
  if (!view) return null;
  const level = viewLevel(view);
  return <button type="button" className={`exchange-limits-chip ${level}`} onClick={onOpen}
    title="How much of the exchanges' request limits this server uses. Open the table">
    <Gauge size={13} aria-hidden="true" />Exchange limits {loadPercent(view)} %</button>;
}

const amount = (value: number) => value.toLocaleString('en-US');

export function ExchangeLimitsPanel({ view }: { view: ExchangeLoadView | null }) {
  return <section className="paper-card exchange-limits" id="exchange-limits" aria-labelledby="exchange-limits-title">
    <span className="eyebrow">EXCHANGE LIMITS · THIS SERVER</span>
    <h2 id="exchange-limits-title">Exchange limits</h2>
    <p>The exchanges limit how often one server address may ask them, and how many orders one account may send.
      Every run on this server shares the server's limits. Green: under 70 %, amber: 70–90 %, red: over 90 % or the
      exchange answered "too many requests" in the last hour.</p>
    {!view ? <p className="paper-card-footnote">The counter is not available: the Paper engine is not connected.</p>
      : <div className="exchange-limits-table-wrap"><table className="exchange-limits-table">
        <thead><tr><th>Limit</th><th>Counted by</th><th>Used</th><th>Who uses it</th></tr></thead>
        <tbody>{view.rows.map((row) => {
          const level = limitLevel(row);
          const share = Math.min(100, row.limit > 0 ? (row.used / row.limit) * 100 : 0);
          return <tr key={`${row.key}:${row.account ?? ''}`} className={level}>
            <td>{row.label}</td>
            <td>{row.scope === 'server' ? 'server address' : `account ${row.account}`}</td>
            <td>
              <strong>{amount(row.used)} / {amount(row.limit)}{row.perMinute ? ' a minute' : ''}</strong>
              <span className="exchange-limits-bar" aria-hidden="true"><i style={{ width: `${share}%` }} /></span>
              <small>{row.perMinute ? 'busiest minute of the last hour' : row.scope === 'server' ? 'now' : 'so far'}</small>
              {row.refusedAt && <small className="refused">Exchange answered "too many requests" at {new Date(row.refusedAt).toLocaleTimeString()}</small>}
            </td>
            <td>{row.parts.filter((part) => part.value > 0).map((part) => `${part.label} ${part.value}`).join(', ') || '—'}
              {row.note && <small>{row.note}</small>}</td>
          </tr>;
        })}</tbody>
      </table></div>}
    {view && <p className="paper-card-footnote">
      {view.otherProgramsVisible ? "Other programs' Hyperliquid connections on this server are counted too. " : ''}
      Requests the exchange clients make when a run starts or reconnects are not counted: keep some room.</p>}
  </section>;
}

/** Before a launch: what the run adds; a Live run that Hyperliquid would refuse connections to cannot start. */
export function ExchangeLimitsForecast({ settings }: {
  settings: { readonly tracks: readonly { readonly venue: string }[]; readonly live?: unknown };
}) {
  const view = useExchangeLoad(settings.tracks.length > 0);
  if (!view) return null;
  const forecast = forecastRun(view, runLoadPlan(settings));
  if (!forecast.refusal && forecast.warnings.length === 0) return null;
  return <div className={forecast.refusal ? 'exchange-limits-forecast over' : 'exchange-limits-forecast'} role="note">
    {forecast.refusal ? <OctagonX size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
    <div>
      <strong>{forecast.refusal ? 'Exchange limit: this LIVE run cannot start' : 'Exchange limits are close'}</strong>
      {forecast.refusal ? <span>{forecast.refusal}</span>
        : <span>{forecast.warnings.join(' ')} The exchange may slow down or refuse requests; the engine waits and repeats them.</span>}
    </div>
  </div>;
}
