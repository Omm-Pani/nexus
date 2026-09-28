import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { expect, it } from 'vitest';
import type { OrchestratorEvent } from '@nexus/schema';
import { createOrchestratorServer } from '../src/server.js';

it('captures load and manual interactions, persists transitions, and exposes no automation routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-live-'));
  let browser: Browser;
  const server = createOrchestratorServer({
    staticDirectory: false,
    managerDependencies: {
      artifactsRoot: directory,
      captureDebounceMs: 20,
      launchBrowser: async () => { browser = await chromium.launch(); return browser; },
    },
  });
  const events: OrchestratorEvent[] = [];

  try {
    const address = await server.listen(0);
    const created = await fetch(`${address.url}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `${address.url}/fixtures/dom-inventory.html` }) });
    const { sessionId } = await created.json() as { sessionId: string };
    server.manager.subscribe(sessionId, (event) => events.push(event));
    await server.manager.waitForIdle(sessionId);
    const page = browser!.contexts()[0]!.pages()[0]!;
    const firstId = server.manager.getStateIndex(sessionId).currentStateId!;
    expect(server.manager.getState(sessionId, firstId).dom![0]!.elements.some((element) => element.attributes.id === 'value')).toBe(true);
    await page.getByRole('button', { name: 'Change' }).click();
    await expect.poll(() => server.manager.getStateIndex(sessionId).currentStateId, { timeout: 5000 }).not.toBe(firstId);
    await expect.poll(() => {
      const current = server.manager.getStateIndex(sessionId).currentStateId!;
      return server.manager.getState(sessionId, current).dom?.flatMap((frame) => frame.elements).find((element) => element.attributes.id === 'value')?.text;
    }, { timeout: 5000 }).toBe('After');
    await page.locator('#plain').fill('typed');
    await expect.poll(() => events.some((event) => event.t === 'dom.observed' && event.batch.observations.some((entry) => entry.type === 'input'))).toBe(true);
    await server.manager.waitForIdle(sessionId);
    expect(events.some((event) => event.t === 'state.transition' && event.fromStateId === firstId)).toBe(true);
    for (const path of [`/session/${sessionId}/execute`, `/session/${sessionId}/context`, '/settings/model']) {
      const response = await fetch(address.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(404);
    }
    await server.manager.closeSession(sessionId);
    const journal = (await readFile(join(directory, sessionId, 'observations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as OrchestratorEvent);
    expect(journal.some((event) => event.t === 'dom.observed' && event.batch.observations.some((entry) => entry.type === 'click'))).toBe(true);
    expect(journal.some((event) => event.t === 'state.transition')).toBe(true);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
