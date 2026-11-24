import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import manifest from '../package.json' with { type: 'json' };
import { PanelIcon } from './PanelIcon.jsx';
import searchStyles from './native-chat-options.css';
import { ModelCatalog } from './ModelCatalog.jsx';
import { PluginRecommendations } from './PluginRecommendations.jsx';
import { createPluginInstaller } from './plugin-installer.js';
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
    viewProject: '查看开源项目',
    startHere: '连接 ChatGPT', subtitle: '在 DeepSeek Harness 中使用你的 ChatGPT 套餐额度。',
    browserTitle: '在浏览器中继续', chooseSignedIn: '选择已登录账号',
    authorizeHint: '请在 3 分钟内完成浏览器中的授权。完成后将切换到该账号。',
    authorizationFailed: '授权未完成', close: '关闭',
    reconnectAccount: '重新连接', pendingAccount: '待完成授权', resumeAccount: '继续授权',
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
    updateTitle: '有新版本', updateDetails: '查看更新', updateBadge: '更新',
    otherPlugins: '作者的其他插件',
    freeModelsDescription: '在 DSH 中使用 Kilo 免费模型，检测可用性并选择在对话中显示的模型。',
    timelineDescription: '为 DSH 对话添加提问时间轴、收藏夹、提示词库和多格式导出。',
    browserDescription: '为 ChatGPT、Gemini、DeepSeek 等网页添加对话时间轴、收藏夹和提示词库。',
    installPlugin: '安装', installedPlugin: '已安装', installingPlugin: '安装中…',
    checkingPlugins: '检测中…', retryPlugins: '重新检测', installUnavailable: '安装不可用',
    pluginAction: '{name} · {action}', chromeStore: 'Chrome 版', edgeStore: 'Edge 版',
    inventoryError: '无法读取已安装插件，请重新检测。', installError: '安装失败，请重试。',
    packageNotFound: 'npm 官方源暂未找到 {name}。', installGuide: '查看安装说明',
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
    viewProject: 'View open-source project',
    startHere: 'Connect to ChatGPT', subtitle: 'Use your ChatGPT plan allowance in DeepSeek Harness.',
    browserTitle: 'Continue in your browser', chooseSignedIn: 'Choose a signed-in account',
    authorizeHint: 'Complete authorization in your browser within 3 minutes to switch to this account.',
    authorizationFailed: 'Authorization incomplete', close: 'Close',
    reconnectAccount: 'Reconnect', pendingAccount: 'Authorization pending', resumeAccount: 'Continue sign-in',
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
    updateTitle: 'Update available', updateDetails: 'View update', updateBadge: 'Update',
    otherPlugins: 'More plugins by this author',
    freeModelsDescription: 'Use free Kilo models in DSH, check availability, and choose which models appear in chat.',
    timelineDescription: 'Add a question timeline, bookmark folders, a prompt library, and chat exports to DSH.',
    browserDescription: 'Add a chat timeline, bookmarks, and a prompt library to ChatGPT, Gemini, DeepSeek, and other AI chat sites.',
    installPlugin: 'Install', installedPlugin: 'Installed', installingPlugin: 'Installing…',
    checkingPlugins: 'Checking…', retryPlugins: 'Check again', installUnavailable: 'Install unavailable',
    pluginAction: '{name} · {action}', chromeStore: 'Chrome', edgeStore: 'Edge',
    inventoryError: 'Could not load installed plugins. Check again.', installError: 'Installation failed. Try again.',
    packageNotFound: 'The npm registry could not find {name}.', installGuide: 'View installation guide',
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

function isAccountDialogAction(action) {
  return action === 'add-account' || action === 'cancel-add';
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

  const polling = connection?.status === 'connecting' || connection?.addingAccount;
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
      if (!signal.aborted && revision.current === update && !(action === 'add-account' && failure.code === 'cancelled')) {
        setError({ action, message: failure.message, code: failure.code });
      }
    } finally {
      if (!signal.aborted && revision.current === update) {
        pendingAction.current = null;
        setPending(null);
        if (failed) void refresh(false);
      }
    }
  }

  return { connection, pending, error, dismissError: () => setError(null), refresh, run };
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
      </> : <button type="button" className="cg-account-action" disabled={busy} aria-haspopup="dialog"
        onClick={() => { void run('add-account', { profileId: id }); }}>
        {t(profile.pending ? 'resumeAccount' : 'reconnectAccount')}
      </button>}
    </div>
  </li>;
}

function Account({ t, state }) {
  const titleId = useId();
  const { connection, pending, error, run } = state;
  const { profileId, profiles = [] } = connection;
  const rows = profiles.filter(profile => profile.status === 'connected' || !profile.requiresNewRegistration);
  if (profileId && connection.status === 'connected' && !rows.some(profile => profile.id === profileId)) {
    rows.unshift({ id: profileId, label: connection.profileLabel, identity: connection.identity,
      status: connection.status, sharing: connection.sharing });
  }
  const waiting = connection.status === 'connecting' || pending === 'enable' || pending === 'cancel';
  const busy = waiting || (Boolean(pending) && !isAccountDialogAction(pending));
  const needsConsent = connection.status === 'connected' && !connection.sharing;
  const message = error ? !isAccountDialogAction(error.action) && (error.message || t('requestFailed')) : !waiting && connection.error?.message;

  return <section className="cg-account" aria-labelledby={titleId}>
    <header className="cg-account-heading"><h2 id={titleId}>{t('account')}</h2></header>
    <ul className="cg-profile-list">
      {rows.map(profile => <AccountRow key={profile.id} profile={profile} current={profile.id === profileId}
        busy={busy} t={t} run={run} />)}
    </ul>
    {message && <p className="dsh-use-chatgpt-error" role="alert">{message}</p>}
    {waiting ? <div className="cg-account-flow">
      <p role="status">{t('connecting')}</p>
      <div className="dsh-use-chatgpt-actions">
        <Button variant="outline" size="sm" disabled={pending === 'cancel'}
          onClick={() => { void run('cancel'); }}>{t('cancel')}</Button>
      </div>
    </div> : needsConsent && <div className="cg-account-flow">
      <p>{t('needsConsent')}</p>
      <div className="dsh-use-chatgpt-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run('enable', { profileId }); }}>{t('enable')}</Button>
      </div>
    </div>}
    <button type="button" className="cg-account-add" disabled={busy} aria-haspopup="dialog"
      onClick={() => { void run('add-account', { newProfile: true }); }}>
      <PanelIcon name="plus" size={17} />{t('newAccount')}
    </button>
  </section>;
}

function usePageResource(read) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => { setRevision(value => value + 1); }, []);

  useEffect(() => {
    if (!read) {
      setData(null);
      setError(null);
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
          setError(null);
        }
      } catch (failure) {
        if (!signal.aborted) setError(typeof failure?.message === 'string' ? failure.message : '');
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

function UpdateBanner({ ctx, t, data }) {
  if (data?.status !== 'update_available') return null;

  function openDetails(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openPluginDetails(ctx)) event.preventDefault();
  }

  return <div className="cg-update-banner">
    <p className="cg-update-copy">
      <strong>{t('updateTitle')}</strong>
      <span>v{data.latestVersion}</span>
    </p>
    <a className="cg-update-action" href={`https://www.npmjs.com/package/${manifest.name}`}
      target="_blank" rel="noopener noreferrer" onClick={openDetails}>{t('updateDetails')}</a>
  </div>;
}

function PluginVersion({ t, data, loginFooter = false }) {
  const version = 'v' + (data?.currentVersion ?? manifest.version);
  const Wrapper = loginFooter ? 'footer' : 'div';
  return <Wrapper className={loginFooter ? 'cg-login-footer' : 'cg-header-version'}>
    <span className="cg-version">{loginFooter && t('version')}<span>{version}</span></span>
  </Wrapper>;
}

function WorkspaceBody({ t, language, state, installer }) {
  const { connection, pending, run } = state;
  const authorized = connection.status === 'connected' && connection.sharing;
  const profileId = connection?.profileId;
  const loadModels = useCallback((signal, force) => readModels(profileId, signal, force), [profileId]);
  const models = usePageResource(authorized && profileId ? loadModels : null);
  return <div className="cg-dashboard">
    <Account t={t} state={state} />
    {authorized && <>
      <ModelCatalog t={t} language={language} resource={models} profileId={profileId} />
      {connection.features?.webSearch &&
        <details className="cg-legacy-defaults"><summary>{t('legacyDefaults')}</summary><p>{t('legacyHint')}</p>
          <Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => {
            void run('features', { ...connection.features, webSearch: false });
          }}>{t('resetDefaults')}</Button>
        </details>}
    </>}
    <PluginRecommendations installer={installer} t={t} />
  </div>;
}

function ChatGPTPage({ ctx, t, updates, installer }) {
  const titleId = useId();
  const state = useConnection();
  const { connection, pending, error, run, dismissError } = state;
  const authorizing = connection?.addingAccount || isAccountDialogAction(pending);
  const dialogError = isAccountDialogAction(error?.action) ? error : null;
  const dialogOpen = Boolean(authorizing || dialogError);
  function closeDialog() {
    if (authorizing) {
      if (pending !== 'cancel-add') void run('cancel-add');
    } else dismissError();
  }
  const connectedProfile = connection?.profiles?.some(profile => profile.id === connection.profileId && profile.status === 'connected' && !profile.pending);
  const signedIn = connection?.available && (connection.status === 'connected' || (connection.status === 'connecting' && connectedProfile));
  const version = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const language = (ctx.locale.getSnapshot?.().active || document.documentElement.lang || 'zh').startsWith('en') ? 'en' : 'zh';
  useEffect(updates.refresh, [updates]);
  return <section className="dsh-use-chatgpt-page" aria-label={signedIn ? undefined : t('title')} aria-labelledby={signedIn ? titleId : undefined}>
    <div className={signedIn ? 'dsh-use-chatgpt-content' : 'cg-login-layout'} inert={dialogOpen ? '' : undefined}>
      <UpdateBanner ctx={ctx} t={t} data={version} />
      {signedIn && <header className="dsh-use-chatgpt-header">
        <h1 id={titleId}>{t('title')}</h1>
        <div className="cg-header-links">
          <PluginVersion t={t} data={version} />
          <Tooltip label={t('viewProject')}>
            <a className="cg-project-link" href="https://github.com/houyanchao/dsh-use-chatgpt"
              target="_blank" rel="noopener noreferrer" aria-label={t('viewProject')}>
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
          </Tooltip>
        </div>
        <p>{t('subtitle')}</p>
      </header>}
      {signedIn
        ? <WorkspaceBody key={connection.profileId} t={t} language={language} state={state} installer={installer} />
        : <LoginScreen t={t} state={state} />}
      {!signedIn && <PluginVersion t={t} data={version} loginFooter />}
    </div>
    <Modal open={dialogOpen} title={t(dialogError ? 'authorizationFailed' : 'browserTitle')}
      description={dialogError ? dialogError.message || t('requestFailed') : t('authorizeHint')}
      closeLabel={t(authorizing ? 'cancel' : 'close')} onClose={closeDialog}
      footer={<Button variant="outline" autoFocus disabled={pending === 'cancel-add'} onClick={closeDialog}>
        {t(authorizing ? 'cancel' : 'close')}
      </Button>} />
  </section>;
}

function SidebarIcon({ size = 16 }) {
  return <ChatGPTMark size={size} />;
}

function SidebarUpdateBadge({ updates, wide, t }) {
  const version = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  if (version?.status !== 'update_available') return null;
  if (wide) return <span className="dsh-use-chatgpt-update-badge">{t('updateBadge')}</span>;
  return <span className="dsh-use-chatgpt-update-dot"><span className="dsh-use-chatgpt-update-sr">{t('updateBadge')}</span></span>;
}

export const inject = ['locale', 'slots'];

export function apply(ctx) {
  const updates = monitorUpdates(ctx);
  const installer = createPluginInstaller(ctx);
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
  }, function Panel(props) { return <ChatGPTPage {...props} ctx={ctx} updates={updates} installer={installer} />; }));
}
