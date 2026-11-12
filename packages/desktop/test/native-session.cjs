// Real Electron/CDP integration harness. No single-instance app or user profile.
const { app, BrowserWindow, WebContentsView } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
app.setPath('userData', process.env.NEXUS_TEST_DIRECTORY + '/profile');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 7000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await delay(30);
  }
}
(async () => {
  await app.whenReady();
  const { DesktopSession } = await import(pathToFileURL(resolve(__dirname, '../dist/session.js')).href);
  const win = new BrowserWindow({ show: true, width: 1000, height: 800 });
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1000, height: 800 });
  const session = new DesktopSession({ view, artifactsRoot: process.env.NEXUS_TEST_DIRECTORY + '/artifacts', captureDebounceMs: 100 });
  const events = [];
  session.subscribe((event) => events.push(event), false);
  await session.start();
  await session.goto(process.env.NEXUS_TEST_URL);
  await until(() => session.stateIndex().currentStateId !== null, 'initial DOM while image remains loading');
  const main = (await session.driver.frames()).find((frame) => frame.path === 'main');
  const evaluate = (expression) => session.driver.evaluate(main, `() => (${expression})`);
  const before = session.stateIndex().currentStateId;
  await evaluate(`document.querySelector('#username').focus()`);
  await view.webContents.insertText('test_user with space');
  await until(() => session.stateIndex().currentStateId !== before, 'native typing snapshot');
  const typed = session.stateIndex().currentStateId;
  view.webContents.focus();
  const point = await evaluate(`(() => { const r = document.querySelector('#login').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await until(() => session.stateIndex().currentStateId !== typed, 'login DOM change');
  const states = session.stateIndex().states.filter((entry) => !entry.stateId.startsWith('capture_')).map((entry) => session.state(entry.stateId));
  require('node:fs').writeFileSync(process.env.NEXUS_TEST_DIRECTORY + '/result.json', JSON.stringify({ events, states }));
  await session.close();
  app.exit(0);
})().catch((error) => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('Native harness timed out'); app.exit(1); }, 20000);
