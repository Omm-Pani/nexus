import { EventEmitter, once } from 'node:events';
import type { StateArtifact } from '@nexus/schema';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Frame,
  Page,
} from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOrchestratorServer, type OrchestratorServer } from '../src/server.js';

const openServers: OrchestratorServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

function serverFixture() {
  let url = 'about:blank';
  const frame = {
    url: () => url,
    evaluate: vi.fn(async () => []),
  } as unknown as Frame;
  const pageEmitter = new EventEmitter();
  const page = Object.assign(pageEmitter, {
    url: () => url,
    goto: vi.fn(async (next: string) => {
      url = next;
      pageEmitter.emit('framenavigated', frame);
      return null;
    }),
    mainFrame: () => frame,
    frames: () => [frame],
    mouse: {
      move: vi.fn(async () => undefined),
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      wheel: vi.fn(async () => undefined),
    },
    keyboard: {
      down: vi.fn(async () => undefined),
      up: vi.fn(async () => undefined),
      insertText: vi.fn(async () => undefined),
    },
  }) as unknown as Page;

  const cdpEmitter = new EventEmitter();
  const cdp = Object.assign(cdpEmitter, {
    send: vi.fn(async () => ({})),
    detach: vi.fn(async () => undefined),
  }) as unknown as CDPSession;
  const context = Object.assign(new EventEmitter(), {
    newPage: vi.fn(async () => page),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => undefined),
  }) as unknown as BrowserContext;
  const contexts: BrowserContext[] = [];
  const browser = {
    contexts: () => [...contexts],
    newContext: vi.fn(async () => {
      contexts.push(context);
      return context;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;

  const scan = vi.fn(async (): Promise<StateArtifact> => ({
    schemaVersion: 1,
    stateId: 'state-http',
    url,
    routeTemplate: '/',
    title: 'HTTP fixture',
    personaId: 'anonymous',
    buildId: 'test',
    capturedAt: '2026-08-19T00:00:00.000Z',
    timings: { total: 1 },
    groups: [],
    actions: [],
    observables: [],
    collections: [],
    warnings: [],
  }));

  return { browser, cdp, page, scan };
}

describe('orchestrator HTTP and WebSocket service', () => {
  it('responds with the session id before initial navigation completes', async () => {
    const fixture = serverFixture();
    let releaseNavigation = (): void => undefined;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    vi.mocked(fixture.page.goto).mockImplementation(async () => {
      await navigationGate;
      return null;
    });
    const server = createOrchestratorServer({
      staticDirectory: false,
      fixtureDirectory: false,
      managerDependencies: {
        launchBrowser: async () => fixture.browser,
        installInstrumentation: async () => undefined,
        createCdpSession: async () => fixture.cdp,
        scan: fixture.scan,
        writeBundle: async () => ({
          manifest: '/tmp/manifest.json',
          state: '/tmp/state.json',
          warnings: '/tmp/warnings.json',
        }),
        captureDebounceMs: 0,
        logger: { error: vi.fn(), warn: vi.fn() },
      },
    });
    openServers.push(server);
    let address: Awaited<ReturnType<OrchestratorServer['listen']>>;
    try {
      address = await server.listen(0);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EPERM'
      ) {
        releaseNavigation();
        return;
      }
      throw error;
    }

    try {
      const response = await Promise.race([
        fetch(`${address.url}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://slow.example.test/' }),
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('POST /session waited for navigation')), 500);
        }),
      ]);
      expect(response.status).toBe(201);
      const created = (await response.json()) as { sessionId: string };
      expect(server.manager.snapshot(created.sessionId).events).toContainEqual(
        expect.objectContaining({ t: 'extraction.started' }),
      );
      releaseNavigation();
      await server.manager.waitForIdle(created.sessionId);
    } finally {
      releaseNavigation();
    }
  });
});
