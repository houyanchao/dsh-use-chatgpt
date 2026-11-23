import manifest from '../package.json' with { type: 'json' };

const versionStatuses = new Set(['update_available', 'release_pending', 'up_to_date', 'latest_unstable']);
const updateStatuses = new Set([...versionStatuses, 'unpublished', 'unreachable']);
const startupRetryDelayMs = 750;

async function fetchPluginUpdate(signal) {
  try {
    const response = await fetch('/api/dsh-use-chatgpt/update', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return undefined;
    const { status, currentVersion, latestVersion } = await response.json();
    if (!updateStatuses.has(status) || typeof currentVersion !== 'string') return undefined;
    if (versionStatuses.has(status) && typeof latestVersion !== 'string') {
      return undefined;
    }
    return { status, currentVersion, ...(typeof latestVersion === 'string' ? { latestVersion } : {}) };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function waitForStartupRetry(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, startupRetryDelayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function readPluginUpdate(signal, { retryClientFailure = false } = {}) {
  let data = await fetchPluginUpdate(signal);
  if (!data && retryClientFailure) {
    await waitForStartupRetry(signal);
    data = await fetchPluginUpdate(signal);
  }
  return data ?? { status: 'unreachable', currentVersion: manifest.version };
}

export function openPluginDetails(ctx) {
  try {
    const navigation = ctx.get('pluginNavigation');
    if (typeof navigation?.openBundle !== 'function') return false;
    navigation.openBundle(manifest.name);
    return true;
  } catch {
    return false;
  }
}
