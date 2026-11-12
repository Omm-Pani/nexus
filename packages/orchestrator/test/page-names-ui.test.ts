import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { expect, it } from 'vitest';
import { createOrchestratorServer } from '../src/server.js';

it('renames page groups, preserves the override across captures, and restores the automatic title', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-names-ui-'));
  let targetBrowser: Browser;
  const server = createOrchestratorServer({ managerDependencies: {
    artifactsRoot: directory, captureDebounceMs: 30,
    launchBrowser: async () => { targetBrowser = await chromium.launch(); return targetBrowser; },
  } });
  let uiBrowser: Browser | undefined;
  try {
    uiBrowser = await chromium.launch();
    const page = await uiBrowser.newPage();
    const address = await server.listen(0);
    const url = `${address.url}/fixtures/semantic-display.html`;
    await page.goto(address.url);
    await page.getByRole('textbox', { name: 'Website URL' }).fill(url);
    const created = page.waitForResponse((response) => response.url().endsWith('/session') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Load & Extract' }).click();
    const { sessionId } = await (await created).json() as { sessionId: string };
    await page.locator('.page-heading strong').waitFor();
    await server.manager.waitForIdle(sessionId);
    const title = await page.locator('.page-heading strong').innerText();
    const stateId = server.manager.getStateIndex(sessionId).currentStateId;
    await page.getByRole('button', { name: /^Rename / }).click();
    await page.getByRole('textbox', { name: 'Page group name' }).fill('   ');
    expect(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('textbox', { name: 'Page group name' }).fill('Checkout flow');
    await page.route('**/page-names', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Could not save name' } }) })
      : route.continue());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Could not save name' }).waitFor();
    expect(await page.locator('.page-heading strong').innerText()).toBe(title);
    await page.unroute('**/page-names');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => page.locator('.page-heading strong').innerText()).toBe('Checkout flow');
    expect(server.manager.getStateIndex(sessionId).currentStateId).toBe(stateId);
    expect(JSON.parse(await readFile(join(directory, sessionId, 'page-names.json'), 'utf8'))).toEqual({ [url]: 'Checkout flow' });
    const target = targetBrowser!.contexts()[0]!.pages()[0]!;
    await target.evaluate(() => { document.title = 'A changed website title'; });
    await expect.poll(() => server.manager.getStateIndex(sessionId).currentStateId).not.toBe(stateId);
    expect(await page.locator('.page-heading strong').innerText()).toBe('Checkout flow');
    for (const socket of server.websocketServer.clients) socket.terminate();
    await expect.poll(() => server.websocketServer.clients.size).toBe(1);
    expect(await page.locator('.page-heading strong').innerText()).toBe('Checkout flow');
    await page.getByRole('button', { name: 'Rename Checkout flow' }).click();
    await page.getByRole('button', { name: 'Use page title', exact: true }).click();
    await expect.poll(() => page.locator('.page-heading strong').innerText()).toBe(title);
    expect(JSON.parse(await readFile(join(directory, sessionId, 'page-names.json'), 'utf8'))).toEqual({});
  } finally {
    await uiBrowser?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
