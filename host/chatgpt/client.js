import { randomUUID } from 'node:crypto';
import { ChatGPTError, asError, requiresReauthentication } from './errors.js';
import { listModels } from './models.js';
import { authorize, identityVerificationUnavailable, refreshConnection, revokeConnection } from './oauth.js';
import { streamResponse } from './responses.js';
import { AccountStore } from './store.js';

const planScope = 'chatgpt.tokens.use.direct';
const disconnected = () => ({ status: 'disconnected', sharing: false });
const active = state => state.profiles.find(profile => profile.id === state.activeProfileId);
const now = () => new Date().toISOString();
const changed = () => new ChatGPTError('connection_changed', '账号已变更，请重新操作。', true);
const cancelled = () => new ChatGPTError('cancelled', '操作已取消。');
const missingAccount = () => new ChatGPTError('profile_not_found', '找不到选定的账号。');
const connected = profile => profile?.status === 'connected' && Boolean(profile.credentials);
const sharing = profile => connected(profile) && profile.scopes.includes(planScope);

export function isAddingAccount(session, options) {
  return session?.status === 'connected' && Boolean(session.profileId) && !options.reconsent
    && (options.newProfile === true || (Boolean(options.profileId) && options.profileId !== session.profileId));
}

function publicIdentity(identity) {
  if (!identity) return {};
  const fields = {};
  for (const key of ['email', 'name']) {
    if (typeof identity[key] === 'string') fields[key] = identity[key];
  }
  return { identity: fields };
}

function sessionFor(state) {
  const profile = active(state);
  if (!profile) return disconnected();
  return { status: profile.status, sharing: sharing(profile), profileId: profile.id,
    profileLabel: profile.label, ...publicIdentity(profile.identity),
    ...(profile.pendingRefresh ? { error: identityVerificationUnavailable().toJSON() } : {}) };
}

function requireNewSignIn(profile) {
  delete profile.credentials;
  delete profile.profileIdToken;
  delete profile.pendingRefresh;
  Object.assign(profile, { status: 'reauth_required', scopes: [], savedAt: now() });
}

function availableLabel(state, requested) {
  const labels = new Set([...state.profiles, ...state.pendingRegistrations].map(profile => profile.label));
  if (requested !== undefined) {
    if (typeof requested !== 'string' || !requested.trim() || requested.trim().length > 100
      || /[\u0000-\u001f]/.test(requested) || labels.has(requested.trim())) throw new ChatGPTError('invalid_config', '请选择独立的账号名称。');
    return requested.trim();
  }
  let number = 1;
  while (labels.has('Connection ' + number)) number++;
  return 'Connection ' + number;
}

function requirePlan(profile) {
  if (profile?.status !== 'connected') throw new ChatGPTError('sign_in_required', '请先连接 ChatGPT 账号。');
  if (!profile.scopes.includes(planScope)) throw new ChatGPTError('sharing_not_enabled', '请先授权使用 ChatGPT 套餐。');
  if (!profile.credentials) throw new ChatGPTError('sign_in_required', '凭据已失效，请重新连接 ChatGPT。');
}

function refreshDue(profile) {
  if (profile.pendingRefresh) return true;
  const { expiresAt, earliestRefreshAt } = profile.credentials;
  const earliest = typeof earliestRefreshAt === 'number' ? earliestRefreshAt * 1000 : Date.parse(earliestRefreshAt);
  return expiresAt <= Date.now() + 60_000 && (!Number.isFinite(earliest) || earliest <= Date.now());
}

export function createChatGPT(config) {
  if (!config?.appId || typeof config.appName !== 'string' || !config.appName.trim()
    || !Number.isInteger(config.redirectPort) || config.redirectPort < 0 || config.redirectPort > 65535) {
    throw new ChatGPTError('invalid_config', '请提供应用名和有效的登录回调端口。');
  }
  const store = new AccountStore(config.storageDir, config.credentialEncryption);
  const observers = new Set();
  let generation = new AbortController();
  let login;
  let updating = false;
  let signingOutProfile;
  let displayed = disconnected();

  function publish(session) {
    displayed = session;
    for (const observe of observers) observe(structuredClone(session));
    return structuredClone(session);
  }

  function idle({ modelRequest = false } = {}) {
    const loginBlocksRequest = login && (!modelRequest || !login.addingAccount);
    if (updating || loginBlocksRequest || (signingOutProfile && !modelRequest)) {
      throw new ChatGPTError('connection_busy', '请先完成当前的账号操作。');
    }
  }

  function invalidate() {
    generation.abort();
    generation = new AbortController();
  }

  async function getSession() {
    if (updating || (login && !login.addingAccount)) return structuredClone(displayed);
    const beforeRead = generation;
    try {
      const latest = await store.transaction(({ state }) => sessionFor(state));
      if (beforeRead !== generation) return structuredClone(displayed);
      // Keep transient request errors visible until another action or successful call clears them.
      if (latest.profileId === displayed.profileId && !latest.error && displayed.error) latest.error = displayed.error;
      return publish(latest);
    } catch (error) {
      if (beforeRead !== generation) return structuredClone(displayed);
      return publish({ status: 'reauth_required', sharing: false, error: asError(error).toJSON() });
    }
  }

  async function authenticated(options, run) {
    idle({ modelRequest: true });
    const signal = options.signal ? AbortSignal.any([generation.signal, options.signal]) : generation.signal;
    try {
      const grant = await store.transaction(async ({ state, save }) => {
        const profile = active(state);
        if (options.expectedProfileId && profile?.id !== options.expectedProfileId) throw changed();
        requirePlan(profile);
        if (refreshDue(profile)) {
          signal.throwIfAborted();
          try {
            // The refresh may consume a single-use grant. Finish saving the successor even if the chat stops.
            const renewed = await refreshConnection(profile, AbortSignal.timeout(60_000), async replacement => {
              profile.pendingRefresh = replacement;
              profile.savedAt = now();
              await save();
            });
            delete profile.pendingRefresh;
            Object.assign(profile, renewed);
            await save();
          } catch (error) {
            const typed = asError(error);
            if (requiresReauthentication(typed) || ['invalid_id_token', 'invalid_token_response', 'account_mismatch'].includes(typed.code)) {
              requireNewSignIn(profile);
              await save();
            }
            throw typed;
          }
        }
        requirePlan(profile);
        if (profile.credentials.expiresAt <= Date.now()) throw new ChatGPTError('refresh_not_ready', '凭据尚未完成续期，请稍后重试。', true);
        return { token: profile.credentials.accessToken, session: sessionFor(state) };
      }, signal);
      signal.throwIfAborted();
      publish(grant.session);
      const result = await run(grant.token, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw cancelled();
      const typed = asError(error);
      const current = await store.transaction(({ state }) => sessionFor(state)).catch(() => disconnected());
      if (!signal.aborted) publish({ ...current, error: typed.toJSON() });
      throw typed;
    }
  }

  async function signIn(options = {}) {
    idle();
    if (options.newProfile && options.profileId) throw new ChatGPTError('invalid_profile', '请指定一个登录方式。');
    const addingAccount = isAddingAccount(displayed, options);
    const sourceProfileId = displayed.profileId;
    const attempt = { controller: new AbortController(), addingAccount };
    login = attempt;
    const timeout = AbortSignal.timeout(3 * 60_000);
    const signals = [attempt.controller.signal, timeout];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    if (!addingAccount) {
      invalidate();
      publish({ ...displayed, status: 'connecting', sharing: false, error: undefined });
    }
    try {
      const original = await store.transaction(async ({ state, hostId }) => {
        const id = options.profileId ?? (!options.newProfile && state.activeProfileId ? state.activeProfileId : randomUUID());
        const profile = state.profiles.find(item => item.id === id);
        const pending = state.pendingRegistrations.find(item => item.id === id);
        if (options.profileId && !profile && !pending) throw missingAccount();
        if (profile?.requiresNewRegistration) throw new ChatGPTError('registration_upgrade_required', '请添加账号以完成新版本授权。');
        if (addingAccount && state.activeProfileId !== sourceProfileId) throw changed();
        return { id, profile, pending, activeId: state.activeProfileId, host: await hostId() };
      }, signal);

      function inspect(state) {
        signal.throwIfAborted();
        const profile = state.profiles.find(item => item.id === original.id);
        if (state.activeProfileId !== original.activeId || Boolean(profile) !== Boolean(original.profile)
          || profile?.savedAt !== original.profile?.savedAt || profile?.status !== original.profile?.status
          || profile?.credentials?.accessToken !== original.profile?.credentials?.accessToken) throw changed();
        return { profile, pending: state.pendingRegistrations.find(item => item.id === original.id) };
      }
      let previous = original.profile ?? original.pending;
      let registeredClientId = previous?.clientId;
      const onRegistration = async clientId => {
        await store.transaction(async ({ state, save }) => {
          const { profile, pending } = inspect(state);
          if (profile || pending) {
            if ((profile ?? pending).clientId !== clientId) throw changed();
          } else {
            state.pendingRegistrations.push({ id: original.id, clientId, label: availableLabel(state, options.label), savedAt: now() });
            await save();
          }
        }, signal);
        registeredClientId = clientId;
      };
      const interact = () => authorize(config, previous, original.host, signal, { reconsent: options.reconsent, onRegistration });
      let verified;
      try {
        verified = await interact();
      } catch (error) {
        if (error.code !== 'invalid_grant' || !registeredClientId) throw error;
        previous ??= { clientId: registeredClientId };
        verified = await interact();
      }
      return await store.transaction(async ({ state, save }) => {
        const { profile, pending } = inspect(state);
        if ((profile ?? pending)?.clientId !== verified.clientId) throw changed();
        const completed = { ...verified, id: original.id, label: (profile ?? pending).label };
        if (profile) state.profiles[state.profiles.indexOf(profile)] = completed;
        else state.profiles.push(completed);
        state.pendingRegistrations = state.pendingRegistrations.filter(item => item.id !== original.id);
        state.activeProfileId = original.id;
        await save();
        // Keep the previous account usable until the new grant is durably active.
        if (addingAccount) invalidate();
        return publish(sessionFor(state));
      }, signal);
    } catch (error) {
      let failure = asError(error);
      if (signal.aborted) {
        failure = timeout.aborted && signal.reason === timeout.reason
          ? new ChatGPTError('authorization_timeout', '授权已超时，请重试。', true) : cancelled();
      }
      const restored = await store.transaction(({ state }) => sessionFor(state)).catch(() => disconnected());
      if (login === attempt && !updating) {
        publish(addingAccount || failure.code === 'cancelled' ? restored : { ...restored, error: failure.toJSON() });
      }
      throw failure;
    } finally {
      if (login === attempt) login = undefined;
    }
  }

  async function selectProfile(id) {
    idle();
    updating = true;
    invalidate();
    try {
      return publish(await store.transaction(async ({ state, save }) => {
        if (!state.profiles.some(profile => profile.id === id)) throw missingAccount();
        state.activeProfileId = id;
        await save();
        return sessionFor(state);
      }));
    } finally { updating = false; }
  }

  // A row action names the registration to revoke. The legacy disconnect
  // operation instead guards the active registration and may cancel a login.
  async function endConnection({ profileId, expectedProfileId }) {
    if (profileId) idle();
    else if (updating || signingOutProfile) throw new ChatGPTError('connection_busy', '账号正在切换。');
    signingOutProfile = profileId;
    updating = !profileId || profileId === displayed.profileId;
    if (updating) invalidate();
    if (!profileId) login?.controller.abort();
    try {
      const { session, revocation } = await store.transaction(async ({ state, save }) => {
        const profile = profileId ? state.profiles.find(item => item.id === profileId) : active(state);
        if (profileId && !profile) throw missingAccount();
        if (expectedProfileId !== undefined && expectedProfileId !== (profile?.id ?? null)) throw changed();
        const chooseNext = profileId && profileId === state.activeProfileId;
        if (chooseNext && !updating) {
          // A second Harness instance may have changed the active profile.
          updating = true;
          invalidate();
        }
        let revocation;
        if (profile) {
          if (profile.credentials || profile.pendingRefresh) {
            try { await revokeConnection(profile); }
            catch { revocation = new ChatGPTError('revocation_failed', '本机已退出，未确认远端撤销。可前往 ChatGPT 设置断开此应用。', true); }
          }
          state.profiles = state.profiles.filter(item => item.id !== profile.id);
          if (profile.id === state.activeProfileId) {
            const next = chooseNext ? state.profiles.find(sharing) ?? state.profiles.find(connected) : undefined;
            state.activeProfileId = next?.id;
          }
          await save();
        }
        return { session: sessionFor(state), revocation };
      });
      // Row failures are reported to the caller, not attached to a different account.
      if (updating) publish(revocation && !profileId ? { ...session, error: revocation.toJSON() } : session);
      if (revocation) throw revocation;
    } finally {
      updating = false;
      signingOutProfile = undefined;
    }
  }

  return {
    getSession, signIn, selectProfile,
    disconnect({ expectedProfileId = displayed.profileId } = {}) { return endConnection({ expectedProfileId }); },
    async signOutProfile(profileId) {
      if (typeof profileId !== 'string' || !profileId) throw missingAccount();
      await endConnection({ profileId });
    },
    cancelSignIn() { login?.controller.abort(); },
    listProfiles() {
      return store.transaction(({ state }) => [
        ...state.profiles.map(profile => ({ id: profile.id, label: profile.label, status: profile.status,
          sharing: sharing(profile), ...publicIdentity(profile.identity),
          ...(profile.requiresNewRegistration ? { requiresNewRegistration: true } : {}) })),
        ...state.pendingRegistrations.map(({ id, label }) => ({ id, label, ...disconnected(), pending: true })),
      ]);
    },
    subscribe(callback) {
      observers.add(callback);
      return () => { observers.delete(callback); };
    },
    listModels(options = {}) { return authenticated(options, listModels); },
    streamResponse(options) { return authenticated(options, (token, signal) => streamResponse(token, options, signal)); },
  };
}
