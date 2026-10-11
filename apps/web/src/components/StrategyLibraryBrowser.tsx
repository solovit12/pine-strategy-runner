import { useEffect, useMemo, useState } from 'react';
import type { StrategyDetail, StrategySummary } from '../../../../packages/shared/src/strategy-catalog-contracts';
import { loadStrategy } from '../lib/api';
import { InfoTooltip } from './TranslatedText';
import './StrategyLibraryBrowser.css';

export interface StrategyLibraryBrowserProps {
  strategies: readonly StrategySummary[];
  initialSelectedStrategyId?: string;
  busy?: boolean;
  onLoadVersion: (detail: StrategyDetail) => void;
  /** Removes the strategy from the library; resolves once it is gone. */
  onDelete?: (strategy: StrategySummary) => Promise<void>;
}

export function filterStrategySummaries(strategies: readonly StrategySummary[], query: string): StrategySummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? strategies.filter((strategy) => strategy.name.toLocaleLowerCase().includes(needle))
    : [...strategies];
}

/** Python strategies are saved without Pine backtest settings; the preview must not assume them. */
export function backtestFacts(settings: StrategyDetail['version']['backtestSettings'] | Record<string, never>): { market: string; dates: string } {
  const pine = settings as Partial<StrategyDetail['version']['backtestSettings']>;
  if (!pine.symbol || !pine.timeframe || !pine.dateRange) return { market: 'No Pine backtest', dates: '—' };
  return { market: `${pine.symbol} · ${pine.timeframe}`, dates: `${pine.dateRange.start}–${pine.dateRange.end}` };
}

function utcDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function StrategyLibraryBrowser({
  strategies,
  initialSelectedStrategyId = '',
  busy = false,
  onLoadVersion,
  onDelete,
}: StrategyLibraryBrowserProps) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(initialSelectedStrategyId || strategies[0]?.id || '');
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => filterStrategySummaries(strategies, query), [strategies, query]);
  const selected = strategies.find((strategy) => strategy.id === selectedId) ?? null;
  const activeDetail = detail?.strategy.id === selectedId ? detail : null;

  useEffect(() => {
    if (selectedId && !strategies.some((strategy) => strategy.id === selectedId)) {
      setSelectedId('');
      setDetail(null);
    }
  }, [selectedId, strategies]);

  useEffect(() => {
    if (!selectedId && !query && strategies.length > 0) setSelectedId(strategies[0].id);
  }, [selectedId, query, strategies]);

  useEffect(() => {
    setConfirmDelete(false);
    if (!selected) return;
    let cancelled = false;
    setDetail(null);
    setError('');
    loadStrategy(selected.id).then((loaded) => { if (!cancelled) setDetail(loaded); }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [selected?.id, selected?.currentVersion]);

  const remove = async () => {
    if (!selected || !onDelete) return;
    setDeleting(true);
    setError('');
    try {
      await onDelete(selected);
      setConfirmDelete(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  };

  const paperTracks = activeDetail?.version.paperSettings.tracks ?? [];
  const hyperliquidCount = paperTracks.filter((track) => track.venue === 'Hyperliquid').length;
  const lighterCount = paperTracks.filter((track) => track.venue === 'Lighter').length;

  return (
    <section className="strategy-browser" aria-label="Saved strategies">
      <div className="strategy-browser-heading">
        <strong>Saved strategies <span>({strategies.length})</span></strong>
        <InfoTooltip
          label="saved strategies"
          en="Search by name, choose a strategy, then open its saved code and settings in the editor."
          ru="Найдите стратегию по имени, выберите её и откройте сохранённый код и настройки в редакторе."
        />
      </div>

      <label className="strategy-browser-search">
        <span>Search</span>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            if (selected && !filterStrategySummaries([selected], nextQuery).length) setSelectedId('');
          }}
          placeholder="Search by name"
        />
      </label>

      <div className="strategy-browser-grid">
        <div className="strategy-browser-list" aria-label="Strategy list">
          {strategies.length === 0 ? (
            <div className="strategy-browser-empty">No saved strategies yet.</div>
          ) : filtered.length === 0 ? (
            <div className="strategy-browser-empty">No matching strategies.</div>
          ) : filtered.map((strategy) => (
            <button
              className={`strategy-browser-row${strategy.id === selectedId ? ' selected' : ''}`}
              type="button"
              key={strategy.id}
              onClick={() => setSelectedId(strategy.id)}
              aria-pressed={strategy.id === selectedId}
            >
              <strong>{strategy.name}</strong>
              <span>Updated {utcDate(strategy.updatedAt)}</span>
            </button>
          ))}
        </div>

        <div className="strategy-browser-detail" aria-live="polite">
          {!selected ? <div className="strategy-browser-empty">Select a strategy to preview it.</div> : <>
            <h3>{selected.name}</h3>
            {error ? <p className="strategy-browser-error" role="alert">{error}</p> : null}
            {!activeDetail && !error ? <p className="strategy-browser-muted">Loading strategy…</p> : null}
            {activeDetail ? <>
              <p className="strategy-browser-version-label">Saved {utcDate(activeDetail.version.createdAt)}</p>
              {activeDetail.version.metadata.description ? <p className="strategy-browser-description">{activeDetail.version.metadata.description}</p> : null}
              <dl className="strategy-browser-facts">
                <div><dt>Backtest</dt><dd>{backtestFacts(activeDetail.version.backtestSettings).market}</dd></div>
                <div><dt>Paper markets</dt><dd>{paperTracks.length} ({hyperliquidCount} Hyperliquid, {lighterCount} Lighter)</dd></div>
              </dl>
              <button className="strategy-browser-load" type="button" disabled={busy || deleting} onClick={() => onLoadVersion(activeDetail)}>
                Open in editor
              </button>
              <details className="strategy-browser-disclosure" key={`details-${selected.id}`}>
                <summary>Details</summary>
                <dl className="strategy-browser-facts strategy-browser-extra-facts">
                  <div><dt>Backtest dates</dt><dd>{backtestFacts(activeDetail.version.backtestSettings).dates}</dd></div>
                  <div><dt>Paper timeframe</dt><dd>{activeDetail.version.paperSettings.timeframe}</dd></div>
                  {activeDetail.version.metadata.origin ? <div><dt>Origin</dt><dd>{activeDetail.version.metadata.origin}</dd></div> : null}
                  {activeDetail.version.metadata.fidelity ? <div><dt>Fidelity</dt><dd>{activeDetail.version.metadata.fidelity}</dd></div> : null}
                  {activeDetail.version.metadata.sourceReference ? <div><dt>Source reference</dt><dd>{activeDetail.version.metadata.sourceReference}</dd></div> : null}
                  <div><dt>Pine SHA-256</dt><dd><code>{activeDetail.version.sourceSha256}</code></dd></div>
                </dl>
              </details>
            </> : null}
            {onDelete && (confirmDelete ? (
              <div className="strategy-browser-delete-confirm" role="alert">
                <p>Delete <strong>{selected.name}</strong> from the library? This cannot be undone. Paper runs already started keep running and stay in the history.</p>
                <div>
                  <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
                  <button type="button" className="danger" onClick={() => { void remove(); }} disabled={deleting || busy}>{deleting ? 'Deleting…' : 'Delete'}</button>
                </div>
              </div>
            ) : (
              <button className="strategy-browser-delete" type="button" onClick={() => setConfirmDelete(true)} disabled={busy || deleting}>Delete strategy</button>
            ))}
          </>}
        </div>
      </div>
    </section>
  );
}
