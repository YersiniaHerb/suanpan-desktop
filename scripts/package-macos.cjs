const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCommandBin } = require('../electron/codex-cli.cjs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MAC_DIR = path.join(DIST, 'mac');
const PRODUCT_NAME = '算盘';
const BUNDLE_ID = 'co.suanpan.desktop';

function run(cmd, args, options) {
  const opts = options || {};
  const res = spawnSync(cmd, args || [], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? 'pipe' : 'inherit',
  });
  if (res.status !== 0) {
    const stderr = res.stderr ? `\n${res.stderr}` : '';
    throw new Error(`${cmd} ${args.join(' ')} failed${stderr}`);
  }
  return res.stdout || '';
}

function commandExists(cmd) {
  const res = spawnSync('which', [cmd], { encoding: 'utf8' });
  return res.status === 0 && String(res.stdout || '').trim();
}

function readPackage() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

function appRootFromExecutable(bin) {
  const real = fs.realpathSync(bin);
  if (/Electron\.app\/Contents\/MacOS\/Electron$/.test(real)) {
    return path.dirname(path.dirname(path.dirname(real)));
  }
  return '';
}

function findElectronApp() {
  const explicit = String(process.env.ELECTRON_APP || '').trim();
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app'));
  const resolved = resolveCommandBin({
    command: 'electron',
    env: process.env,
    explicitEnvName: 'ELECTRON_BIN',
    notFoundMessage: 'Electron executable not found.',
  });
  if (resolved.ok) {
    const fromBin = appRootFromExecutable(resolved.bin);
    if (fromBin) candidates.push(fromBin);
  }
  candidates.push('/opt/homebrew/lib/node_modules/electron/dist/Electron.app');
  candidates.push('/usr/local/lib/node_modules/electron/dist/Electron.app');

  const found = candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, 'Contents', 'MacOS', 'Electron')));
  if (!found) {
    throw new Error('Electron.app not found. Install Electron locally, set ELECTRON_BIN, or set ELECTRON_APP.');
  }
  return found;
}

function copyRuntimeApp(resourcesApp) {
  fs.rmSync(resourcesApp, { recursive: true, force: true });
  fs.mkdirSync(resourcesApp, { recursive: true });
  ['package.json', 'electron', 'prototype', 'assets', 'README.md', 'LICENSE', 'SPEC.md', 'DESIGN.md'].forEach((rel) => {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, path.join(resourcesApp, rel), {
      recursive: true,
      filter: (item) => !/\/(dist|node_modules|\.git)(\/|$)/.test(item),
    });
  });
}

function walkFiles(dir, visitor) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const item = path.join(dir, entry.name);
    visitor(item, entry);
    if (entry.isDirectory()) walkFiles(item, visitor);
  });
}

function frameworkRelativeTarget(target) {
  if (!path.isAbsolute(target)) return '';
  const marker = `${path.sep}Contents${path.sep}Frameworks${path.sep}`;
  const index = target.indexOf(marker);
  return index === -1 ? '' : target.slice(index + marker.length);
}

function normalizeCopiedFrameworkSymlinks(appPath) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  walkFiles(frameworks, (item, entry) => {
    if (!entry.isSymbolicLink()) return;
    const currentTarget = fs.readlinkSync(item);
    const relToFrameworks = frameworkRelativeTarget(currentTarget);
    if (!relToFrameworks) return;
    const nextTargetAbs = path.join(frameworks, relToFrameworks);
    const nextTarget = path.relative(path.dirname(item), nextTargetAbs);
    fs.unlinkSync(item);
    fs.symlinkSync(nextTarget, item);
  });
}

function setPlistString(plist, key, value) {
  const replace = spawnSync('plutil', ['-replace', key, '-string', value, plist], { encoding: 'utf8' });
  if (replace.status === 0) return;
  run('plutil', ['-insert', key, '-string', value, plist], { quiet: true });
}

function removePlistKey(plist, key) {
  spawnSync('plutil', ['-remove', key, plist], { encoding: 'utf8' });
}

function generateIcns() {
  if (process.platform !== 'darwin') return '';
  const existing = path.join(ROOT, 'assets', 'suanpan-icon.icns');
  if (fs.existsSync(existing)) return existing;
  if (!commandExists('qlmanage') || !commandExists('sips') || !commandExists('iconutil')) return '';
  const svg = path.join(ROOT, 'assets', 'suanpan-logo.svg');
  if (!fs.existsSync(svg)) return '';
  const work = path.join(DIST, 'icon-work');
  const iconset = path.join(work, 'suanpan.iconset');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  try {
    run('qlmanage', ['-t', '-s', '1024', '-o', work, svg], { quiet: true });
    const png = fs.readdirSync(work).map((name) => path.join(work, name)).find((file) => /\.png$/i.test(file));
    if (!png) return '';
    [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ].forEach(([size, name]) => {
      run('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, name)], { quiet: true });
    });
    const out = path.join(work, 'suanpan.icns');
    run('iconutil', ['-c', 'icns', iconset, '-o', out], { quiet: true });
    return fs.existsSync(out) ? out : '';
  } catch (err) {
    return '';
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('package:mac must run on macOS.');
  }
  const pkg = readPackage();
  const version = String(pkg.version || '0.0.0');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const electronApp = findElectronApp();
  const appName = `${PRODUCT_NAME}.app`;
  const appPath = path.join(MAC_DIR, appName);
  const resources = path.join(appPath, 'Contents', 'Resources');
  const resourcesApp = path.join(resources, 'app');
  const artifactBase = `suanpan-desktop-v${version}-macos-${arch}`;
  const zipPath = path.join(DIST, `${artifactBase}.zip`);
  const manifestPath = path.join(DIST, 'latest-mac.json');

  fs.rmSync(MAC_DIR, { recursive: true, force: true });
  fs.mkdirSync(MAC_DIR, { recursive: true });
  fs.cpSync(electronApp, appPath, { recursive: true });
  normalizeCopiedFrameworkSymlinks(appPath);
  copyRuntimeApp(resourcesApp);

  const icon = generateIcns();
  if (icon) {
    fs.copyFileSync(icon, path.join(resources, 'suanpan.icns'));
  }

  const plist = path.join(appPath, 'Contents', 'Info.plist');
  setPlistString(plist, 'CFBundleDisplayName', PRODUCT_NAME);
  setPlistString(plist, 'CFBundleName', PRODUCT_NAME);
  setPlistString(plist, 'CFBundleIdentifier', BUNDLE_ID);
  setPlistString(plist, 'CFBundleShortVersionString', version);
  setPlistString(plist, 'CFBundleVersion', version);
  setPlistString(plist, 'LSApplicationCategoryType', 'public.app-category.finance');
  if (icon) setPlistString(plist, 'CFBundleIconFile', 'suanpan');
  [
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ].forEach((key) => removePlistKey(plist, key));

  fs.rmSync(zipPath, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appName, zipPath], { cwd: MAC_DIR });
  const stat = fs.statSync(zipPath);
  const manifest = {
    version,
    releaseDate: new Date().toISOString(),
    platform: 'macos',
    arch,
    artifactName: path.basename(zipPath),
    sha256: sha256(zipPath),
    size: stat.size,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    appPath,
    zipPath,
    manifestPath,
    electronApp,
    icon: !!icon,
  }, null, 2));
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
