import { AlertTriangle, CheckCircle2, OctagonX, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BacktestTimeframe, PineCheckResponse } from '../../../../packages/shared/src/contracts';
import { convertPineForService, pineFixAvailable, type PineConversion } from '../../../../packages/shared/src/pine-v4-to-v5';
import { checkPineCode } from '../lib/api';

/** Wait after the last keystroke before asking the server. */
export const PINE_CHECK_DELAY_MS = 600;

const WHERE: Record<PineCheckResponse['issues'][number]['where'], string> = {
  all: '', backtest: 'Backtest', paper: 'Paper',
};

const FIX = {
  v4: { problem: 'This is Pine v4 code; the service runs v5 and v6.', button: 'Convert to v5', done: 'Converted to Pine v5' },
  when: { problem: 'Order conditions (when) are ignored here, so these orders would go out on every bar.', button: 'Move conditions into if', done: 'Order conditions moved into if' },
} as const;

/**
 * Compatibility of the editor's Pine code with this service, checked a moment after each edit:
 * red stops the run, amber may differ from TradingView. A hint only: it never blocks a run.
 * For Pine v4 code (and `when` conditions on orders) it offers to rewrite the code in the editor.
 */
export function PineCheck({ source, symbol, timeframe, onGoToLine, onReplaceSource }: {
  source: string; symbol: string; timeframe: BacktestTimeframe; onGoToLine?: (line: number) => void;
  /** Puts rewritten code into the editor (undoable there). */
  onReplaceSource?: (next: string) => void;
}) {
  const [result, setResult] = useState<PineCheckResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [converted, setConverted] = useState<{ kind: keyof typeof FIX; conversion: PineConversion } | null>(null);
  const fix = onReplaceSource ? pineFixAvailable(source) : null;
  const shown = converted && converted.conversion.source === source ? converted : null;

  useEffect(() => {
    if (!source.trim()) { setResult(null); setFailed(false); return; }
    const controller = new AbortController();
    setChecking(true);
    const timer = window.setTimeout(() => {
      checkPineCode({ source, symbol, timeframe }, controller.signal)
        .then((next) => { setResult(next); setFailed(false); })
        .catch((error) => { if (!controller.signal.aborted) { setFailed(true); console.warn('Pine check unavailable', error); } })
        .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    }, PINE_CHECK_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source, symbol, timeframe]);

  if (!source.trim()) return null;
  const issues = result?.issues ?? [];
  const stops = issues.filter((issue) => issue.level === 'stop').length + (result?.codeError ? 1 : 0);
  const differs = issues.length - issues.filter((issue) => issue.level === 'stop').length;
  const summary = failed ? 'Check unavailable'
    : !result ? 'Checking…'
      : stops + differs === 0 ? 'No problems found'
        : [stops ? `${stops} will stop the run` : '', differs ? `${differs} may differ from TradingView` : ''].filter(Boolean).join(' · ');
  const tone = failed || !result ? 'idle' : stops ? 'stop' : differs ? 'differs' : 'ok';

  return <section className="pine-check" aria-label="Code compatibility" aria-busy={checking}>
    <div className={`pine-check-summary ${tone}`} role="status">
      {tone === 'ok' ? <CheckCircle2 size={14} /> : tone === 'stop' ? <OctagonX size={14} /> : tone === 'differs' ? <AlertTriangle size={14} /> : null}
      <span>Compatibility: {summary}</span>
    </div>
    {fix && onReplaceSource && <div className="pine-check-fix">
      <span>{FIX[fix].problem}</span>
      <button type="button" onClick={() => {
        const conversion = convertPineForService(source);
        setConverted({ kind: fix, conversion });
        onReplaceSource(conversion.source);
      }}><Wand2 size={13} />{FIX[fix].button}</button>
    </div>}
    {shown && <div className="pine-check-converted" role="status">
      <span>{FIX[shown.kind].done}: {shown.conversion.changes} {shown.conversion.changes === 1 ? 'change' : 'changes'}. Check the code and run a backtest; Ctrl+Z (⌘Z) in the editor undoes it.</span>
      {shown.conversion.notes.length > 0 && <ul>{shown.conversion.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
    </div>}
    {result && !failed && (result.codeError || issues.length > 0) && <ul className="pine-check-list">
      {result.codeError && <li className="stop">{result.codeError}</li>}
      {issues.map((issue, index) => <li key={`${issue.line}-${index}`} className={issue.level}>
        {onGoToLine
          ? <button type="button" className="pine-check-line" onClick={() => onGoToLine(issue.line)}>Line {issue.line}</button>
          : <span className="pine-check-line">Line {issue.line}</span>}
        <span>{issue.message}</span>
        {WHERE[issue.where] && <small>{WHERE[issue.where]} only</small>}
      </li>)}
    </ul>}
  </section>;
}
