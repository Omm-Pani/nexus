import { EventEmitter } from 'node:events';

import type {
  Action,
  
  OrchestratorEvent,
  
  StateArtifact,
} from '@nexus/schema';
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Frame,
  Page,
} from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  parseCreateSessionRequest,
  parseInputCommand,
  
  SessionManager,
  type SessionManagerDependencies,
} from '../src/session-manager.js';

function artifact(stateId: string, url: string): StateArtifact {
  return {
    schemaVersion: 1,
    stateId,
    url,
    routeTemplate: new URL(url).pathname,
    title: stateId,
    personaId: 'anonymous',
    buildId: 'test',
    capturedAt: '2026-08-19T00:00:00.000Z',
    timings: { total: 10 },
    groups: [
      {
        id: 'g1',
        label: 'Main',
        kind: 'main',
        global: false,
        conditional: false,
        actions: ['e1'],
        observables: [],
      },
    ],
    actions: [
      {
        id: 'e1',
        stableId: 'stable-1',
        label: 'Continue',
        type: 'button',
        kind: 'unknown',
        risk: 'unknown',
        confidence: 1,
        evidence: ['native_tag'],
        state: { disabled: false },
        visible: true,
        inViewport: true,
        hitTestable: true,
        occludedBy: null,
        region: 'g1',
        frame: 'main',
        shadowPath: [],
        rect: { x: 1, y: 2, w: 3, h: 4 },
        locators: [],
      },
    ],
    observables: [],
    collections: [],
    warnings: [],
  };
}

function fakeLifecycle() {
  const order: string[] = [];
  const pageEmitter = new EventEmitter();
  let settledBinding:
    | ((source: unknown, state: unknown) => void | Promise<void>)
    | null = null;
  let currentUrl = 'about:blank';
  const frame = {
    url: () => currentUrl,
    evaluate: vi.fn(async () => []),
  } as unknown as Frame;
  const page = Object.assign(pageEmitter, {
    goto: vi.fn(async (url: string) => {
      order.push('goto');
      currentUrl = url;
      pageEmitter.emit('framenavigated', frame);
      return null;
    }),
    url: vi.fn(() => currentUrl),
    title: vi.fn(async () => 'Example'),
    waitForLoadState: vi.fn(async () => undefined),
    exposeBinding: vi.fn(
      async (
        _name: string,
        callback: (source: unknown, state: unknown) => void | Promise<void>,
      ) => {
        settledBinding = callback;
      },
    ),
    mainFrame: vi.fn(() => frame),
    frames: vi.fn(() => [frame]),
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

  const contextEmitter = new EventEmitter();
  const context = Object.assign(contextEmitter, {
    newPage: vi.fn(async () => {
      order.push('newPage');
      return page;
    }),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
    close: vi.fn(async () => undefined),
  }) as unknown as BrowserContext;

  const contexts: BrowserContext[] = [];
  const browser = {
    contexts: vi.fn(() => [...contexts]),
    newContext: vi.fn(async () => {
      order.push('newContext');
      contexts.push(context);
      return context;
    }),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;

  return {
    browser,
    cdp,
    context,
    frame,
    order,
    page,
    hardNavigate: async (url: string) => {
      currentUrl = url;
      cdpEmitter.emit('Page.frameNavigated', {
        frame: { id: 'main-frame', url },
      });
      pageEmitter.emit('framenavigated', frame);
    },
    settled: async (state: unknown = { settled: true }) => {
      if (settledBinding === null) throw new Error('Settled binding was not installed.');
      await settledBinding({ frame }, state);
    },
  };
}

function testManager(
  lifecycle: ReturnType<typeof fakeLifecycle>,
  overrides: SessionManagerDependencies = {},
) {
  let scanCount = 0;
  const scan = vi.fn(async (page: Page) => {
    scanCount += 1;
    return artifact(`state-${scanCount}`, page.url());
  });
  const logger = { error: vi.fn(), warn: vi.fn() };
  const manager = new SessionManager({
    launchBrowser: async () => lifecycle.browser,
    installInstrumentation: async () => undefined,
    scan,
    writeBundle: async () => ({
      manifest: '/tmp/manifest.json',
      state: '/tmp/state.json',
      warnings: '/tmp/warnings.json',
    }),
    createCdpSession: async () => lifecycle.cdp,
    artifactsRoot: '/tmp/nexus-orchestrator-focused-test',
    captureDebounceMs: 5,
    logger,
    ...overrides,
  });
  return { logger, manager, scan };
}



describe('SessionManager', () => {

  it('returns a session before slow initial navigation completes', async () => {
    const lifecycle = fakeLifecycle();
    let finishNavigation = (): void => undefined;
    let navigationFinished = false;
    const navigationGate = new Promise<void>((resolve) => {
      finishNavigation = () => {
        navigationFinished = true;
        resolve();
      };
    });
    vi.mocked(lifecycle.page.goto).mockImplementation(async (url: string) => {
      await navigationGate;
      // The common fake owns URL mutation, so delegate after the delay.
      return null;
    });
    const { manager } = testManager(lifecycle);

    const sessionId = await manager.createSession({ url: 'https://slow.example.test/' });
    expect(navigationFinished).toBe(false);
    expect(manager.sessionCount).toBe(1);
    expect(manager.snapshot(sessionId).events).toContainEqual(
      expect.objectContaining({ t: 'extraction.started' }),
    );

    finishNavigation();
    await manager.waitForIdle(sessionId);
    await manager.close();
  });

  it('serializes concurrent input and debounces state-changing keyboard events', async () => {
    const lifecycle = fakeLifecycle();
    const inputOrder: string[] = [];
    let releasePress = (): void => undefined;
    const pressGate = new Promise<void>((resolve) => {
      releasePress = resolve;
    });
    const cdp = Object.assign(new EventEmitter(), {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method.startsWith('Input.')) {
          inputOrder.push(String(params.type));
          if (params.type === 'mousePressed') await pressGate;
        }
        return {};
      }),
      detach: vi.fn(async () => undefined),
    }) as unknown as CDPSession;
    const { manager, scan } = testManager(lifecycle, {
      createCdpSession: async () => cdp,
    });
    const sessionId = await manager.createSession({ url: 'https://example.test/' });
    await manager.waitForIdle(sessionId);

    const pressed = manager.dispatchInput(sessionId, {
      kind: 'mouse',
      type: 'mousePressed',
      x: 10,
      y: 10,
      button: 'left',
    });
    await vi.waitFor(() => expect(inputOrder).toEqual(['mousePressed']));
    const released = manager.dispatchInput(sessionId, {
      kind: 'mouse',
      type: 'mouseReleased',
      x: 10,
      y: 10,
      button: 'left',
    });
    await Promise.resolve();
    expect(inputOrder).toEqual(['mousePressed']);
    releasePress();
    await Promise.all([pressed, released]);
    expect(inputOrder).toEqual(['mousePressed', 'mouseReleased']);
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(2);

    await manager.dispatchInput(sessionId, {
      kind: 'mouse',
      type: 'mouseMoved',
      x: 20,
      y: 25,
    });
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(2);

    await Promise.all([
      manager.dispatchInput(sessionId, {
        kind: 'key',
        type: 'char',
        text: 'x',
      }),
      manager.dispatchInput(sessionId, {
        kind: 'key',
        type: 'keyUp',
        key: 'x',
        code: 'KeyX',
      }),
    ]);
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(3);

    await manager.dispatchInput(sessionId, {
      kind: 'key',
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
    });
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(4);
    await manager.close();
  });

  it('captures programmatic mutations after the in-page settled signal', async () => {
    const lifecycle = fakeLifecycle();
    const { manager, scan } = testManager(lifecycle);
    const sessionId = await manager.createSession({ url: 'https://example.test/' });
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(1);

    await lifecycle.settled({ settled: false });
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(1);
    await lifecycle.settled({ settled: true, inflight: 0, msSinceLastMutation: 151 });
    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('waits for initial navigation and its capture before dispatching input', async () => {
    const lifecycle = fakeLifecycle();
    let releaseNavigation = (): void => undefined;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    const originalGoto = vi.mocked(lifecycle.page.goto).getMockImplementation();
    vi.mocked(lifecycle.page.goto).mockImplementation(async (...args) => {
      await navigationGate;
      return originalGoto?.(...args) ?? null;
    });
    const { manager } = testManager(lifecycle);
    const sessionId = await manager.createSession({ url: 'https://slow.example.test/' });

    const input = manager.dispatchInput(sessionId, {
      kind: 'mouse',
      type: 'mousePressed',
      x: 10,
      y: 20,
      button: 'left',
    });
    await Promise.resolve();
    expect(lifecycle.cdp.send).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    );

    releaseNavigation();
    await input;
    expect(lifecycle.cdp.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 10, y: 20 }),
    );
    await manager.close();
  });

  it('queues one follow-up when the page settles after walking starts without self-looping', async () => {
    const lifecycle = fakeLifecycle();
    let scanCount = 0;
    const scan = vi.fn(async (page: Page, options) => {
      scanCount += 1;
      await options?.onPhase?.('settling');
      // The extractor's own quiescence signal must not recursively recapture.
      await lifecycle.settled({ settled: true });
      await options?.onPhase?.('walking');
      if (scanCount === 1) {
        // This signal represents a mutation that settled after reading began.
        await lifecycle.settled({ settled: true });
      }
      return artifact(`state-${scanCount}`, page.url());
    });
    const { manager } = testManager(lifecycle, { scan });
    const sessionId = await manager.createSession({ url: 'https://example.test/' });

    await manager.waitForIdle(sessionId);
    expect(scan).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(2);
    await manager.close();
  });

  it('finishes each navigation capture before starting the next navigation', async () => {
    const lifecycle = fakeLifecycle();
    const events: string[] = [];
    const originalGoto = vi.mocked(lifecycle.page.goto).getMockImplementation();
    vi.mocked(lifecycle.page.goto).mockImplementation(async (...args) => {
      events.push(`goto:${String(args[0])}:start`);
      const result = await originalGoto?.(...args) ?? null;
      events.push(`goto:${String(args[0])}:end`);
      return result;
    });
    const scan = vi.fn(async (page: Page) => {
      events.push(`scan:${page.url()}`);
      return artifact(`state-${scan.mock.calls.length}`, page.url());
    });
    const { manager } = testManager(lifecycle, { scan });
    const sessionId = await manager.createSession({ url: 'https://initial.example.test/' });
    await manager.waitForIdle(sessionId);
    events.length = 0;

    await Promise.all([
      manager.goto(sessionId, 'https://one.example.test/'),
      manager.goto(sessionId, 'https://two.example.test/'),
    ]);
    await manager.waitForIdle(sessionId);

    expect(events).toEqual([
      'goto:https://one.example.test/:start',
      'goto:https://one.example.test/:end',
      'scan:https://one.example.test/',
      'goto:https://two.example.test/:start',
      'goto:https://two.example.test/:end',
      'scan:https://two.example.test/',
    ]);
    expect(manager.getStateIndex(sessionId).states).not.toContainEqual(
      expect.objectContaining({ status: 'extracting' }),
    );
    await manager.close();
  });

  it('exposes extracting and coherent error state-index transitions', async () => {
    const lifecycle = fakeLifecycle();
    const originalGoto = vi.mocked(lifecycle.page.goto).getMockImplementation();
    let rejectNavigation = (_error: Error): void => undefined;
    const navigationGate = new Promise<never>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    vi.mocked(lifecycle.page.goto)
      .mockImplementationOnce(async (...args) => originalGoto?.(...args) ?? null)
      .mockImplementationOnce(async () => navigationGate);
    const { manager } = testManager(lifecycle);
    const sessionId = await manager.createSession({ url: 'https://initial.example.test/' });
    await manager.waitForIdle(sessionId);

    const navigation = manager.goto(sessionId, 'https://broken.example.test/');
    await vi.waitFor(() => {
      expect(vi.mocked(lifecycle.page.goto)).toHaveBeenCalledTimes(2);
    });
    const extracting = manager.getStateIndex(sessionId);
    expect(extracting.currentStateId).toBeNull();
    expect(extracting.states).toContainEqual(
      expect.objectContaining({
        url: 'https://broken.example.test/',
        status: 'extracting',
        parentStateId: 'state-1',
      }),
    );
    expect(extracting.states).toContainEqual(
      expect.objectContaining({ stateId: 'state-1', status: 'stale' }),
    );

    rejectNavigation(new Error('navigation aborted'));
    await expect(navigation).rejects.toThrow('navigation aborted');
    const failed = manager.getStateIndex(sessionId);
    expect(failed.currentStateId).toBeNull();
    expect(failed.lastError).toBe('navigation aborted');
    expect(failed.states).toContainEqual(
      expect.objectContaining({
        url: 'https://broken.example.test/',
        status: 'error',
        parentStateId: 'state-1',
      }),
    );
    await manager.close();
  });

  it('closes browser resources without waiting for a hung navigation queue', async () => {
    const lifecycle = fakeLifecycle();
    vi.mocked(lifecycle.page.goto).mockImplementation(async () => new Promise<never>(() => undefined));
    const { manager } = testManager(lifecycle);
    await manager.createSession({ url: 'https://hung.example.test/' });

    await Promise.race([
      manager.close(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('manager close waited for navigation')), 100);
      }),
    ]);
    expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.browser.close).toHaveBeenCalledTimes(1);
  });

  it('contains replay listener failures and removes the failed listener', async () => {
    const lifecycle = fakeLifecycle();
    const { logger, manager } = testManager(lifecycle);
    const sessionId = await manager.createSession({ url: 'https://example.test/' });
    await manager.waitForIdle(sessionId);
    const listener = vi.fn(() => {
      throw new Error('socket closed');
    });

    expect(() => manager.subscribe(sessionId, listener)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Event replay listener failed: socket closed'),
    );
    (lifecycle.cdp as unknown as EventEmitter).emit('Page.screencastFrame', {
      data: 'new-frame',
      sessionId: 9,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await manager.close();
  });

  it('records asynchronous navigation failures and remains recoverable', async () => {
    const lifecycle = fakeLifecycle();
    vi.mocked(lifecycle.page.goto)
      .mockRejectedValueOnce(new Error('DNS lookup failed'))
      .mockResolvedValueOnce(null);
    const { logger, manager } = testManager(lifecycle);

    const sessionId = await manager.createSession({ url: 'https://bad.example.test/' });
    await manager.waitForIdle(sessionId);
    expect(manager.getStateIndex(sessionId)).toMatchObject({
      currentStateId: null,
      lastError: 'DNS lookup failed',
      states: [
        {
          url: 'https://bad.example.test/',
          status: 'error',
          trigger: 'initial navigation',
        },
      ],
    });
    expect(manager.snapshot(sessionId).events).toContainEqual(
      expect.objectContaining({
        t: 'extraction.error',
        message: 'DNS lookup failed',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Navigation failed: DNS lookup failed'),
    );

    await manager.goto(sessionId, 'https://recovered.example.test/');
    await manager.waitForIdle(sessionId);
    expect(manager.getStateIndex(sessionId).currentStateId).toBe('state-1');
    expect(manager.getStateIndex(sessionId).lastError).toBeNull();
    await manager.close();
  });

  it('closes partially allocated contexts when instrumentation setup fails', async () => {
    const lifecycle = fakeLifecycle();
    const manager = new SessionManager({
      launchBrowser: async () => lifecycle.browser,
      installInstrumentation: async () => {
        throw new Error('instrumentation unavailable');
      },
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    await expect(
      manager.createSession({ url: 'https://example.test/' }),
    ).rejects.toThrow('instrumentation unavailable');
    expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
    expect(manager.sessionCount).toBe(0);
    expect(manager.expectedContextCount).toBe(0);
    await manager.close();
  });

  it('preserves discovery ancestry when returning to an existing state', async () => {
    const lifecycle = fakeLifecycle();
    let currentId = 'state-a';
    const { manager } = testManager(lifecycle, {
      scan: vi.fn(async () => artifact(currentId, 'https://example.test/')),
    });
    const sessionId = await manager.createSession({ url: 'https://example.test/' });
    await lifecycle.settled();
    await vi.waitFor(() => expect(manager.getStateIndex(sessionId).currentStateId).toBe('state-a'));
    for (const nextId of ['state-b', 'state-a']) {
      currentId = nextId;
      await manager.dispatchInput(sessionId, {
        kind: 'mouse', type: 'mouseReleased', x: 5, y: 5, button: 'left',
      });
      await lifecycle.settled();
      await vi.waitFor(() => expect(manager.getStateIndex(sessionId).currentStateId).toBe(nextId));
    }
    const entries = new Map(manager.getStateIndex(sessionId).states.map((entry) => [entry.stateId, entry]));
    expect(entries.get('state-a')?.parentStateId).toBeUndefined();
    expect(entries.get('state-b')?.parentStateId).toBe('state-a');
    expect(entries.get('state-a')?.status).toBe('ready');
    expect(entries.get('state-b')?.status).toBe('stale');
    await manager.closeSession(sessionId);
    await manager.close();
  });
});
