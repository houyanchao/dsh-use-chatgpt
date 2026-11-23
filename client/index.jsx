import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import manifest from '../package.json' with { type: 'json' };
import { PanelIcon } from './PanelIcon.jsx';
import searchStyles from './native-chat-options.css';
import { ModelCatalog } from './ModelCatalog.jsx';
import { registerNativeChatOptions } from './NativeChatOptions.jsx';
import { ChatGPTMark } from './ChatGPTMark.jsx';
import sidebarStyles from './sidebar.css';
import { openPluginDetails, readPluginUpdate } from './updates.js';
import styles from './settings.css';

const pluginId = 'dsh-use-chatgpt';
const apiBase = '/api/dsh-use-chatgpt';
const connectionStatuses = ['disconnected', 'connecting', 'connected', 'reauth_required'];
const updateCheckInterval = 5 * 60 * 1000;
const dictionaries = {
  zh: {
    webSearch: '联网', searchHelp: '允许 ChatGPT 在此对话中按需搜索网页',
    searchRetry: '重试读取联网设置', saveFailed: '保存失败，请重试',
    legacyDefaults: '旧版联网默认设置', legacyHint: '旧版已默认开启联网。还原后，尚未单独设置的对话将默认关闭联网。',
    resetDefaults: '还原默认设置',
    accountOptions: '{label} 的更多操作', switchAccount: '切换', switchToAccount: '切换到 {label}',
    identityFallback: 'ChatGPT 账号',
    title: '关联 ChatGPT',
    sidebarLabel: '关联ChatGPT',
    startHere: '连接 ChatGPT', subtitle: '在 DeepSeek Harness 中使用你的 ChatGPT 套餐额度。',
    browserTitle: '在浏览器中继续', chooseSignedIn: '选择已登录账号',
    addTitle: '添加另一个 ChatGPT 账号', addHint: '请在浏览器中使用要添加的账号登录。完成后，DSH 会切换到该账号。',
    cancelAdd: '取消添加', reconnectAccount: '重新连接', pendingAccount: '待完成授权', resumeAccount: '继续授权',
    signedOut: '已退出', expiredAccount: '需要重新登录', noConsent: '套餐尚未授权',
    differentAccount: '你选择了另一个账号。再次点击登录，即可用所选账号建立新连接。',
    account: '账号',
    version: '插件版本',
    activeAccount: '当前账号',
    newAccount: '添加账号',
    loading: '正在读取连接状态…',
    unavailable: '请在本机的 macOS 或 Windows 版 DeepSeek Harness 中使用 ChatGPT 套餐。',
    connecting: '请在浏览器中完成授权，然后回到 DSH。',
    needsConsent: '请授权使用 ChatGPT 套餐额度。',
    signIn: '使用 ChatGPT 登录',
    enable: '授权使用套餐额度',
    cancel: '取消授权流程',
    signOut: '退出登录',
    retry: '重新读取状态',
    requestFailed: '无法连接本地 ChatGPT 套餐服务，请重试。',
    modelsLoading: '正在读取此账号可用的模型…',
    modelsEmpty: '此账号暂时没有可用的 ChatGPT 套餐模型。',
    modelsFailed: '无法读取模型列表。',
    refreshModels: '刷新模型列表',
    updateDetails: '查看升级详情', updateBadge: '有新版本',
    pluginDetails: '插件详情',
    updateAvailable: '可更新至 {version}',
    pluginDetailsFallback: '在「设置 → 插件」中搜索 dsh-use-chatgpt 查看详情。',
  },
  en: {
    webSearch: 'Web search', searchHelp: 'Allow ChatGPT to search the web when needed in this conversation',
    searchRetry: 'Retry loading web search', saveFailed: 'Couldn’t save. Try again.',
    legacyDefaults: 'Legacy web search default', legacyHint: 'Turn web search off for conversations that still use your previous default.',
    resetDefaults: 'Restore defaults',
    accountOptions: 'More options for {label}', switchAccount: 'Switch', switchToAccount: 'Switch to {label}',
    identityFallback: 'ChatGPT account',
    title: 'Link ChatGPT',
    sidebarLabel: 'Link ChatGPT',
    startHere: 'Connect to ChatGPT', subtitle: 'Use your ChatGPT plan allowance in DeepSeek Harness.',
    browserTitle: 'Continue in your browser', chooseSignedIn: 'Choose a signed-in account',
    addTitle: 'Add another ChatGPT account', addHint: 'Choose another account in your browser. Once you sign in, DSH will switch to that account.',
    cancelAdd: 'Cancel adding account', reconnectAccount: 'Reconnect', pendingAccount: 'Authorization pending', resumeAccount: 'Continue sign-in',
    signedOut: 'Signed out', expiredAccount: 'Sign in again', noConsent: 'Plan access not granted',
    differentAccount: 'You chose a different account. Select Continue with ChatGPT again to connect it.',
    account: 'Account',
    version: 'Plugin version',
    activeAccount: 'Active account',
    newAccount: 'Add account',
    loading: 'Checking the connection…',
    unavailable: 'Use your ChatGPT plan in a local DeepSeek Harness instance on macOS or Windows.',
    connecting: 'Finish authorizing in your browser, then return to DSH.',
    needsConsent: 'Authorize access to your ChatGPT plan usage.',
    signIn: 'Continue with ChatGPT',
    enable: 'Authorize plan usage',
    cancel: 'Cancel authorization',
    signOut: 'Sign out',
    retry: 'Check connection again',
    requestFailed: 'Could not reach the local ChatGPT plan service. Try again.',
    modelsLoading: 'Loading the models available to this account…',
    modelsEmpty: 'This account currently has no available ChatGPT plan models.',
    modelsFailed: 'Could not load the model list.',
    refreshModels: 'Reload models',
    updateDetails: 'View upgrade details', updateBadge: 'Update available',
    pluginDetails: 'Plugin details',
    updateAvailable: 'Update to {version} available',
    pluginDetailsFallback: 'Search for dsh-use-chatgpt under Settings → Plugins to view details.',
  },
};

function validFeatures(features) {
  return typeof features?.webSearch === 'boolean' && typeof features.jsonSchema === 'string';
}

async function request(action, signal, payload, method = 'GET') {
  const response = await fetch(`${apiBase}/${action}`, {
    method,
    headers: { accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    cache: 'no-store',
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) {
    const failure = new Error(typeof data?.error?.message === 'string' ? data.error.message : '');
    failure.code = data?.error?.code;
    throw failure;
  }
  return data;
}

async function requestConnection(action, signal, payload) {
  const data = await request(action, signal, payload, action === 'status' ? 'GET' : 'POST');
  if (!connectionStatuses.includes(data?.status) || typeof data.available !== 'boolean'
    || typeof data.sharing !== 'boolean' || (action === 'features' && !validFeatures(data.features))) {
    throw new Error();
  }
  return data;
}

function isSignIn(action) {
  return action === 'sign-in' || action === 'enable' || action === 'add-account';
}

function useConnection() {
  const [connection, setConnection] = useState(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const lifetime = useRef(null);
  const pendingAction = useRef(null);
  const refreshSignal = useRef(null);
  const revision = useRef(0);

  const refresh = useCallback(async (clearError = true) => {
    const signal = lifetime.current?.signal;
    if (!signal || refreshSignal.current === signal || pendingAction.current) return;
    const update = revision.current;
    refreshSignal.current = signal;
    try {
      const next = await requestConnection('status', signal);
      if (signal.aborted || revision.current !== update) return;
      setConnection(next);
      if (clearError) setError(previous => previous?.action === 'status' ? null : previous);
    } catch (failure) {
      if (!signal.aborted && revision.current === update) {
        setError(previous => previous?.action && previous.action !== 'status'
          ? previous : { action: 'status', message: failure.message });
      }
    } finally {
      if (refreshSignal.current === signal) refreshSignal.current = null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    void refresh();
    return () => {
      window.removeEventListener('focus', onFocus);
      controller.abort();
      lifetime.current = null;
      pendingAction.current = null;
    };
  }, [refresh]);

  const polling = connection?.status === 'connecting';
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => { void refresh(false); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [polling, refresh]);

  async function run(action, payload) {
    const signal = lifetime.current?.signal;
    const previous = pendingAction.current;
    const route = action === 'add-account' ? 'sign-in' : action === 'cancel-add' ? 'cancel' : action;
    if (!signal || (previous && !(route === 'cancel' && isSignIn(previous)))) return;
    const update = ++revision.current;
    pendingAction.current = action;
    setPending(action);
    setError(null);
    let failed = false;
    try {
      const next = await requestConnection(route, signal, payload);
      if (!signal.aborted && revision.current === update) {
        setConnection(next);
        return next;
      }
    } catch (failure) {
      failed = true;
      if (!signal.aborted && revision.current === update) setError({ action, message: failure.message, code: failure.code });
    } finally {
      if (!signal.aborted && revision.current === update) {
        pendingAction.current = null;
        setPending(null);
        if (failed) void refresh(false);
      }
    }
  }

  return { connection, pending, error, refresh, run };
}

function profileName(profile) {
  return profile.identity?.email || profile.identity?.name || profile.label;
}

function LoginScreen({ t, state }) {
  const titleId = useId();
  const { connection, pending, error, refresh, run } = state;
  const waiting = connection?.status === 'connecting' || pending === 'sign-in' || pending === 'cancel';
  const profiles = connection?.profiles ?? [];
  const signedIn = profiles.filter(profile => !profile.pending && profile.status === 'connected');
  const choosing = connection?.available && !waiting && signedIn.length > 0;
  const current = profiles.find(profile => profile.id === connection?.profileId);
  const differentAccount = (error?.code || connection?.error?.code) === 'account_mismatch';
  const message = error ? (differentAccount ? t('differentAccount') : error.message || t('requestFailed'))
    : connection?.error?.code?.startsWith('storage_') ? connection.error.message : null;
  const hint = waiting ? t('connecting') : !connection ? (error ? null : t('loading'))
    : !connection.available ? t('unavailable') : !choosing ? t('subtitle') : null;

  function signIn() {
    // The SDK binds existing registrations to an identity. Reuse a saved connection
    // for returning users and an unfinished registration when there is no bound one.
    const existing = !differentAccount && !current?.requiresNewRegistration && current;
    const target = existing || profiles.find(profile => profile.pending);
    void run('sign-in', target ? { profileId: target.id } : { newProfile: true });
  }

  return <section className="cg-account cg-welcome" aria-labelledby={titleId}>
    <header className="cg-welcome-heading">
      <ChatGPTMark size={48} />
      <h1 id={titleId}>{t(waiting ? 'browserTitle' : choosing ? 'chooseSignedIn' : 'startHere')}</h1>
    </header>
    {hint && <p className="cg-account-status" role="status">{hint}</p>}
    {message && <p className="dsh-use-chatgpt-error" role="alert">{message}</p>}
    <div className="dsh-use-chatgpt-actions">
      {!connection && error && <Button variant="outline" size="sm" onClick={() => { void refresh(); }}>{t('retry')}</Button>}
      {waiting && <Button variant="outline" size="sm" disabled={pending === 'cancel'}
        onClick={() => { void run('cancel'); }}>{t('cancel')}</Button>}
      {choosing && signedIn.map(profile => <Button key={profile.id} variant="outline" size="sm" disabled={Boolean(pending)}
        onClick={() => { void run('select-profile', { profileId: profile.id }); }}>{profileName(profile)}</Button>)}
      {connection?.available && !waiting && !choosing && <Button className="cg-primary" variant="primary" size="sm"
        disabled={Boolean(pending)} onClick={signIn}>{t('signIn')}</Button>}
    </div>
  </section>;
}

function AccountRow({ profile, current, busy, t, run }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { id, identity, sharing } = profile;
  const connected = !profile.pending && profile.status === 'connected';
  const email = identity?.email;
  const display = identity?.name || email || profile.label || t('identityFallback');
  const secondaryEmail = email !== display ? email : undefined;
  const initials = identity?.name?.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0]).join('');
  let status;
  if (profile.pending) status = 'pendingAccount';
  else if (profile.status === 'reauth_required') status = 'expiredAccount';
  else if (!connected) status = 'signedOut';
  else if (!sharing) status = 'noConsent';

  return <li className="cg-profile">
    <span className="cg-profile-avatar" aria-hidden="true">{initials || <PanelIcon name="account" size={19} />}</span>
    <div className="cg-profile-text">
      <div className="cg-profile-name">
        <strong>{display}</strong>
        {current && connected && <span className="cg-current-account">{t('activeAccount')}</span>}
      </div>
      {(secondaryEmail || status) && <div className="cg-profile-meta">
        {secondaryEmail && <span>{secondaryEmail}</span>}
        {status && <span>{t(status)}</span>}
      </div>}
    </div>
    <div className="cg-profile-actions">
      {connected ? <>
        {!current && <button type="button" className="cg-account-action" disabled={busy}
          aria-label={t('switchToAccount', { label: profileName(profile) })}
          onClick={() => { void run('select-profile', { profileId: id }); }}>{t('switchAccount')}</button>}
        <Menu open={menuOpen && !busy} align="end" portal autoFocus dense
          anchor={<button type="button" className="cg-account-more" disabled={busy}
            aria-label={t('accountOptions', { label: profileName(profile) || display })} aria-haspopup="menu"
            aria-expanded={menuOpen && !busy} onClick={() => setMenuOpen(open => !open)}><PanelIcon name="more" /></button>}
          items={[{ type: 'label', id: 'account', text: email || display },
            { id: 'sign-out', label: t('signOut'), icon: <PanelIcon name="signOut" size={16} /> }]}
          onClose={() => setMenuOpen(false)}
          onSelect={() => { setMenuOpen(false); void run('sign-out-profile', { profileId: id }); }} />
      </> : <button type="button" className="cg-account-action" disabled={busy}
        onClick={() => { void run('add-account', { profileId: id }); }}>
        {t(profile.pending ? 'resumeAccount' : 'reconnectAccount')}
      </button>}
    </div>
  </li>;
}

function Account({ t, state, adding }) {
  const titleId = useId();
  const { connection, pending, error, run } = state;
  const { profileId, profiles = [] } = connection;
  const rows = profiles.filter(profile => profile.status === 'connected' || !profile.requiresNewRegistration);
  if (profileId && connection.status === 'connected' && !rows.some(profile => profile.id === profileId)) {
    rows.unshift({ id: profileId, label: connection.profileLabel, identity: connection.identity,
      status: connection.status, sharing: connection.sharing });
  }
  const waiting = adding || connection.status === 'connecting' || isSignIn(pending) || pending === 'cancel';
  const busy = waiting || Boolean(pending);
  const needsConsent = connection.status === 'connected' && !connection.sharing;
  const message = error ? error.message || t('requestFailed') : !waiting && connection.error?.message;

  return <section className="cg-account" aria-labelledby={titleId}>
    <header className="cg-account-heading"><h2 id={titleId}>{t('account')}</h2></header>
    <ul className="cg-profile-list">
      {rows.map(profile => <AccountRow key={profile.id} profile={profile} current={profile.id === profileId}
        busy={busy} t={t} run={run} />)}
    </ul>
    {message && <p className="dsh-use-chatgpt-error" role="alert">{message}</p>}
    {waiting ? <div className="cg-account-flow">
      <div role="status">
        {adding && <h3>{t('addTitle')}</h3>}
        <p>{t(adding ? 'addHint' : 'connecting')}</p>
      </div>
      <div className="dsh-use-chatgpt-actions">
        <Button variant="outline" size="sm" disabled={pending === 'cancel' || pending === 'cancel-add'}
          onClick={() => { void run(adding ? 'cancel-add' : 'cancel'); }}>{t(adding ? 'cancelAdd' : 'cancel')}</Button>
      </div>
    </div> : needsConsent && <div className="cg-account-flow">
      <p>{t('needsConsent')}</p>
      <div className="dsh-use-chatgpt-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run('enable', { profileId }); }}>{t('enable')}</Button>
      </div>
    </div>}
    <button type="button" className="cg-account-add" disabled={busy}
      onClick={() => { void run('add-account', { newProfile: true }); }}>
      <PanelIcon name="plus" size={17} />{t('newAccount')}
    </button>
  </section>;
}

function usePageResource(read) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => { setRevision(value => value + 1); }, []);

  useEffect(() => {
    if (!read) {
      setData(null);
      setError(false);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setRefreshing(true);
    void (async () => {
      try {
        const result = await read(signal, revision > 0);
        if (!signal.aborted) {
          setData(result);
          setError(false);
        }
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        if (!signal.aborted) setRefreshing(false);
      }
    })();
    return () => { controller.abort(); };
  }, [read, revision]);

  return { data, error, refresh, refreshing, update: setData };
}

function monitorUpdates(ctx) {
  let data = null;
  let recheck;
  const listeners = new Set();
  ctx.effect(() => {
    const controller = new AbortController();
    let checking = false;
    async function check(retryClientFailure = false) {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const result = await readPluginUpdate(controller.signal, { retryClientFailure });
        if (controller.signal.aborted) return;
        data = result;
        for (const listener of listeners) listener();
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        checking = false;
      }
    }
    const refresh = () => { void check(); };
    recheck = refresh;
    const timer = window.setInterval(refresh, updateCheckInterval);
    window.addEventListener('focus', refresh);
    void check(true);
    return () => {
      recheck = undefined;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, `${pluginId} update checks`);
  return {
    getSnapshot: () => data,
    refresh: () => recheck?.(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

async function readModels(profileId, signal, force) {
  const query = new URLSearchParams({ profileId });
  if (force) query.set('refresh', '1');
  const data = await request('models?' + query, signal);
  if (!Array.isArray(data?.models)) throw new Error();
  return data.models.filter(model => typeof model?.id === 'string' && typeof model.name === 'string');
}

function PluginVersion({ ctx, t, data, loginFooter = false }) {
  const [fallback, setFallback] = useState(false);
  const hasUpdate = data?.status === 'update_available';
  const version = 'v' + (data?.currentVersion ?? manifest.version);
  const Wrapper = loginFooter ? 'footer' : 'div';
  return <Wrapper className={loginFooter ? 'cg-login-footer' : 'cg-header-version'}>
    {hasUpdate ? <button type="button" className="cg-version" onClick={() => setFallback(!openPluginDetails(ctx))}
      title={t('updateAvailable', { version: data.latestVersion })}
      aria-label={`${version} · ${t('updateBadge')} · ${t('updateDetails')}`}>
      {loginFooter && t('pluginDetails')}<span>{version}</span>
      <span className="dsh-use-chatgpt-update-badge">{t('updateBadge')}</span>
    </button> : <span className="cg-version">{loginFooter && t('version')}<span>{version}</span></span>}
    {hasUpdate && fallback && <small role="status">{t('pluginDetailsFallback')}</small>}
  </Wrapper>;
}

function WorkspaceBody({ t, language, state, adding }) {
  const { connection, pending, run } = state;
  const authorized = connection.status === 'connected' && connection.sharing && !adding;
  const profileId = connection?.profileId;
  const loadModels = useCallback((signal, force) => readModels(profileId, signal, force), [profileId]);
  const models = usePageResource(authorized && profileId ? loadModels : null);
  return <div className="cg-dashboard">
    <Account t={t} state={state} adding={adding} />
    {authorized && <>
      <ModelCatalog t={t} language={language} resource={models} profileId={profileId} />
      {connection.features?.webSearch &&
        <details className="cg-legacy-defaults"><summary>{t('legacyDefaults')}</summary><p>{t('legacyHint')}</p>
          <Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => {
            void run('features', { ...connection.features, webSearch: false });
          }}>{t('resetDefaults')}</Button>
        </details>}
    </>}
  </div>;
}

function ChatGPTPage({ ctx, t, updates }) {
  const titleId = useId();
  const state = useConnection();
  const { connection, pending } = state;
  const adding = connection?.addingAccount || pending === 'add-account' || pending === 'cancel-add';
  const connectedProfile = connection?.profiles?.some(profile => profile.id === connection.profileId && profile.status === 'connected' && !profile.pending);
  const signedIn = connection?.available && (connection.status === 'connected' || adding || (connection.status === 'connecting' && connectedProfile));
  const version = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const language = (ctx.locale.getSnapshot?.().active || document.documentElement.lang || 'zh').startsWith('en') ? 'en' : 'zh';
  useEffect(updates.refresh, [updates]);
  return <section className="dsh-use-chatgpt-page" aria-label={signedIn ? undefined : t('title')} aria-labelledby={signedIn ? titleId : undefined}>
    <div className={signedIn ? 'dsh-use-chatgpt-content' : 'cg-login-layout'}>
      {signedIn && <header className="dsh-use-chatgpt-header">
        <h1 id={titleId}>{t('title')}</h1>
        <PluginVersion ctx={ctx} t={t} data={version} />
        <p>{t('subtitle')}</p>
      </header>}
      {signedIn
        ? <WorkspaceBody key={connection.profileId} t={t} language={language} state={state} adding={adding} />
        : <LoginScreen t={t} state={state} />}
      {!signedIn && <PluginVersion ctx={ctx} t={t} data={version} loginFooter />}
    </div>
  </section>;
}

function SidebarIcon({ size = 16 }) {
  return <ChatGPTMark size={size} />;
}

function SidebarUpdateBadge({ updates, wide, t }) {
  const version = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  if (version?.status !== 'update_available') return null;
  return <span className={wide ? 'dsh-use-chatgpt-update-badge' : 'dsh-use-chatgpt-update-sr'}>{t('updateBadge')}</span>;
}

export const inject = ['locale', 'slots'];

export function apply(ctx) {
  const updates = monitorUpdates(ctx);
  const t = ctx.locale.bind(pluginId);
  registerNativeChatOptions(ctx, useConnection);
  ctx.effect(() => ctx.locale.register(pluginId, dictionaries), `${pluginId} translations`);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = pluginId;
    style.textContent = [styles, sidebarStyles, searchStyles].join('\n');
    document.head.append(style);
    return () => { style.remove(); };
  }, `${pluginId} styles`);
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: pluginId, order: 30, label: () => t('sidebarLabel'),
  }, SidebarIcon));
  ctx.slots.inject('sidebar.panellist.trailing', () => ctx.slots.register({
    name: 'sidebar.panellist.trailing', id: pluginId, locale: pluginId,
  }, function Trailing(props) { return <SidebarUpdateBadge {...props} updates={updates} />; }));
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: pluginId,
    locale: pluginId,
  }, function Panel(props) { return <ChatGPTPage {...props} ctx={ctx} updates={updates} />; }));
}
