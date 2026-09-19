// Dependency-free Electron smoke: real built app, headless.
// Asserts window title, renderer load, bridge, no node integration, navigation.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
process.on('unhandledRejection', function (error) {
  process.stdout.write('FAIL unhandled: ' + String(error) + '\n');
  process.exit(1);
});
setTimeout(function () {
  process.stdout.write('FAIL smoke timeout\n');
  process.exit(2);
}, 90000).unref();
function check(name, ok, detail) {
  process.stdout.write((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' -- ' + detail : '') + '\n');
  return ok;
}
let failures = 0;
function expect(name, ok, detail) {
  if (!check(name, ok, detail)) failures += 1;
}
import('electron')
  .then(function (electron) {
    const app = electron.app;
    const BrowserWindow = electron.BrowserWindow;
    return app.whenReady().then(function () {
      return run(electron, app, BrowserWindow);
    });
  })
  .then(function () {
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(function (error) {
    process.stdout.write('FAIL fatal: ' + String(error) + '\n');
    process.exit(1);
  });
async function run(electron, app, BrowserWindow) {
  const here = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = join(here, '..');
  const dataRoot = await mkdtemp(join(tmpdir(), 'sentry-electron-smoke-'));
  process.env['SENTRY_DATA_ROOT'] = dataRoot;
  const boot = await import(pathToFileURL(join(desktopRoot, 'dist', 'main', 'bootstrap.js')).href);
  try {
    const bootstrapped = await boot.bootstrapDesktop(dataRoot);
    expect('bootstrap recovers and constructs service', true, '');
    bootstrapped.close();
  } catch (error) {
    expect('bootstrap recovers and constructs service', false, String(error));
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    title: 'Sentry',
    backgroundColor: '#0b0e14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(desktopRoot, 'dist', 'preload', 'preload.js'),
    },
  });
  expect('BrowserWindow launches', !win.isDestroyed(), '');
  expect('window title Sentry', win.getTitle() === 'Sentry', win.getTitle());
  await win.loadFile(join(desktopRoot, 'dist', 'renderer', 'index.html'));
  const loaded = await win.webContents.executeJavaScript(
    "({ title: document.title, hasRoot: !!document.getElementById('root') })",
  );
  expect('renderer loads', loaded.hasRoot === true, JSON.stringify(loaded));
  const bridge = await win.webContents.executeJavaScript(
    '(typeof window.sentry !== "undefined" ? Object.keys(window.sentry).join(",") : "MISSING")',
  );
  expect('window.sentry available', bridge !== 'MISSING', String(bridge).slice(0, 120));
  const nodeExp = await win.webContents.executeJavaScript(
    '((typeof window.require !== "undefined") || (typeof window.process !== "undefined")) ? "EXPOSED" : "clean"',
  );
  expect('Node integration not exposed', nodeExp === 'clean', String(nodeExp));
  await win.webContents.executeJavaScript('location.hash = "#/projects"');
  await new Promise(function (resolve) {
    setTimeout(resolve, 1500);
  });
  const url = win.webContents.getURL();
  expect('navigation works', url.indexOf('#/projects') !== -1, url);
  const body = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 120)');
  expect(
    'renderer content visible',
    typeof body === 'string' && body.length > 0,
    String(body).slice(0, 80),
  );
  process.stdout.write('Electron smoke failures: ' + String(failures) + '\n');
  win.destroy();
  await app.whenReady();
}
