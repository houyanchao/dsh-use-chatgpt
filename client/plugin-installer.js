const npmRegistry = 'https://registry.npmjs.org/';
const publishedVersion = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

function rpcValue(reply) {
  if (!reply?.ok) throw new Error(reply?.error?.message);
  return reply.value;
}

export function createPluginInstaller(ctx) {
  const listeners = new Set();
  const initial = { inventory: 'unavailable', installed: new Set(), pending: null, error: null };
  let state = initial;
  let connection;
  let revision = 0;

  function update(changes) {
    state = { ...state, ...changes };
    for (const listener of listeners) listener();
  }

  async function refresh() {
    if (!connection) return;
    const current = ++revision;
    try {
      const bundles = rpcValue(await connection.manager.listBundles());
      const installed = new Set(bundles.filter(bundle =>
        bundle.installed || bundle.availability === 'profile' || bundle.availability === 'installation')
        .map(bundle => bundle.name));
      if (current === revision) {
        update({ inventory: 'ready', installed, error: installed.has(state.error?.name) ? null : state.error });
      }
    } catch {
      if (current === revision) update({ inventory: 'failed' });
    }
  }

  ctx.inject(['remote', 'remote.pluginManager'], scope => {
    scope.effect(() => {
      // A reconnected scope may supply the same remote proxy with a new profile.
      connection = { manager: scope.remote.pluginManager };
      const recheck = () => { if (listeners.size) void refresh(); };
      const unsubscribe = scope.remote.$on('plugin-manager/changed', recheck);
      const reset = scope.on('connection/reset', recheck);
      globalThis.window?.addEventListener('focus', recheck);
      update({ ...initial, inventory: 'loading' });
      recheck();
      return () => {
        connection = undefined;
        revision++;
        update(initial);
        unsubscribe();
        reset();
        globalThis.window?.removeEventListener('focus', recheck);
      };
    }, 'dsh-use-chatgpt: recommended plugin inventory');
  });

  async function install(name) {
    if (!connection || state.inventory !== 'ready' || state.pending || state.installed.has(name)) return;
    const active = connection;
    const { manager } = active;
    update({ pending: name, error: null });
    try {
      const info = rpcValue(await manager.inspect(name, { registry: npmRegistry }));
      if (active !== connection) return;
      if (info.status !== 'accepted') {
        update({ error: { name, message: info.reason, problem: info.problem } });
        return;
      }
      if (info.registry !== npmRegistry || info.name !== name || info.bundle !== true
        || typeof info.version !== 'string' || !publishedVersion.test(info.version)) throw new Error();

      const requestId = globalThis.crypto?.randomUUID?.();
      const options = {
        registry: npmRegistry, enabled: true, expected: { name, version: info.version },
        ...(requestId && { requestId }),
      };
      let result;
      try {
        result = rpcValue(await manager.installBundle(`${name}@${info.version}`, options));
      } catch (error) {
        // A lost reply can leave pnpm running. Join that request before allowing a retry.
        if (!requestId || active !== connection) throw error;
        result = rpcValue(await manager.waitForInstall(requestId));
        if (!result) throw error;
      }
      if (!['applied', 'restart-required', 'overridden'].includes(result.application)) {
        throw new Error(result.error?.diagnostic || result.error?.code);
      }
    } catch (error) {
      if (active === connection) update({ error: { name, message: error.message } });
    } finally {
      if (active === connection) {
        await refresh();
        if (active === connection) update({ pending: null });
      }
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void refresh();
      return () => listeners.delete(listener);
    },
    install, refresh,
  };
}
