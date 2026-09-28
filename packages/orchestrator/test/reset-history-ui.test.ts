import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { expect, it } from 'vitest';
import { createOrchestratorServer } from '../src/server.js';

it('resets both histories to the current DOM without changing the page, then records new changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-reset-'));
  let targetBrowser: Browser;
  const server = createOrchestratorServer({ managerDependencies: { artifactsRoot: directory, captureDebounceMs: 30, launchBrowser: async () => { targetBrowser = await chromium.launch(); return targetBrowser; } } });
  const uiBrowser = await chromium.launch();
  const page = await uiBrowser.newPage();
  page.setDefaultTimeout(6000);
  try {
    const address = await server.listen(0);
    await page.goto(address.url);
    expect(await page.getByRole('button', { name: 'Reset history' }).isDisabled()).toBe(true);
    await page.getByRole('textbox', { name: 'Website URL' }).fill(`${address.url}/fixtures/semantic-display.html`);
    const created = page.waitForResponse((response) => response.url().endsWith('/session') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Load & Extract' }).click();
    const { sessionId } = await (await created).json() as { sessionId: string };
    await page.getByRole('button', { name: /Initial page state/ }).waitFor();
    const target = targetBrowser!.contexts()[0]!.pages()[0]!;
    await target.getByLabel('Username', { exact: true }).fill('keep_this value');
    await target.getByLabel('Password', { exact: true }).fill('keep_password');
    await target.getByRole('button', { name: 'Hamburger Menu', exact: true }).click();
    await expect.poll(() => page.locator('.activity-step strong').filter({ hasText: /^Click Hamburger Menu$/ }).count()).toBe(1);
    await target.evaluate(() => {
      sessionStorage.setItem('reset-test', 'retained');
      (window as any).resetTestMarker = { alive: true };
      document.body.style.minHeight = '2400px';
      window.scrollTo(0, 300);
    });
    await server.manager.waitForIdle(sessionId);
    const readPage = () => target.evaluate(() => ({
      url: location.href, html: document.documentElement.outerHTML,
      username: (document.querySelector('[name=username]') as HTMLInputElement).value,
      password: (document.querySelector('[name=password]') as HTMLInputElement).value,
      scroll: [scrollX, scrollY], history: history.length,
      storage: sessionStorage.getItem('reset-test'), marker: (window as any).resetTestMarker,
    }));
    const before = await readPage();
    const previousIds = server.manager.getStateIndex(sessionId).states.map((state) => state.stateId);
    expect(previousIds.length).toBeGreaterThan(1);
    let navigations = 0;
    target.on('framenavigated', () => navigations++);
    await page.getByRole('button', { name: 'Reset history', exact: true }).click();
    await expect.poll(() => page.locator('.state-tab').count()).toBe(1);
    await expect.poll(() => page.locator('.activity-step strong').allTextContents()).toEqual(['Initial page state']);
    expect(await readPage()).toEqual(before);
    expect(navigations).toBe(0);
    const index = server.manager.getStateIndex(sessionId);
    expect(index.states).toHaveLength(1);
    expect(index.states[0]?.parentStateId).toBeUndefined();
    const baseline = index.currentStateId!;
    const replay: string[] = [];
    const unsubscribe = server.manager.subscribe(sessionId, (event) => replay.push(event.t));
    unsubscribe();
    expect(replay.filter((type) => type !== 'frame')[0]).toBe('history.reset');
    expect(replay).not.toContain('state.discovered');
    for (const socket of server.websocketServer.clients) socket.terminate();
    await expect.poll(() => server.websocketServer.clients.size).toBe(1);
    await expect.poll(() => page.locator('.activity-step strong').allTextContents()).toEqual(['Initial page state']);
    expect(await page.locator('.state-tab').count()).toBe(1);
    await target.getByLabel('Username', { exact: true }).fill('new_entry');
    await expect.poll(() => page.locator('.activity-step strong').filter({ hasText: /^Type Username$/ }).count()).toBe(1);
    expect(await page.locator('.activity-entry').filter({ hasText: 'Type Username' }).innerText()).toContain('Value: new_entry');
    await expect.poll(() => server.manager.getStateIndex(sessionId).currentStateId).not.toBe(baseline);
    // Repeating reset on the same document is safe, including an unchanged state ID.
    await page.getByRole('button', { name: 'Reset history', exact: true }).click();
    await expect.poll(() => page.locator('.activity-step strong').allTextContents()).toEqual(['Initial page state']);
    expect(await target.getByLabel('Username', { exact: true }).inputValue()).toBe('new_entry');
    expect(navigations).toBe(0);
  } finally { await uiBrowser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
