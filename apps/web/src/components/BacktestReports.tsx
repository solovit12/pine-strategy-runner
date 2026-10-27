import { FileSpreadsheet, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BacktestRequest, BacktestResponse } from '../../../../packages/shared/src/contracts';
import { BACKTEST_RUNS_SHEET, TELEGRAM_CAPTION_LIMIT, type BacktestReport, type ReportSettingsView } from '../../../../packages/shared/src/report-contracts';
import type { StrategyDetail } from '../../../../packages/shared/src/strategy-catalog-contracts';
import {
  addBacktestToSheet, loadReportSettings, postBacktestToTelegram, saveGoogleReportSettings, saveStrategyVersion, saveTelegramReportSettings,
} from '../lib/api';
import { buildBacktestReport, equityCurve, reportCaption, reportStrategy, validSourceUrl } from '../lib/backtest-report';
import { canvasPngBase64, drawReportImage } from '../lib/report-image';

type Action = 'sheet' | 'telegram';
type Dialog = null | 'google' | 'telegram-setup' | 'source' | 'preview';
interface Notice { readonly text: string; readonly link?: { readonly href: string; readonly label: string }; readonly error?: boolean }

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

// When each result first appeared: the report's date stays the same when the page is reopened.
const firstSeen = new WeakMap<BacktestResponse, string>();
function seenAt(result: BacktestResponse): string {
  if (!firstSeen.has(result)) firstSeen.set(result, new Date().toISOString());
  return firstSeen.get(result)!;
}

export interface BacktestReportsProps {
  readonly result: BacktestResponse;
  /** The request this result came from. */
  readonly request: BacktestRequest;
  readonly loadedStrategy: StrategyDetail | null;
  /** The source link was saved into the library strategy. */
  readonly onStrategySaved: (detail: StrategyDetail) => void;
}

/** Under a finished backtest (private edition): a row in the owner's Google Sheet and a picture post in the owner's Telegram channel. */
export function BacktestReports({ result, request, loadedStrategy, onStrategySaved }: BacktestReportsProps) {
  const [settings, setSettings] = useState<ReportSettingsView | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [sourceOverride, setSourceOverride] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [saveSourceToLibrary, setSaveSourceToLibrary] = useState(true);
  const [sheetDraft, setSheetDraft] = useState('');
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [channelDraft, setChannelDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [caption, setCaption] = useState('');
  const [preview, setPreview] = useState<BacktestReport | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadReportSettings(controller.signal).then(setSettings).catch((reason: unknown) => {
      if (!controller.signal.aborted) setNotice({ text: `Report settings could not load: ${errorText(reason)}`, error: true });
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (dialog !== 'preview' || !preview || !canvasRef.current) return;
    drawReportImage(canvasRef.current, preview, equityCurve(result));
  }, [dialog, preview, result]);

  const strategy = reportStrategy(request, loadedStrategy);
  const sourceUrl = validSourceUrl(strategy.sourceUrl) ? strategy.sourceUrl : sourceOverride;
  const close = () => { if (!busy) { setDialog(null); setDialogError(''); } };

  /** Runs the action, first asking for whatever is missing: the connection, then the source link. */
  const start = async (action: Action, current: ReportSettingsView | null = settings, link = sourceUrl) => {
    setNotice(null);
    setDialogError('');
    setPending(action);
    if (!current) return;
    if (action === 'sheet' && !current.google.connected) { setSheetDraft(''); setKeyFile(null); setDialog('google'); return; }
    if (action === 'telegram' && !current.telegram.connected) { setChannelDraft(''); setTokenDraft(''); setDialog('telegram-setup'); return; }
    if (!validSourceUrl(link)) { setSourceDraft(link); setDialog('source'); return; }
    const value = buildBacktestReport(result, request, { ...strategy, sourceUrl: link }, seenAt(result));
    if (action === 'telegram') {
      setPreview(value);
      setCaption(reportCaption(value));
      setDialog('preview');
      return;
    }
    setDialog(null);
    setBusy(true);
    try {
      const row = await addBacktestToSheet(value);
      // A duplicate is not added: said in red so it is not mistaken for a new row.
      setNotice({ text: `${row.status === 'added' ? `Added to ${BACKTEST_RUNS_SHEET}, row ${row.row}.`
        : row.status === 'already' ? `Duplicate, not added: this backtest is already in ${BACKTEST_RUNS_SHEET}, row ${row.row}.`
          : `Duplicate, not added: the same test is already in ${BACKTEST_RUNS_SHEET}, row ${row.row} (same strategy, market, period, settings and results).`}`
        + `${row.styleError ? ` The sheet's look was not applied: ${row.styleError}` : ''}`,
        error: row.status !== 'added' || Boolean(row.styleError), link: { href: row.url, label: 'Open the sheet' } });
    } catch (reason) {
      setNotice({ text: errorText(reason), error: true });
    } finally { setBusy(false); }
  };

  const connectGoogle = async () => {
    setBusy(true);
    setDialogError('');
    try {
      const next = await saveGoogleReportSettings({ sheet: sheetDraft.trim(), ...(keyFile ? { serviceAccountKey: await keyFile.text() } : {}) });
      setSettings(next);
      setDialog(null);
      if (pending) await start(pending, next);
    } catch (reason) {
      setDialogError(errorText(reason));
    } finally { setBusy(false); }
  };

  const connectTelegram = async () => {
    setBusy(true);
    setDialogError('');
    try {
      const next = await saveTelegramReportSettings({ channel: channelDraft.trim(), ...(tokenDraft.trim() ? { botToken: tokenDraft.trim() } : {}) });
      setSettings(next);
      setTokenDraft('');
      setDialog(null);
      if (pending) await start(pending, next);
    } catch (reason) {
      setDialogError(errorText(reason));
    } finally { setBusy(false); }
  };

  const useSource = async () => {
    const link = sourceDraft.trim();
    if (!validSourceUrl(link)) { setDialogError('Paste the full link, starting with https://'); return; }
    setBusy(true);
    setDialogError('');
    try {
      if (loadedStrategy && saveSourceToLibrary) {
        // Only the link changes: the saved code and settings stay as they are.
        const { version, strategy: saved } = loadedStrategy;
        onStrategySaved(await saveStrategyVersion(saved.id, {
          name: version.name, source: version.source, backtestSettings: version.backtestSettings, paperSettings: version.paperSettings,
          metadata: { ...version.metadata, sourceReference: link }, expectedVersion: saved.currentVersion,
        }));
      }
      setSourceOverride(link);
      setDialog(null);
    } catch (reason) {
      setDialogError(`The link could not be saved to the strategy: ${errorText(reason)}`);
      return;
    } finally { setBusy(false); }
    if (pending) await start(pending, settings, link);
  };

  const send = async () => {
    if (!preview || !canvasRef.current) return;
    setBusy(true);
    setDialogError('');
    try {
      const posted = await postBacktestToTelegram({ report: preview, caption: caption.trim(), imagePngBase64: canvasPngBase64(canvasRef.current) });
      setDialog(null);
      const sheetText = posted.sheet ? ` The post link is in ${BACKTEST_RUNS_SHEET}, row ${posted.sheet.row}.`
        : posted.sheetError ? ` The sheet was not updated: ${posted.sheetError}` : '';
      setNotice({ text: `Posted to ${settings?.telegram.channelTitle ?? 'the channel'}.${sheetText}`, error: Boolean(posted.sheetError),
        ...(posted.messageUrl ? { link: { href: posted.messageUrl, label: 'Open the post' } } : {}) });
    } catch (reason) {
      setDialogError(errorText(reason));
    } finally { setBusy(false); }
  };

  const download = () => {
    if (!canvasRef.current || !preview) return;
    const link = document.createElement('a');
    link.href = canvasRef.current.toDataURL('image/png');
    link.download = `backtest-${preview.symbol}-${preview.timeframe}-${preview.dateRange.end}.png`;
    link.click();
  };

  return (
    <section className="report-actions" aria-label="Backtest report">
      <div className="report-buttons">
        <button type="button" onClick={() => { void start('sheet'); }} disabled={busy || !settings}><FileSpreadsheet size={15} />Add to Google Sheet</button>
        <button type="button" onClick={() => { void start('telegram'); }} disabled={busy || !settings}><Send size={15} />Telegram post</button>
      </div>
      <div className="report-status">
        {notice ? <p className={notice.error ? 'report-notice error' : 'report-notice'} role="status">{notice.text}
          {notice.link && <> <a href={notice.link.href} target="_blank" rel="noreferrer">{notice.link.label}</a></>}</p>
          : busy ? <p className="report-notice" role="status">Sending…</p> : null}
        {settings && <p className="report-connections">
          <span>Sheet: {settings.google.connected ? <a href={settings.google.sheetUrl!} target="_blank" rel="noreferrer">{settings.google.spreadsheetTitle}</a> : 'not connected'}</span>
          <button type="button" onClick={() => { setPending(null); setSheetDraft(settings.google.sheetUrl ?? ''); setKeyFile(null); setDialogError(''); setDialog('google'); }} disabled={busy}>{settings.google.connected ? 'Change' : 'Connect'}</button>
          <span>Channel: {settings.telegram.connected ? settings.telegram.channelTitle : 'not connected'}</span>
          <button type="button" onClick={() => { setPending(null); setChannelDraft(settings.telegram.channel ?? ''); setTokenDraft(''); setDialogError(''); setDialog('telegram-setup'); }} disabled={busy}>{settings.telegram.connected ? 'Change' : 'Connect'}</button>
        </p>}
      </div>

      {dialog && <div className="strategy-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
        <section className={`strategy-dialog report-dialog${dialog === 'preview' ? ' report-preview-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="report-dialog-title">
          <header className="strategy-dialog-heading">
            <h3 id="report-dialog-title">{dialog === 'google' ? 'Connect Google Sheet' : dialog === 'telegram-setup' ? 'Connect Telegram channel'
              : dialog === 'source' ? 'Strategy source link' : 'Telegram post'}</h3>
            <button type="button" onClick={close} disabled={busy}>Close</button>
          </header>

          {dialog === 'google' && <form onSubmit={(event) => { event.preventDefault(); void connectGoogle(); }}>
            <ol className="report-steps">
              <li>In Google Cloud create a robot account (IAM → Service accounts) and a JSON key for it; switch on the Google Sheets API.</li>
              <li>In your Google Sheet press Share, add the robot's email{settings?.google.robotEmail ? <> (<code>{settings.google.robotEmail}</code>)</> : null} and choose Editor.</li>
              <li>Paste the sheet's link and choose the key file below. Svit Runner adds the {BACKTEST_RUNS_SHEET} sheet itself.</li>
            </ol>
            <label className="strategy-save-name"><span>Sheet link</span>
              <input autoFocus value={sheetDraft} onChange={(event) => setSheetDraft(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" disabled={busy} /></label>
            <label className="strategy-save-name report-field"><span>Robot key file (.json)</span>
              <input type="file" accept=".json,application/json" onChange={(event) => setKeyFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
            <p className="strategy-save-hint">{settings?.google.connected ? 'A key is already saved; choose a file only to replace it. ' : ''}
              The key is stored only on this server, in the app's data folder, readable by the app only. It is never shown again.</p>
            {dialogError && <p className="strategy-save-error" role="alert">{dialogError}</p>}
            <div className="strategy-dialog-actions"><button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button className="primary" type="submit" disabled={busy || !sheetDraft.trim() || (!keyFile && !settings?.google.connected)}>{busy ? 'Checking…' : 'Check and save'}</button></div>
          </form>}

          {dialog === 'telegram-setup' && <form onSubmit={(event) => { event.preventDefault(); void connectTelegram(); }}>
            <ol className="report-steps">
              <li>In Telegram open @BotFather, send /newbot and copy the token it gives.</li>
              <li>Add the bot to your channel as an administrator with the right to post messages.</li>
              <li>Enter the channel and the token below.</li>
            </ol>
            <label className="strategy-save-name"><span>Channel</span>
              <input autoFocus value={channelDraft} onChange={(event) => setChannelDraft(event.target.value)} placeholder="@yourchannel or -100…" disabled={busy} /></label>
            <label className="strategy-save-name report-field"><span>Bot token</span>
              <input type="password" autoComplete="off" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)}
                placeholder={settings?.telegram.connected ? 'Saved; enter only to replace it' : '123456789:AA…'} disabled={busy} /></label>
            <p className="strategy-save-hint">The token is stored only on this server, in the app's data folder, readable by the app only. It is never shown again.</p>
            {dialogError && <p className="strategy-save-error" role="alert">{dialogError}</p>}
            <div className="strategy-dialog-actions"><button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button className="primary" type="submit" disabled={busy || !channelDraft.trim() || (!tokenDraft.trim() && !settings?.telegram.connected)}>{busy ? 'Checking…' : 'Check and save'}</button></div>
          </form>}

          {dialog === 'source' && <form onSubmit={(event) => { event.preventDefault(); void useSource(); }}>
            <p className="strategy-save-hint report-lead">Every report shows where the strategy comes from. Paste the link to its page, for example on TradingView.</p>
            <label className="strategy-save-name report-field"><span>Source link</span>
              <input autoFocus value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} placeholder="https://www.tradingview.com/script/…" disabled={busy} /></label>
            {loadedStrategy && <label className="report-checkbox"><input type="checkbox" checked={saveSourceToLibrary} onChange={(event) => setSaveSourceToLibrary(event.target.checked)} disabled={busy} />
              <span>Save it to {loadedStrategy.version.name} in the library (its code and settings stay as saved)</span></label>}
            {dialogError && <p className="strategy-save-error" role="alert">{dialogError}</p>}
            <div className="strategy-dialog-actions"><button type="button" onClick={close} disabled={busy}>Cancel</button>
              <button className="primary" type="submit" disabled={busy || !sourceDraft.trim()}>Continue</button></div>
          </form>}

          {dialog === 'preview' && preview && <div className="report-preview">
            <canvas ref={canvasRef} className="report-canvas" aria-label="Report picture" />
            <div className="report-caption">
              <label className="strategy-save-name"><span>Post text ({caption.length}/{TELEGRAM_CAPTION_LIMIT})</span>
                <textarea value={caption} onChange={(event) => setCaption(event.target.value)} maxLength={TELEGRAM_CAPTION_LIMIT} rows={16} disabled={busy} /></label>
              <p className="strategy-save-hint">Goes to {settings?.telegram.channelTitle ?? 'the channel'}. The run's row in the sheet gets the post link.</p>
              {dialogError && <p className="strategy-save-error" role="alert">{dialogError}</p>}
              <div className="strategy-dialog-actions"><button type="button" onClick={download} disabled={busy}>Download picture</button>
                <button className="primary" type="button" onClick={() => { void send(); }} disabled={busy || !caption.trim()}>{busy ? 'Sending…' : 'Send to channel'}</button></div>
            </div>
          </div>}
        </section>
      </div>}
    </section>
  );
}
