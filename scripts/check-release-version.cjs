const fs = require('fs');
const path = require('path');

function cleanVersion(value) {
  return String(value || '').trim().replace(/^refs\/tags\//, '').replace(/^v/i, '');
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const packageVersion = cleanVersion(pkg.version);
const tagVersion = cleanVersion(process.env.GITHUB_REF_NAME || process.env.TAG_NAME || process.argv[2] || '');

if (!packageVersion) {
  throw new Error('package.json version is empty');
}

if (tagVersion && tagVersion !== packageVersion) {
  throw new Error(`Release tag v${tagVersion} does not match package version v${packageVersion}`);
}

console.log(`release version ok: v${packageVersion}`);
