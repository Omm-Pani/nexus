import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('records and stops in native Electron, preserves names and states across restart, and isolates subsequent recordings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-recordings-desktop-'));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>Recording fixture</title><main><h1>Cart</h1><label>Quantity<input id="quantity" value="1"></label><button>Add item</button><p id="count">1</p></main>');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/cart`;
  const executable = createRequire(resolve('packages/desktop/package.json'))('electron') as string;
  const env = { ...process.env, NEXUS_RECORDING_DIRECTORY: directory, NEXUS_RECORDING_URL: url };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const run = (reopen: boolean) => new Promise<void>((done, fail) => {
    const child = spawn(executable, [resolve('packages/orchestrator/test/recordings-native.cjs')], { env: { ...env, NEXUS_RECORDING_REOPEN: reopen ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => output += String(chunk));
    child.stderr.on('data', chunk => output += String(chunk));
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(output)));
  });
  try {
    await run(false);
    expect(JSON.parse(await readFile(join(directory, 'recorded.json'), 'utf8'))).toEqual({ stopped: true, count: 2 });
    await run(true);
    expect(JSON.parse(await readFile(join(directory, 'reopened.json'), 'utf8'))).toEqual({ reopened: true });
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
}, 100000);
