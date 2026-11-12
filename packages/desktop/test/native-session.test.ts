import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { OrchestratorEvent, StateArtifact } from '@nexus/schema';
import { buildInteractionTimeline } from '../../ui/src/interaction-timeline.js';

it('records native typing and login DOM changes while the page still has an unfinished resource', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-native-'));
  const server = createServer((request, response) => {
    if (request.url === '/slow.jpg') return; // Deliberately never finishes loading.
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>Native capture</title><label>Username<input id="username"></label>
      <button id="login" onclick="document.querySelector('#result').textContent='Login submitted';document.querySelector('#username').hidden=true">Login</button>
      <div id="result"></div><img src="/slow.jpg">`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const env = { ...process.env, NEXUS_TEST_DIRECTORY: directory, NEXUS_TEST_URL: `http://127.0.0.1:${address.port}/` };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron') as string, [fileURLToPath(new URL('./native-session.cjs', import.meta.url))], { env });
  let errors = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { errors += String(chunk); });
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    expect(code, errors).toBe(0);
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) as { events: OrchestratorEvent[]; states: StateArtifact[] };
    expect(result.states.length).toBeGreaterThanOrEqual(3);
    const timeline = buildInteractionTimeline(result.events.filter((event) => event.t === 'dom.observed' || event.t === 'state.transition'), result.states.map((state) => ({ ...state, dom: state.dom ?? [] })));
    expect(timeline.find((step) => step.title === 'Type Username')?.value).toBe('test_user with space');
    expect(timeline.some((step) => step.title === 'Click Login')).toBe(true);
  } finally {
    child.kill(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
