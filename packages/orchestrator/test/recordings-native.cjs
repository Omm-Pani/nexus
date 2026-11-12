const { app, BrowserWindow, webContents } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve, join } = require('node:path');
const fs = require('node:fs/promises');
app.setPath('userData', join(process.env.NEXUS_RECORDING_DIRECTORY, 'profile'));
const delay = ms => new Promise(done => setTimeout(done, ms));
let shell;
const evaluate = source => shell.webContents.executeJavaScript(source);
async function until(source, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await evaluate(source)) return; await delay(40); }
  throw new Error('Timed out: ' + label + '\n' + await evaluate('document.body.innerText'));
}
async function click(text) {
  const source = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`;
  await until(`Boolean(${source})`, 'button ' + text);
  await evaluate(`${source}.click()`); await delay(60);
}
async function fill(selector, value) {
  await evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(50);
}
(async () => {
  await import(pathToFileURL(resolve(__dirname, '../../desktop/dist/main.js')).href);
  await app.whenReady();
  while (!BrowserWindow.getAllWindows()[0]) await delay(30);
  shell = BrowserWindow.getAllWindows()[0];
  await until("Boolean(document.querySelector('.app-header'))", 'interface');
  const url = process.env.NEXUS_RECORDING_URL;
  if (process.env.NEXUS_RECORDING_REOPEN === '1') {
    await click('Recordings');
    await until("document.querySelectorAll('.recording-card').length === 2", 'two recordings after restart');
    await evaluate("Array.from(document.querySelectorAll('.recording-open')).find(b => b.textContent.includes('Saved checkout')).click()");
    await until("document.querySelector('.page-heading strong')?.textContent === 'My checkout page'", 'saved page name after restart');
    if (!(await evaluate("document.querySelectorAll('.state-tab').length > 1"))) throw new Error('Saved states missing');
    await fs.writeFile(join(process.env.NEXUS_RECORDING_DIRECTORY, 'reopened.json'), JSON.stringify({ reopened: true }));
    app.exit(0); return;
  }
  await fill('.url-field input', url);
  await click('Load & Extract');
  await until("Boolean(document.querySelector('[role=dialog]'))", 'name dialog');
  await click('Cancel');
  await click('Load & Extract');
  await fill('.recording-dialog input', 'Checkout recording');
  await click('Start recording');
  await until("Boolean(document.querySelector('.page-heading strong')) && !document.querySelector('.capture-banner')", 'initial capture');
  await click('Rename');
  await fill('.page-name-editor input', 'My checkout page');
  await click('Save');
  await until("document.querySelector('.page-heading strong')?.textContent === 'My checkout page'", 'page rename');
  const target = webContents.getAllWebContents().find(contents => contents.getURL() === url);
  await target.executeJavaScript("document.querySelector('#quantity').value='3';document.querySelector('#count').textContent='3'");
  await until("document.querySelectorAll('.state-tab').length > 1", 'changed state');
  await click('Recordings');
  await until("document.querySelector('.recording-open')?.textContent.includes('recording')", 'active recording listed');
  await click('Stop recording');
  await until("Boolean(document.querySelector('.recording-open'))", 'saved recording');
  await evaluate("document.querySelector('.recording-open').click()");
  await until("document.querySelector('.page-heading strong')?.textContent === 'My checkout page'", 'saved page heading');
  const records = await evaluate("window.nexus.invoke('recordings.list')");
  const path = join(process.env.NEXUS_RECORDING_DIRECTORY,'profile','sessions', records[0].id,'observations.jsonl');
  const before = await fs.readFile(path, 'utf8');
  await target.executeJavaScript("document.querySelector('#count').textContent='99'");
  await delay(400);
  if ((await fs.readFile(path,'utf8')) !== before) throw new Error('Capture continued after Stop');
  await click('Rename recording');
  await fill('.recording-card form input', 'Saved checkout');
  await click('Save name');
  await until("document.querySelector('.recording-detail h2')?.textContent === 'Saved checkout'", 'recording rename');
  await delay(150);
  await fs.writeFile('/private/tmp/nexus-recordings-preview.png', (await shell.webContents.capturePage()).toPNG());
  await click('Back to inspector');
  await click('Load & Extract');
  await fill('.recording-dialog input', 'Second recording');
  await click('Start recording');
  await until("Boolean(document.querySelector('.page-heading strong')) && !document.querySelector('.capture-banner')", 'second recording capture');
  if ((await evaluate("document.querySelector('.page-heading strong').textContent")) === 'My checkout page') throw new Error('Page names leaked to new recording');
  await click('Stop recording');
  await until("document.querySelectorAll('.recording-card').length === 2", 'two separate recordings');
  await fs.writeFile(join(process.env.NEXUS_RECORDING_DIRECTORY, 'recorded.json'), JSON.stringify({ stopped: true, count: 2 }));
  app.exit(0);
})().catch(async error => {
  console.error(error);
  if (shell) await fs.writeFile('/private/tmp/nexus-recordings-failure.png', (await shell.webContents.capturePage()).toPNG()).catch(()=>{});
  app.exit(1);
});
setTimeout(() => { console.error('Recording harness timed out'); app.exit(1); }, 45000);
