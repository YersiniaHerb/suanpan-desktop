const fs = require('fs');
const path = require('path');

const DEFAULT_EXEC_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];
const DEFAULT_CODEX_PATH_DIRS = DEFAULT_EXEC_PATH_DIRS;

function unique(items) {
  const out = [];
  const seen = new Set();
  (items || []).forEach((item) => {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  });
  return out;
}

function splitPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasPathSeparator(value) {
  return /[\\/]/.test(String(value || ''));
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

function commandNames(command) {
  const base = command || 'codex';
  if (process.platform !== 'win32') return [base];
  if (/\.(cmd|exe|bat)$/i.test(base)) return [base];
  return [`${base}.cmd`, `${base}.exe`, base];
}

function searchDirs(env, defaultPathDirs) {
  return unique([
    ...splitPath(env && env.PATH),
    ...(defaultPathDirs || DEFAULT_EXEC_PATH_DIRS),
  ]);
}

function resolveCommandBin(options) {
  const config = options || {};
  const command = config.command || 'codex';
  const explicitEnvName = config.explicitEnvName || '';
  const sourceEnv = config.env || process.env;
  const defaultPathDirs = config.defaultPathDirs || DEFAULT_EXEC_PATH_DIRS;
  const explicit = explicitEnvName ? String(sourceEnv[explicitEnvName] || '').trim() : '';
  const searched = [];

  if (explicit) {
    const candidates = hasPathSeparator(explicit)
      ? [explicit]
      : searchDirs(sourceEnv, defaultPathDirs).flatMap((dir) => commandNames(explicit).map((name) => path.join(dir, name)));
    for (const candidate of candidates) {
      searched.push(candidate);
      if (isExecutable(candidate)) {
        return { ok: true, bin: candidate, source: explicitEnvName, searched };
      }
    }
    return {
      ok: false,
      bin: '',
      source: explicitEnvName,
      searched,
      message: `${explicitEnvName} is set but not executable: ${explicit}`,
    };
  }

  for (const dir of searchDirs(sourceEnv, defaultPathDirs)) {
    for (const name of commandNames(command)) {
      const candidate = path.join(dir, name);
      searched.push(candidate);
      if (isExecutable(candidate)) {
        return { ok: true, bin: candidate, source: dir, searched };
      }
    }
  }

  return {
    ok: false,
    bin: '',
    source: '',
    searched,
    message: config.notFoundMessage || `${command} executable was not found in PATH or standard local bin directories.`,
  };
}

function resolveCodexBin(env) {
  return resolveCommandBin({
    command: 'codex',
    env,
    explicitEnvName: 'COSTOCK_CODEX_BIN',
    notFoundMessage: 'Codex CLI executable was not found in PATH, /opt/homebrew/bin, or /usr/local/bin.',
  });
}

function createCommandExecEnv(baseEnv, bin, defaultPathDirs) {
  const env = { ...(baseEnv || process.env) };
  const dirs = unique([
    bin ? path.dirname(bin) : '',
    ...splitPath(env.PATH),
    ...(defaultPathDirs || DEFAULT_EXEC_PATH_DIRS),
  ]);
  env.PATH = dirs.join(path.delimiter);
  return env;
}

function createCodexExecEnv(baseEnv, codexBin, aiSettings) {
  const env = createCommandExecEnv(baseEnv, codexBin, DEFAULT_CODEX_PATH_DIRS);
  const settings = aiSettings || {};
  const apiKey = String(settings.apiKey || '').trim();
  const baseUrl = String(settings.baseUrl || '').trim();
  if (apiKey) {
    env.OPENAI_API_KEY = apiKey;
    delete env.CODEX_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
  }
  if (baseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_API_BASE = baseUrl;
    env.API_BASE_URL = baseUrl;
  }
  return env;
}

module.exports = {
  DEFAULT_CODEX_PATH_DIRS,
  DEFAULT_EXEC_PATH_DIRS,
  createCommandExecEnv,
  createCodexExecEnv,
  resolveCommandBin,
  resolveCodexBin,
};
