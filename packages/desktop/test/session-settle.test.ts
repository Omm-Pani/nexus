import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import type { WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { OrchestratorEvent, StateArtifact } from '@nexus/schema';

import {
  advanceSettledCursor,
  AutomaticSettleBackoff,
  DesktopSession,
  isInteractiveSettleCause,
  parseSettledSignal,
  semanticArtifactDigest,
} from '../src/session.js';

function interactiveArtifact(shifted = false): StateArtifact {
  const value = artifact({
    groups: [{
      id: shifted ? 'g99' : 'g1',
      label: 'Main',
      kind: 'main',
      global: false,
      conditional: false,
      actions: [shifted ? 'e99' : 'e1'],
      observables: [],
    }],
    actions: [{
      id: shifted ? 'e99' : 'e1',
      stableId: 'stable-continue',
      label: 'Continue',
      type: 'button',
      kind: 'unknown',
      risk: 'safe',
      confidence: 1,
      evidence: ['native_tag'],
      state: { disabled: false },
      visible: true,
      inViewport: true,
      hitTestable: true,
      occludedBy: null,
      region: shifted ? 'g99' : 'g1',
      frame: 'main',
      shadowPath: [],
      rect: shifted
        ? { x: 101, y: 102, w: 103, h: 104 }
        : { x: 1, y: 2, w: 3, h: 4 },
      locators: [{
        kind: 'testid',
        value: shifted ? 'fresh-locator' : 'retained-locator',
        frame: 'main',
        shadowPath: [],
      }],
    }],
  });
  value.buildId = shifted ? 'fresh-build' : 'retained-build';
  value.capturedAt = shifted
    ? '2026-08-20T10:01:00.000Z'
    : '2026-08-20T10:00:00.000Z';
  return value;
}

function fakeDesktopView(url = 'https://example.test/app'): {
  view: WebContentsView;
  settle(payload: unknown): void;
  hardNavigate(url: string): void;
  inPageNavigate(url: string): void;
} {
  let currentUrl = url;
  const debuggerEvents = new EventEmitter();
  const debuggerApi = Object.assign(debuggerEvents, {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async (method: string) => method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'main-frame', url } } }
      : {}),
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    getURL: vi.fn(() => currentUrl),
    isLoadingMainFrame: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    session: { cookies: { get: vi.fn(async () => []) } },
  });
  return {
    view: { webContents: contents } as unknown as WebContentsView,
    settle(payload: unknown): void {
      debuggerEvents.emit('message', {}, 'Runtime.bindingCalled', {
        name: '__nexusSettled',
        payload: JSON.stringify(payload),
        executionContextId: 1,
      });
    },
    hardNavigate(nextUrl: string): void {
      contents.emit('did-start-navigation', {}, nextUrl, false, true);
      currentUrl = nextUrl;
      contents.emit('did-navigate', {}, nextUrl, 200, 'OK');
      contents.emit('did-finish-load');
    },
    inPageNavigate(nextUrl: string): void {
      currentUrl = nextUrl;
      contents.emit('did-navigate-in-page', {}, nextUrl, true);
    },
  };
}

function artifact(overrides: Partial<StateArtifact> = {}): StateArtifact {
  return {
    schemaVersion: 1,
    stateId: 'state_a',
    url: 'https://example.test/app',
    routeTemplate: 'https://example.test/app',
    title: 'Example',
    personaId: 'default',
    buildId: 'build-a',
    capturedAt: '2026-08-20T10:00:00.000Z',
    timings: { total: 12, walking: 5 },
    groups: [],
    actions: [],
    observables: [],
    collections: [],
    warnings: [],
    ...overrides,
  };
}

describe('desktop settle signal scheduling', () => {
  it('accepts legacy payloads and validates epoch, causes, and surface digest', () => {
    expect(parseSettledSignal({ settled: true })).toEqual({ causes: [] });
    expect(parseSettledSignal({
      settled: true,
      epoch: 7,
      causes: ['DOM', 'interaction', 'DOM', 4],
      surface: {
        digest: 'surface-7', presentationDigest: 'geometry-7',
        actions: 2, observables: 1, regions: 1,
      },
    })).toEqual({
      epoch: 7,
      causes: ['dom', 'interaction'],
      surfaceDigest: 'surface-7',
      presentationDigest: 'geometry-7',
    });
    expect(parseSettledSignal({ settled: true, epoch: -1 })).toBeNull();
    expect(parseSettledSignal({ settled: true, surface: 'not-an-object' })).toBeNull();
    expect(parseSettledSignal({ settled: false, epoch: 8 })).toBeNull();
  });

  it('deduplicates epochs and neutral identical surfaces without swallowing user changes', () => {
    const first = advanceSettledCursor(undefined, {
      epoch: 1,
      causes: ['dom'],
      surfaceDigest: 'same',
      presentationDigest: 'geometry-a',
    });
    expect(first.accepted).toBe(true);

    const duplicateEpoch = advanceSettledCursor(first.cursor, {
      epoch: 1,
      causes: ['dom'],
      surfaceDigest: 'changed-but-stale-epoch',
      presentationDigest: 'geometry-b',
    });
    expect(duplicateEpoch.accepted).toBe(false);

    const neutralSameSurface = advanceSettledCursor(first.cursor, {
      epoch: 2,
      causes: ['scroll', 'dom'],
      surfaceDigest: 'same',
      presentationDigest: 'geometry-a',
    });
    expect(neutralSameSurface.accepted).toBe(false);
    expect(neutralSameSurface.cursor.epoch).toBe(2);

    const movedSameSurface = advanceSettledCursor(neutralSameSurface.cursor, {
      epoch: 3,
      causes: ['scroll'],
      surfaceDigest: 'same',
      presentationDigest: 'geometry-b',
    });
    expect(movedSameSurface.accepted).toBe(true);
    expect(movedSameSurface.presentationChanged).toBe(true);

    const interaction = advanceSettledCursor(movedSameSurface.cursor, {
      epoch: 4,
      causes: ['interaction'],
      surfaceDigest: 'same',
      presentationDigest: 'geometry-b',
    });
    expect(interaction.accepted).toBe(true);
  });

  it('backs off neutral no-ops to five seconds and lets user causes bypass it', () => {
    const backoff = new AutomaticSettleBackoff();
    backoff.recordResult(false, ['dom'], 1_000);
    expect(backoff.delay(['dom'], 1_000)).toBe(250);
    backoff.recordResult(false, ['shadow'], 1_250);
    expect(backoff.delay(['dom'], 1_250)).toBe(500);
    backoff.recordResult(false, ['scroll'], 1_750);
    backoff.recordResult(false, ['dom'], 2_750);
    backoff.recordResult(false, ['dom'], 4_750);
    backoff.recordResult(false, ['dom'], 8_750);
    expect(backoff.delay(['dom'], 8_750)).toBe(5_000);
    expect(backoff.delay(['value'], 8_750)).toBe(0);
    expect(backoff.delay(['interaction'], 8_750)).toBe(0);

    backoff.recordResult(false, ['history'], 8_750);
    expect(backoff.delay(['dom'], 8_750)).toBe(0);
  });

  it('recognizes the bootstrap user-facing causes', () => {
    expect(isInteractiveSettleCause(['value'])).toBe(true);
    expect(isInteractiveSettleCause(['history'])).toBe(true);
    expect(isInteractiveSettleCause(['interaction'])).toBe(true);
    expect(isInteractiveSettleCause(['dom', 'shadow', 'scroll'])).toBe(false);
  });
});

describe('desktop semantic artifact digest', () => {
  it('ignores capture metadata but changes for actual inventory content', () => {
    const baseline = artifact();
    const metadataOnly = artifact({
      capturedAt: '2026-08-20T10:00:10.000Z',
      timings: { total: 987, walking: 765 },
      buildId: 'build-b',
    });
    expect(semanticArtifactDigest(metadataOnly)).toBe(semanticArtifactDigest(baseline));

    const changed = artifact({ title: 'Example — changed' });
    expect(semanticArtifactDigest(changed)).not.toBe(semanticArtifactDigest(baseline));
  });

  it('is independent of object property construction order', () => {
    const baseline = artifact({ timings: { total: 10, walking: 2 } });
    const reordered = Object.fromEntries(
      Object.entries({ ...baseline, timings: { walking: 200, total: 500 } }).reverse(),
    ) as unknown as StateArtifact;
    expect(semanticArtifactDigest(reordered)).toBe(semanticArtifactDigest(baseline));
  });
});






it('resets desktop history in place and keeps the prior history if the scan fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-desktop-reset-'));
  const fake = fakeDesktopView();
  const scan = vi.fn(async () => artifact());
  const writeBundle = vi.fn(async () => ({ manifest: '', state: '', warnings: '' }));
  const session = new DesktopSession({ view: fake.view, artifactsRoot: directory, scan, writeBundle });
  try {
    await session.start();
    const first = await session.resetHistory();
    scan.mockResolvedValueOnce(artifact({ stateId: 'state_b', title: 'Current DOM' }));
    const reset = await session.resetHistory();
    expect(reset.artifact.stateId).toBe('state_b');
    expect(reset.resetId).not.toBe(first.resetId);
    expect(session.stateIndex().states.map((entry) => entry.stateId)).toEqual(['state_b']);
    expect(session.stateIndex().states[0]?.parentStateId).toBeUndefined();
    expect(fake.view.webContents.loadURL).not.toHaveBeenCalled();
    const replay: OrchestratorEvent[] = [];
    session.subscribe((event) => replay.push(event))();
    expect(replay.map((event) => event.t)).toEqual(['history.reset', 'state.transition']);
    scan.mockRejectedValueOnce(new Error('Scan failed'));
    await expect(session.resetHistory()).rejects.toThrow('Scan failed');
    expect(session.stateIndex().currentStateId).toBe('state_b');
    expect(session.stateIndex().states).toHaveLength(1);
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
});

it('captures during continuous interaction instead of extending the scan deadline forever', async () => {
  vi.useFakeTimers();
  const fake = fakeDesktopView();
  let walks = 0;
  const session = new DesktopSession({ view: fake.view, artifactsRoot: '/tmp/nexus-scheduler-test', captureDebounceMs: 200,
    scan: async (_driver, options) => { walks++; await options?.onPhase?.('walking'); return artifact(); },
    writeBundle: async () => ({ manifest: '', state: '', warnings: '' }), writeState: async () => '',
  });
  try {
    await session.start();
    for (let epoch = 1; epoch <= 12; epoch++) {
      fake.settle({ settled: true, epoch, causes: ['interaction'] });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(walks).toBeGreaterThanOrEqual(2);
  } finally { await session.close(); vi.useRealTimers(); }
});

it('starts extraction at DOM ready even when the page load never finishes', async () => {
  const fake = fakeDesktopView();
  const contents = fake.view.webContents;
  vi.mocked(contents.loadURL).mockImplementation(() => new Promise(() => {}));
  const scan = vi.fn(async () => artifact());
  const session = new DesktopSession({ view: fake.view, artifactsRoot: '/tmp/nexus-dom-ready-test', captureDebounceMs: 1,
    scan, writeBundle: async () => ({ manifest: '', state: '', warnings: '' }), writeState: async () => '',
  });
  try {
    await session.start();
    const navigation = session.goto('https://example.test/app');
    contents.emit('dom-ready');
    await navigation;
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    expect(session.stateIndex().currentStateId).toBe('state_a');
  } finally { await session.close(); }
});
