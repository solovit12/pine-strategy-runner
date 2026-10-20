import { Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  LiveAccountView, LiveAccountsView, LiveConnectionCheck, LiveExchange,
} from '../../../../packages/shared/src/paper-experiment-contracts';
import { checkLiveAccount, createLiveAccount, loadLiveAccounts, removeLiveAccount, updateLiveAccount } from '../lib/api';
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

export const HYPERLIQUID_KEY_PRIVACY_NOTE = 'The API wallet key is stored only on the machine that runs Pine Strategy Runner, '
  + 'in the app\'s data folder, readable by the app only. It is never shown again and never sent to us or anyone else: the '
  + 'app signs your orders with it and sends only the signed orders to Hyperliquid. A Hyperliquid API wallet can trade for '
  + 'your account but cannot withdraw or transfer funds. Create it on Hyperliquid (More → API) and keep a small balance.';

export const EXCHANGE_NAMES: Record<LiveExchange, string> = { lighter: 'Lighter', hyperliquid: 'Hyperliquid' };

/** The account's exchange id as the page shows it. */
export function accountIdentity(account: LiveAccountView): string {
  return account.exchange === 'lighter'
    ? `Account ${account.accountIndex ?? '—'} · API key ${account.apiKeyIndex ?? '—'}`
    : account.accountAddress ? `${account.accountAddress.slice(0, 6)}…${account.accountAddress.slice(-4)}` : '—';
}

interface Draft {
  readonly exchange: LiveExchange;
  readonly name: string;
  readonly accountIndex: string;
  readonly apiKeyIndex: string;
  readonly accountAddress: string;
  readonly apiKey: string;
  readonly enabled: boolean;
}

const emptyDraft = (exchange: LiveExchange): Draft => ({
  exchange, name: '', accountIndex: '', apiKeyIndex: '', accountAddress: '', apiKey: '', enabled: true,
});

/** Add or change one account: Lighter (account index, API key index, key) or Hyperliquid (address, API wallet key). */
function AccountForm({ account, onSaved, onCancel }: {
  account: LiveAccountView | null; onSaved: (account: LiveAccountView) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => account ? {
    exchange: account.exchange, name: account.name, enabled: account.enabled, apiKey: '',
    accountIndex: account.accountIndex === null ? '' : String(account.accountIndex),
    apiKeyIndex: account.apiKeyIndex === null ? '' : String(account.apiKeyIndex),
    accountAddress: account.accountAddress ?? '',
  } : emptyDraft('lighter'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  const operatorKey = account?.keySource === 'server';

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const key = draft.apiKey.trim();
      const ids = draft.exchange === 'lighter'
        ? { accountIndex: Number(draft.accountIndex.trim()), apiKeyIndex: Number(draft.apiKeyIndex.trim()) }
        : { accountAddress: draft.accountAddress.trim() };
      if (!account) {
        onSaved(await createLiveAccount(draft.exchange === 'lighter'
          ? { exchange: 'lighter', name: draft.name, enabled: draft.enabled, accountIndex: ids.accountIndex!, apiKeyIndex: ids.apiKeyIndex!, apiKey: key }
          : { exchange: 'hyperliquid', name: draft.name, enabled: draft.enabled, accountAddress: ids.accountAddress!, apiKey: key }));
      } else {
        onSaved(await updateLiveAccount(account.id, { name: draft.name, enabled: draft.enabled,
          ...(operatorKey ? {} : ids), ...(key ? { apiKey: key } : {}) }));
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const lighter = draft.exchange === 'lighter';
  return <form className="paper-card live-account-form" aria-label={account ? `Change ${account.name}` : 'Add account'}
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <h2>{account ? `Change “${account.name}”` : 'Add an exchange account'}</h2>
    <p className="paper-live-privacy" role="note"><ShieldCheck size={16} />
      <span>{lighter ? LIVE_KEY_PRIVACY_NOTE : HYPERLIQUID_KEY_PRIVACY_NOTE}</span></p>
    <div className="paper-form-grid">
      <label><span>Exchange</span>
        <select value={draft.exchange} aria-label="Exchange" disabled={Boolean(account)}
          onChange={(event) => setDraft({ ...emptyDraft(event.target.value as LiveExchange), name: draft.name })}>
          <option value="lighter">Lighter</option>
          <option value="hyperliquid">Hyperliquid</option>
        </select></label>
      <label><span>Name <InfoTooltip label="account name" en="Your own name for this account, shown when you choose the account for a LIVE run. Each name is used once." ru="Ваше название аккаунта — его вы увидите при выборе аккаунта для LIVE-прогона. Каждое название — только один раз." /></span>
        <input type="text" maxLength={40} value={draft.name} aria-label="Account name" placeholder="e.g. Lighter main"
          onChange={(event) => set({ name: event.target.value })} /></label>
      {lighter ? <>
        <label><span>Account index <InfoTooltip label="account index" en="The number of your Lighter account (your main account or a sub-account)." ru="Номер вашего счёта Lighter (основного или субаккаунта)." /></span>
          <input type="text" inputMode="numeric" value={draft.accountIndex} aria-label="Account index" disabled={operatorKey}
            onChange={(event) => set({ accountIndex: event.target.value })} /></label>
        <label><span>API key index <InfoTooltip label="API key index" en="The index of the API key you created on Lighter: 4 to 254 (0 to 3 belong to Lighter's own apps)." ru="Индекс API-ключа, созданного на Lighter: от 4 до 254 (0–3 заняты приложениями Lighter)." /></span>
          <input type="text" inputMode="numeric" value={draft.apiKeyIndex} aria-label="API key index" disabled={operatorKey}
            onChange={(event) => set({ apiKeyIndex: event.target.value })} /></label>
        <label><span>API private key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} aria-label="API private key" disabled={operatorKey}
            placeholder={account ? 'saved — leave empty to keep it' : 'paste the private key of the API key'}
            onChange={(event) => set({ apiKey: event.target.value })} /></label>
      </> : <>
        <label><span>Account address <InfoTooltip label="account address" en="The address of your main Hyperliquid account (0x…), the one that holds the money. Not the API wallet's address." ru="Адрес вашего основного счёта Hyperliquid (0x…), на котором лежат деньги. Не адрес API-кошелька." /></span>
          <input type="text" autoComplete="off" spellCheck={false} value={draft.accountAddress} aria-label="Account address" disabled={operatorKey}
            placeholder="0x…" onChange={(event) => set({ accountAddress: event.target.value })} /></label>
        <label><span>API wallet private key <InfoTooltip label="API wallet private key" en="The private key Hyperliquid shows once when you create an API wallet (More → API). It can trade but cannot withdraw." ru="Секретный ключ, который Hyperliquid показывает один раз при создании API-кошелька (More → API). Он может торговать, но не может выводить деньги." /></span>
          <input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} aria-label="API wallet private key" disabled={operatorKey}
            placeholder={account ? 'saved — leave empty to keep it' : 'paste the API wallet private key'}
            onChange={(event) => set({ apiKey: event.target.value })} /></label>
      </>}
    </div>
    {operatorKey && <p className="paper-card-footnote">This account's key was set up by the server operator: here you can rename it or switch LIVE on and off.</p>}
    <label className="paper-live-confirm"><input type="checkbox" checked={draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
      LIVE on this account (real orders with real money)</label>
    <div className="paper-live-settings-actions">
      <button type="submit" className="paper-text-button" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      <button type="button" className="paper-text-button" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
    {error && <p className="paper-launch-error" role="alert">{error}</p>}
  </form>;
}

function CheckResult({ check, exchange }: { check: LiveConnectionCheck; exchange: LiveExchange }) {
  const dexes = check.dexBalances ? Object.entries(check.dexBalances) : [];
  return check.ok
    ? <p className="paper-live-check-ok" role="status">Connected to {EXCHANGE_NAMES[check.exchange ?? exchange]}: balance {check.balance ?? '—'} USDC
      {dexes.length > 0 && <> ({dexes.map(([dex, value]) => `${dex}: ${value}`).join(', ')})</>}, {check.openPositions} open position(s), {check.openOrders} open order(s). Nothing was traded.</p>
    : <p className="paper-launch-error" role="alert">Connection failed: {check.error}</p>;
}

/** The Accounts page (owner, 2026-10-20): exchange accounts with their API keys; a LIVE run trades one account per exchange. */
export function LiveAccountsPage({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const [view, setView] = useState<LiveAccountsView | null>(null);
  const [editing, setEditing] = useState<LiveAccountView | 'new' | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, LiveConnectionCheck>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = async (signal?: AbortSignal) => {
    try {
      setView(await loadLiveAccounts(signal));
    } catch (reason) {
      if (!signal?.aborted) setError(errorText(reason));
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    // Which run trades an account changes while the page is open.
    const timer = window.setInterval(() => { void reload(); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, []);

  const act = async (action: () => Promise<void>) => {
    setError('');
    setMessage('');
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const check = (account: LiveAccountView) => act(async () => {
    setChecking(account.id);
    try {
      const result = await checkLiveAccount(account.id);
      setChecks((current) => ({ ...current, [account.id]: result }));
    } finally {
      setChecking(null);
    }
  });
  const remove = (account: LiveAccountView) => {
    if (!window.confirm(`Remove the account "${account.name}"? ${account.keySource === 'app' ? 'Its key is deleted from this machine.' : ''}`)) return;
    void act(async () => {
      setView(await removeLiveAccount(account.id));
      setMessage(`The account "${account.name}" was removed.`);
    });
  };

  return <section className="paper-page live-accounts-page" aria-labelledby="live-accounts-title">
    <div className="paper-page-heading">
      <div>
        <span className="eyebrow">ACCOUNTS</span>
        <h1 id="live-accounts-title">Exchange accounts</h1>
        <p>Each account is one exchange account with its API key. A LIVE run trades one account on each of its exchanges,
          and an account trades in one LIVE run at a time — so different accounts can run LIVE side by side.</p>
      </div>
      {editing === null && <button type="button" className="paper-text-button" onClick={() => setEditing('new')}><Plus size={15} />Add account</button>}
    </div>
    {view?.disabledByServer && <p className="paper-launch-error" role="status">LIVE trading is switched off on this server by its operator.</p>}
    {editing !== null && <AccountForm key={editing === 'new' ? 'new' : editing.id} account={editing === 'new' ? null : editing}
      onCancel={() => setEditing(null)}
      onSaved={(saved) => { setEditing(null); setMessage(`Saved “${saved.name}”.`); void reload(); }} />}
    {message && <p className="paper-card-footnote" role="status">{message}</p>}
    {error && <p className="paper-launch-error" role="alert">{error}</p>}
    {!view ? (!error && <p className="paper-card-footnote">Loading accounts…</p>)
      : view.accounts.length === 0 ? <div className="paper-card"><h2>No accounts yet</h2>
        <p>Add your Lighter or Hyperliquid account to trade LIVE. Lighter: create an API key for the account (index 4–254).
          Hyperliquid: create an API wallet (More → API).</p></div>
      : <div className="live-account-list">
        {view.accounts.map((account) => <article key={account.id} className="paper-card live-account-card" aria-label={`Account ${account.name}`}>
          <div className="live-account-head">
            <div>
              <span className="eyebrow">{EXCHANGE_NAMES[account.exchange]}</span>
              <h2>{account.name}</h2>
            </div>
            <span className={account.runId ? 'live-account-status busy' : 'live-account-status'}>
              {account.runId ? 'Trading' : account.enabled && account.keySaved ? 'Free' : 'Off'}</span>
          </div>
          <dl className="live-account-facts">
            <div><dt>Exchange account</dt><dd>{accountIdentity(account)}</dd></div>
            <div><dt>LIVE</dt><dd>{account.enabled ? 'On' : 'Off'}</dd></div>
            <div><dt>Key</dt><dd>{account.keySaved ? (account.keySource === 'server' ? 'Set by the server operator' : 'Saved on this machine') : 'Missing'}</dd></div>
            <div><dt>Run</dt><dd>{account.runId
              ? <button type="button" className="live-account-run" onClick={() => onOpenRun(account.runId!)}>Open the LIVE run</button>
              : 'Not in a run'}</dd></div>
          </dl>
          <div className="paper-live-settings-actions">
            <button type="button" className="paper-text-button" disabled={checking !== null || Boolean(account.runId) || !account.keySaved}
              onClick={() => { void check(account); }}>{checking === account.id ? 'Checking… (up to a minute)' : 'Check connection'}</button>
            <button type="button" className="paper-text-button" disabled={editing !== null} onClick={() => setEditing(account)}>Change</button>
            <button type="button" className="paper-text-button" disabled={Boolean(account.runId)} onClick={() => remove(account)}>Remove</button>
          </div>
          {account.runId && <p className="paper-card-footnote">Trading now: the key and settings can change after that run stops; the run page shows the balance and positions.</p>}
          {checks[account.id] && <CheckResult check={checks[account.id]!} exchange={account.exchange} />}
        </article>)}
      </div>}
  </section>;
}
