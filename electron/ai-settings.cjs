const fs = require('fs');
const path = require('path');

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  const text = cleanText(value).replace(/\/+$/, '');
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch (err) {
    throw new Error('Base URL 必须是 http 或 https 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 必须是 http 或 https 地址');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function maskApiKey(apiKey) {
  const text = cleanText(apiKey);
  if (!text) return '';
  if (text.length <= 8) return '已保存';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (err) {}
}

function createAiSettingsStore(filePath, cryptoOps) {
  if (!filePath) throw new Error('filePath is required');
  const crypto = cryptoOps || {};

  function decryptApiKey(raw) {
    if (!raw || typeof raw !== 'object') return '';
    if (raw.apiKeyEncrypted && typeof crypto.decrypt === 'function') {
      try {
        return cleanText(crypto.decrypt(raw.apiKeyEncrypted));
      } catch (err) {
        return '';
      }
    }
    return cleanText(raw.apiKeyPlain);
  }

  function encodeApiKey(apiKey) {
    const text = cleanText(apiKey);
    if (!text) return {};
    if (typeof crypto.encrypt === 'function') {
      try {
        return {
          apiKeyEncrypted: crypto.encrypt(text),
          apiKeyEncoding: 'electron-safeStorage-v1',
        };
      } catch (err) {}
    }
    return {
      apiKeyPlain: text,
      apiKeyEncoding: 'plain-v1',
    };
  }

  function privateState() {
    const raw = readJson(filePath);
    let baseUrl = '';
    try {
      baseUrl = normalizeBaseUrl(raw.baseUrl || '');
    } catch (err) {
      baseUrl = '';
    }
    return {
      apiKey: decryptApiKey(raw),
      baseUrl,
    };
  }

  function publicState() {
    const current = privateState();
    return {
      configured: !!(current.apiKey || current.baseUrl),
      hasApiKey: !!current.apiKey,
      apiKeyLabel: maskApiKey(current.apiKey),
      hasBaseUrl: !!current.baseUrl,
      baseUrl: current.baseUrl,
    };
  }

  function save(patch) {
    const current = privateState();
    const input = patch && typeof patch === 'object' ? patch : {};
    const apiKeyInput = cleanText(input.apiKey);
    const clearApiKey = !!input.clearApiKey;
    const nextApiKey = clearApiKey ? '' : (apiKeyInput || current.apiKey);
    const nextBaseUrl = normalizeBaseUrl(input.baseUrl || '');
    writeJson(filePath, {
      version: 1,
      baseUrl: nextBaseUrl,
      updatedAt: Date.now(),
      ...encodeApiKey(nextApiKey),
    });
    return publicState();
  }

  return {
    privateState,
    publicState,
    save,
    path: filePath,
  };
}

module.exports = {
  createAiSettingsStore,
  normalizeBaseUrl,
};
