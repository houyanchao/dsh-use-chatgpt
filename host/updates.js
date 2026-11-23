import manifest from '../package.json' with { type: 'json' };

const packageUrl = 'https://registry.npmjs.org/dsh-use-chatgpt';
const minimumReleaseAge = 24 * 60 * 60 * 1000;
const queryTimeout = 5_000;
const maxMetadataBytes = 256 * 1024;
const maxPackageHistoryBytes = 8 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const numericIdentifier = /^\d+$/;
const cacheTime = {
  update_available: 6 * 60 * 60 * 1000,
  release_pending: 6 * 60 * 60 * 1000,
  up_to_date: 6 * 60 * 60 * 1000,
  unpublished: 30 * 60 * 1000,
  unreachable: 5 * 60 * 1000,
};

function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = versionPattern.exec(value);
  if (match?.[0] !== value) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^0\d+$/.test(part))) return undefined;
  return { core: match.slice(1, 4), prerelease };
}

function compareIdentifiers(left, right) {
  if (left === right) return 0;
  const leftNumeric = numericIdentifier.test(left);
  const rightNumeric = numericIdentifier.test(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  if (leftNumeric && left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : 1;
}

function isNewer(latest, current) {
  for (let index = 0; index < latest.core.length; index += 1) {
    const precedence = compareIdentifiers(latest.core[index], current.core[index]);
    if (precedence) return precedence > 0;
  }
  if (!latest.prerelease.length) return current.prerelease.length > 0;
  if (!current.prerelease.length) return false;
  const sharedLength = Math.min(latest.prerelease.length, current.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const precedence = compareIdentifiers(latest.prerelease[index], current.prerelease[index]);
    if (precedence) return precedence > 0;
  }
  return latest.prerelease.length > current.prerelease.length;
}

async function readMetadata(response, maxBytes) {
  let bytes = 0;
  let json = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Registry metadata exceeded the request limit.');
    json += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(json + decoder.decode());
}

export function createUpdateChecker({
  currentVersion = manifest.version,
  fetch: fetchRegistry = globalThis.fetch,
  now = Date.now,
  signal,
} = {}) {
  const current = parseVersion(currentVersion);
  let cached;
  let expiresAt = 0;
  let pending;

  async function query() {
    const unreachable = { status: 'unreachable', currentVersion };
    if (!current) return unreachable;
    const timeout = AbortSignal.timeout(queryTimeout);
    try {
      const options = {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      };
      const response = await fetchRegistry(`${packageUrl}/latest`, options);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return response.status === 404 ? { status: 'unpublished', currentVersion } : unreachable;
      }
      const { name, version: latestVersion } = await readMetadata(response, maxMetadataBytes);
      const latest = parseVersion(latestVersion);
      if (name !== manifest.name || !latest) return unreachable;
      if (!isNewer(latest, current)) return { status: 'up_to_date', currentVersion, latestVersion };

      const history = await fetchRegistry(packageUrl, options);
      if (!history.ok) {
        await history.body?.cancel().catch(() => undefined);
        return unreachable;
      }
      const metadata = await readMetadata(history, maxPackageHistoryBytes);
      const latestTag = metadata?.['dist-tags']?.latest;
      if (metadata?.name !== name || (latestTag !== undefined && latestTag !== latestVersion)) return unreachable;
      const timestamp = metadata.time?.[latestVersion];
      const publishedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
      if (!Number.isFinite(publishedAt)) return unreachable;
      const eligibleAt = publishedAt + minimumReleaseAge;
      if (now() < eligibleAt) return { status: 'release_pending', currentVersion, latestVersion, eligibleAt };
      return { status: 'update_available', currentVersion, latestVersion };
    } catch {
      return unreachable;
    }
  }

  return async function checkUpdate() {
    if (cached && now() < expiresAt) return cached;
    if (pending) return pending;
    pending = query().then(({ eligibleAt, ...result }) => {
      cached = Object.freeze(result);
      expiresAt = Math.min(now() + cacheTime[result.status], eligibleAt ?? Infinity);
      return cached;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export function mountUpdates(ctx, signal) {
  const checkUpdate = createUpdateChecker({ signal });
  ctx.connection.fetch.register({
    path: '/api/dsh-use-chatgpt/update',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return Response.json(await checkUpdate(), { headers: { 'cache-control': 'no-store' } });
    },
  });
}
