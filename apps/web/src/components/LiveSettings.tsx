import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { LiveConnectionCheck, LiveSettingsView } from '../../../../packages/shared/src/paper-experiment-contracts';
import { checkLiveConnection, loadLiveSettings, removeLiveKey, saveLiveSettings } from '../lib/api';
import { InfoTooltip } from './TranslatedText';

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Where the key lives and what it can do: shown above the key field. */
export const LIVE_KEY_PRIVACY_NOTE = 'Your API key is stored only on the machine that runs Pine Strategy Runner (your computer in the '
  + 'Docker version), in the app\'s data folder, readable by the app only. It is never shown again and never sent to us or '
  + 'anyone else: the app signs your orders with it and sends only the signed orders to Lighter. A Lighter API key can '
  + 'trade and can withdraw only back to your own wallet; it cannot send funds to another address. Use a separate Lighter '
  + 'account with a small balance.';

/** Connecting a Lighter account for LIVE trading: exchange, account index, API key index, API private key. */
export function LiveSettingsPanel({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<LiveSettingsView | null>(null);
  const [accountIndex, setAccountIndex] = useState('');
  const [apiKeyIndex, setApiKeyIndex] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<'save' | 'check' | 'remove' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [check, setCheck] = useState<LiveConnectionCheck | null>(null);

  const apply = (next: LiveSettingsView) => {
    setSettings(next);
    setAccountIndex(next.accountIndex === null ? '' : String(next.accountIndex));
    setApiKeyIndex(next.apiKeyIndex === null ? '' : String(next.apiKeyIndex));
    // Someone filling in a new key means to switch LIVE on.
    setEnabled(next.keySaved ? next.enabled : true);
  };

  useEffect(() => {
    const controller = new AbortController();
    loadLiveSettings(controller.signal).then(apply).catch((reason) => {
      if (!controller.signal.aborted) setError(errorText(reason));
    });
    return () => controller.abort();
  }, []);

  const run = async (kind: 'save' | 'check' | 'remove', action: () => Promise<void>) => {
    setBusy(kind);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };

  const save = () => run('save', async () => {
    const next = await saveLiveSettings({
      exchange: 'lighter', enabled,
      accountIndex: Number(accountIndex.trim()), apiKeyIndex: Number(apiKeyIndex.trim()),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    apply(next);
    setApiKey('');
    setMessage(next.enabled ? 'Saved. LIVE mode is on.' : 'Saved. LIVE mode is off.');
    onChanged();
  });

  const testConnection = () => run('check', async () => {
    setCheck(null);
    setCheck(await checkLiveConnection());
  });

  const remove = () => {
    if (!window.confirm('Remove the saved Lighter API key from this machine? LIVE mode switches off.')) return;
    void run('remove', async () => {
      apply(await removeLiveKey());
      setCheck(null);
      setMessage('The key was removed from this machine.');
      onChanged();
    });
  };

  if (!settings) {
    return <div className="paper-live-settings">{error ? <p className="paper-launch-error" role="alert">{error}</p> : <p>Loading LIVE settings…</p>}</div>;
  }
  return <div className="paper-live-settings" aria-label="LIVE settings">
    <p className="paper-live-privacy" role="note"><ShieldCheck size={16} /><span>{LIVE_KEY_PRIVACY_NOTE}</span></p>
    {settings.disabledByServer && <p className="paper-launch-error" role="status">LIVE trading is switched off on this server by its operator.</p>}
    <div className="paper-form-grid">
      <label><span>Exchange</span>
        <select value="lighter" aria-label="LIVE exchange" onChange={() => undefined}><option value="lighter">Lighter</option></select></label>
      <label><span>Account index <InfoTooltip label="account index" en="The number of your Lighter account (your main account or a sub-account)." ru="Номер вашего счёта Lighter (основного или субаккаунта)." /></span>
        <input type="text" inputMode="numeric" value={accountIndex} aria-label="Account index" onChange={(event) => setAccountIndex(event.target.value)} /></label>
      <label><span>API key index <InfoTooltip label="API key index" en="The index of the API key you created on Lighter: 4 to 254 (0 to 3 belong to Lighter's own apps)." ru="Индекс API-ключа, созданного на Lighter: от 4 до 254 (0–3 заняты приложениями Lighter)." /></span>
        <input type="text" inputMode="numeric" value={apiKeyIndex} aria-label="API key index" onChange={(event) => setApiKeyIndex(event.target.value)} /></label>
      <label><span>API private key</span>
        <input type="password" autoComplete="off" spellCheck={false} value={apiKey} aria-label="API private key"
          placeholder={settings.keySaved ? 'saved — leave empty to keep it' : 'paste the private key of the API key'}
          onChange={(event) => setApiKey(event.target.value)} /></label>
    </div>
    <label className="paper-live-confirm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      Enable LIVE mode (real orders with real money)</label>
    <div className="paper-live-settings-actions">
      <button type="button" className="paper-text-button" disabled={busy !== null} onClick={() => { void save(); }}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      {settings.keySaved && <button type="button" className="paper-text-button" disabled={busy !== null} onClick={() => { void testConnection(); }}>
        {busy === 'check' ? 'Checking… (up to a minute)' : 'Check connection'}</button>}
      {settings.keySource === 'app' && <button type="button" className="paper-text-button" disabled={busy !== null} onClick={remove}>Remove key</button>}
    </div>
    <p className="paper-card-footnote">{settings.keySaved
      ? (settings.keySource === 'server' ? 'A key is set up by this server\'s operator. Saving here replaces it for this app.' : 'A key is saved on this machine.')
      : 'No key saved yet.'}</p>
    {message && <p className="paper-card-footnote" role="status">{message}</p>}
    {error && <p className="paper-launch-error" role="alert">{error}</p>}
    {check && (check.ok
      ? <p className="paper-live-check-ok" role="status">Connected to Lighter: balance {check.balance ?? '—'} USDC, {check.openPositions} open position(s), {check.openOrders} open order(s). Nothing was traded.</p>
      : <p className="paper-launch-error" role="alert">Connection failed: {check.error}</p>)}
  </div>;
}
