const https = require('https');

const DEFAULT_REPOSITORY = 'YersiniaHerb/suanpan-desktop';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 6000;

function cleanVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const match = text.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [0, 0, 0];
  return [
    Number(match[1]) || 0,
    Number(match[2]) || 0,
    Number(match[3]) || 0,
  ];
}

function compareVersions(a, b) {
  const av = cleanVersion(a);
  const bv = cleanVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function releaseApiUrl(repository) {
  return `https://api.github.com/repos/${repository || DEFAULT_REPOSITORY}/releases/latest`;
}

function requestJson(url, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'suanpan-desktop-update-check',
        ...(opts.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let payload = null;
        try {
          payload = body ? JSON.parse(body) : null;
        } catch (err) {
          reject(new Error(`更新响应解析失败：${err.message}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = payload && payload.message ? payload.message : `HTTP ${res.statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve(payload);
      });
    });
    req.setTimeout(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error('更新检测超时'));
    });
    req.on('error', reject);
  });
}

function preferredAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return list.find((asset) => /macos|darwin|mac/i.test(asset.name || '') && /\.(zip|dmg)$/i.test(asset.name || ''))
    || list.find((asset) => /\.(zip|dmg)$/i.test(asset.name || ''))
    || list[0]
    || null;
}

function parseRelease(release, currentVersion, checkedAt) {
  const tag = release && release.tag_name ? String(release.tag_name) : '';
  const latestVersion = tag.replace(/^v/i, '') || '';
  const asset = preferredAsset(release && release.assets);
  const updateAvailable = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;
  return {
    ok: true,
    checkedAt,
    source: 'github-releases',
    repository: DEFAULT_REPOSITORY,
    currentVersion: String(currentVersion || ''),
    latestVersion,
    updateAvailable,
    releaseName: (release && (release.name || release.tag_name)) || '',
    releaseUrl: (release && release.html_url) || '',
    publishedAt: (release && release.published_at) || '',
    assetName: asset ? asset.name : '',
    downloadUrl: asset ? asset.browser_download_url : '',
    message: updateAvailable ? `发现新版本 ${latestVersion}` : '已是最新版本',
  };
}

async function checkForUpdates(options) {
  const opts = options || {};
  const currentVersion = String(opts.currentVersion || '0.0.0');
  const repository = opts.repository || DEFAULT_REPOSITORY;
  const checkedAt = opts.now ? opts.now() : Date.now();
  const fetchJson = opts.fetchJson || ((url) => requestJson(url, { timeoutMs: opts.timeoutMs }));
  try {
    const release = await fetchJson(opts.url || releaseApiUrl(repository));
    return {
      ...parseRelease(release, currentVersion, checkedAt),
      repository,
    };
  } catch (err) {
    return {
      ok: false,
      checkedAt,
      source: 'github-releases',
      repository,
      currentVersion,
      latestVersion: '',
      updateAvailable: false,
      releaseName: '',
      releaseUrl: '',
      publishedAt: '',
      assetName: '',
      downloadUrl: '',
      message: '更新检测失败',
      error: err && err.message ? err.message : String(err),
    };
  }
}

function createUpdateService(options) {
  const opts = options || {};
  let status = {
    ok: null,
    checkedAt: 0,
    checking: false,
    source: 'github-releases',
    repository: opts.repository || DEFAULT_REPOSITORY,
    currentVersion: String(opts.currentVersion || '0.0.0'),
    latestVersion: '',
    updateAvailable: false,
    releaseName: '',
    releaseUrl: '',
    publishedAt: '',
    assetName: '',
    downloadUrl: '',
    message: '等待自动检测',
  };
  let inFlight = null;
  let interval = null;
  let startupTimer = null;

  function getStatus() {
    return { ...status };
  }

  async function check(reason) {
    if (inFlight) return inFlight;
    status = { ...status, checking: true, reason: reason || 'manual' };
    inFlight = checkForUpdates({
      currentVersion: status.currentVersion,
      repository: status.repository,
      timeoutMs: opts.timeoutMs,
      fetchJson: opts.fetchJson,
      now: opts.now,
      url: opts.url,
    }).then((next) => {
      status = { ...next, checking: false, reason: reason || 'manual' };
      return getStatus();
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start(onStatus) {
    const emit = (next) => {
      if (typeof onStatus === 'function') onStatus(next);
    };
    const run = (reason) => check(reason).then(emit).catch(() => emit(getStatus()));
    startupTimer = setTimeout(() => run('startup'), Number(opts.startupDelayMs) || DEFAULT_STARTUP_DELAY_MS);
    interval = setInterval(() => run('interval'), Number(opts.intervalMs) || DEFAULT_INTERVAL_MS);
  }

  function stop() {
    if (startupTimer) clearTimeout(startupTimer);
    if (interval) clearInterval(interval);
    startupTimer = null;
    interval = null;
  }

  return {
    check,
    getStatus,
    start,
    stop,
  };
}

module.exports = {
  DEFAULT_REPOSITORY,
  checkForUpdates,
  cleanVersion,
  compareVersions,
  createUpdateService,
  parseRelease,
  releaseApiUrl,
};
