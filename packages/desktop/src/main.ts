import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRequire } from 'node:module';

import type {
  BrowserWindow as BrowserWindowType,
  IpcMainInvokeEvent,
  WebContentsView as WebContentsViewType,
} from 'electron';

// Under ESM, `import 'electron'` resolves to the npm package's shim, whose
// default export is the path of the Electron binary. Only a CommonJS require
// reaches the built-in main-process module.
const electron = createRequire(import.meta.url)('electron') as typeof import('electron');
const { app, BrowserWindow, ipcMain, WebContentsView } = electron;

import type { OrchestratorEvent } from '@nexus/schema';
import { Recordings } from './recordings.js';
import { DesktopSession } from './session.js';
import { startSingleInstanceApplication } from './single-instance.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_INDEX = resolve(HERE, '../../ui/dist/index.html');
const PRELOAD = join(HERE, 'preload.cjs');
const ARTIFACTS_ROOT = () => join(app.getPath('userData'), 'sessions');

/** Zero-sized until the renderer measures its centre pane and reports back. */
const DEFAULT_VIEW_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };

interface Bounds { x: number; y: number; width: number; height: number }

function httpUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can be inspected.');
  }
  return parsed.href;
}

let window: BrowserWindowType | null = null;
let view: WebContentsViewType | null = null;
let session: DesktopSession | null = null;
let activeRecordingId: string | null = null;
let recordingOperation: Promise<unknown> = Promise.resolve();
let recordingStore: Recordings | null = null;
const recordings = () => recordingStore ??= new Recordings(ARTIFACTS_ROOT());
function serializeRecording<T>(operation: () => Promise<T>): Promise<T> {
  const pending = recordingOperation.catch(() => undefined).then(operation);
  recordingOperation = pending;
  return pending;
}
let viewBounds: Bounds = DEFAULT_VIEW_BOUNDS;
// The renderer and the smoke path can both ask for a session at once, and a
// second CDP attach on the same WebContents is a hard error.
let sessionStarting: Promise<DesktopSession> | null = null;
let popupNavigation: Promise<void> = Promise.resolve();
/** Proves the renderer loaded, the preload bridge exists, and IPC is flowing. */
let boundsReported: Bounds | null = null;

function isBounds(value: unknown): value is Bounds {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Bounds>;
  return ['x', 'y', 'width', 'height'].every(
    (key) => typeof candidate[key as keyof Bounds] === 'number'
      && Number.isFinite(candidate[key as keyof Bounds]),
  );
}

function applyViewBounds(): void {
  if (view === null) return;
  // Rounded because a fractional native bound blurs the whole page view.
  view.setBounds({
    x: Math.round(viewBounds.x),
    y: Math.round(viewBounds.y),
    width: Math.max(0, Math.round(viewBounds.width)),
    height: Math.max(0, Math.round(viewBounds.height)),
  });
}

function broadcast(event: OrchestratorEvent): void {
  if (window === null || window.isDestroyed()) return;
  window.webContents.send('nexus:event', event);
}

async function ensureSession(): Promise<DesktopSession> {
  if (session !== null) return session;
  if (sessionStarting !== null) return sessionStarting;
  const target = view;
  if (target === null) throw new Error('The page view is not ready.');

  sessionStarting = (async () => {
    const created = new DesktopSession({ view: target, artifactsRoot: ARTIFACTS_ROOT() });
    await created.start();
    created.subscribe(broadcast, false);
    session = created;
    return created;
  })();
  try {
    return await sessionStarting;
  } finally {
    sessionStarting = null;
  }
}

function requireSession(): DesktopSession {
  if (session === null) throw new Error('No session is active.');
  return session;
}

async function handle(channel: string, payload: unknown): Promise<unknown> {
  const body = (payload ?? {}) as Record<string, unknown>;

  switch (channel) {
    case 'recordings.list':
      return recordings().list(activeRecordingId);
    case 'recordings.read':
      return recordings().read(body.id);
    case 'recordings.rename':
      return recordings().rename(body.id, body.name);
    case 'recordings.start':
      return serializeRecording(async () => {
        if (activeRecordingId !== null) throw new Error('Stop the current recording before starting another.');
        const url = httpUrl(body.url);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 120) throw new Error('Enter a recording name of 1–120 characters.');
        await session?.close();
        session = null;
        const created = await ensureSession();
        const recording = await recordings().create(created.id, body.name, url);
        activeRecordingId = created.id;
        // Return the ID before navigation so the renderer can subscribe immediately.
        void created.goto(url).catch((error: unknown) => broadcast({ t: 'extraction.error', stateId: 'capture_navigation', message: String(error) }));
        return recording;
      });
    case 'recordings.stop':
      return serializeRecording(async () => {
        if (activeRecordingId === null) throw new Error('No recording is active.');
        const artifacts = await requireSession().stopRecording();
        const recording = await recordings().finish(activeRecordingId, artifacts);
        activeRecordingId = null;
        return recording;
      });
    case 'session.create': {
      const created = await ensureSession();
      await created.goto(httpUrl(body.url));
      return created.id;
    }
    case 'session.goto': {
      await requireSession().goto(httpUrl(body.url));
      return { accepted: true };
    }
    case 'session.pageNames':
      return (session !== null && body.sessionId === session.id ? session.pageNames : await recordings().pageNames(body.sessionId)).get();
    case 'session.renamePage':
      return (session !== null && body.sessionId === session.id ? session.pageNames : await recordings().pageNames(body.sessionId)).set(body.url, body.name);
    case 'session.states':
      return requireSession().stateIndex();
    case 'session.resetHistory':
      return requireSession().resetHistory();
    case 'session.state':
      return requireSession().state(String(body.stateId ?? ''));
    case 'session.input':
      // The page is a native view: the user's pointer and keyboard reach it
      // directly, so there is nothing to forward. The channel stays for the
      // left-panel element controls, which dispatch synthetic gestures.
      return { accepted: true };
    case 'view.highlight': {
      const items = Array.isArray(body.items) ? body.items : [];
      await requireSession().highlight(items as never[]);
      return { accepted: true };
    }
    case 'session.clearData': {
      const contents = view?.webContents;
      if (contents === undefined) throw new Error('The page view is not ready.');
      await contents.session.clearStorageData();
      await contents.session.clearCache();
      return { accepted: true };
    }
    case 'view.clearHighlight':
      await requireSession().clearHighlight();
      return { accepted: true };
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
}

/**
 * Non-interactive verification path.
 *
 * Drives one URL through the real shell — real WebContentsView, real CDP
 * driver — and prints what came out. The CDP driver cannot be
 * exercised by the Playwright test suite, so without this its behaviour on
 * real sites would only ever be checked by hand.
 */
function runSmoke(target: string): void {
  const started = Date.now();
  const events: OrchestratorEvent[] = [];
  let settled: NodeJS.Timeout | null = null;
  const requestedObservationMs = Number.parseInt(
    process.env.NEXUS_SMOKE_OBSERVE_MS ?? '',
    10,
  );
  const hasRequestedObservation = Number.isFinite(requestedObservationMs);
  const observationMs = hasRequestedObservation
    ? Math.max(500, Math.min(60_000, requestedObservationMs))
    : 500;

  const finish = (): void => {
    // What the page actually looks like now, independent of any artifact. A
    // stale capture and a page that never finished rendering look identical in
    // the inventory alone.
    void view?.webContents
      .executeJavaScript(`(() => {
        const visible = (el) => {
          if (!el) return null;
          const box = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return { w: Math.round(box.width), h: Math.round(box.height), display: style.display };
        };
        const fields = Array.from(document.querySelectorAll('input, textarea, select'))
          .filter((el) => el.type !== 'hidden');
        return {
          url: location.href,
          controls: document.querySelectorAll('a[href], button, input, select, textarea').length,
          visibleFields: fields.filter((el) => el.getBoundingClientRect().height > 0).length,
          totalFields: fields.length,
          body: visible(document.body),
        };
      })()`)
      .then((live: unknown) => console.log('live page:', JSON.stringify(live)))
      .catch(() => undefined);

    const index = session?.stateIndex();
    const stateId = index?.currentStateId ?? null;
    const artifact = stateId === null ? null : session?.state(stateId) ?? null;
    console.log(JSON.stringify({
      url: target,
      ms: Date.now() - started,
      rendererBridge: boundsReported === null
        ? 'no bounds reported'
        : `ok (${Math.round(boundsReported.width)}x${Math.round(boundsReported.height)} at ${Math.round(boundsReported.x)},${Math.round(boundsReported.y)})`,
      states: index?.states.map(({ stateId: id, url, title, status }) => ({ id, url, title, status })),
      lastError: index?.lastError ?? null,
      domElements: artifact?.dom?.reduce((total, frame) => total + frame.elements.length, 0) ?? 0,
      domFrames: artifact?.dom?.map((frame) => frame.frame) ?? [],
      actions: artifact?.actions.length ?? 0,
      observables: artifact?.observables.length ?? 0,
      extractionCompletions: events.filter((event) => event.t === 'extraction.completed').length,
      frames: [...new Set((artifact?.actions ?? []).map((action) => action.frame))],
      warnings: artifact?.warnings.map((warning) => `${warning.code}: ${warning.detail}`) ?? [],
      revealed: (artifact?.actions ?? [])
        .filter((action) => action.discoveredVia !== undefined)
        .map((action) => `${action.label} <- ${action.discoveredVia?.triggerLabel}`),
      dynamic: (artifact?.observables ?? [])
        .filter((observable) => observable.changedBy.length > 0)
        .map((observable) => `${observable.label}: ${observable.baselineValue ?? '(appeared)'} -> ${observable.currentValue}`),
      sample: (artifact?.actions ?? []).slice(0, 12).map((action) => `${action.type}/${action.kind} "${action.label}"`),
    }, null, 2));
    void session?.close().finally(() => app.exit(0));
    setTimeout(() => app.exit(0), 4_000);
  };

  void (async () => {
    try {
      const created = await ensureSession();
      created.subscribe((event) => {
        events.push(event);
        if (event.t === 'extraction.error') console.error(`[error] ${event.message}`);
        if (event.t !== 'extraction.completed') return;
        // Allow late-loading frames to finish their captures.
        if (settled !== null) clearTimeout(settled);
        settled = setTimeout(
          finish,
          observationMs,
        );
      }, false);
      await created.goto(target);
    } catch (error) {
      console.error(`smoke failed: ${String(error)}`);
      if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
      app.exit(1);
    }
  })();
  setTimeout(() => { console.error('smoke timed out'); finish(); }, 180_000);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f8f9fa',
    title: 'Nexus',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The target page is untrusted third-party content; keep it partitioned
      // away from the shell's own session and storage.
      // Ephemeral by default. A persisted partition silently changes what the
      // application under inspection renders: Odoo, for one, keeps its login
      // form hidden once storage remembers a user and expects a different
      // component to render instead — so the same URL produced a different
      // inventory on the second launch than on the first. Extraction has to be
      // reproducible, so state is opt-in rather than inherited.
      partition: process.env.NEXUS_PARTITION
        ?? (process.env.NEXUS_PERSIST_SESSION === '1' ? 'persist:nexus-target' : 'nexus-target'),
    },
  });
  // Added above the renderer, then positioned into the centre pane's hole.
  window.contentView.addChildView(view);
  view.setBounds(DEFAULT_VIEW_BOUNDS);
  view.setBackgroundColor('#ffffff');

  // Keep ordinary popup destinations inside the managed page view. Opening an
  // untrusted target with shell.openExternal both bypasses extraction and can
  // invoke arbitrary native protocol handlers on the host.
  view.webContents.setWindowOpenHandler(({ url, referrer, postBody }) => {
    try {
      const target = httpUrl(url);
      const contentType = postBody === undefined
        ? undefined
        : `${postBody.contentType}${postBody.boundary === undefined ? '' : `; boundary=${postBody.boundary}`}`;
      popupNavigation = popupNavigation
        .catch(() => undefined)
        .then(async () => {
          const created = await ensureSession();
          await created.goto(target, {
            httpReferrer: referrer,
            ...(postBody === undefined ? {} : {
              postData: postBody.data,
              extraHeaders: `Content-Type: ${contentType}`,
            }),
          });
        })
        .catch((error: unknown) => console.error(`Popup navigation failed: ${String(error)}`));
    } catch (error) {
      console.warn(`Blocked popup: ${String(error)}`);
    }
    return { action: 'deny' };
  });

  if (process.env.NEXUS_SMOKE_URL !== undefined) {
    view.webContents.on('console-message', (event) => {
      if (event.level !== 'error' && event.level !== 'warning') return;
      console.error(`[page ${event.level}] ${event.message.slice(0, 220)}`);
    });
    view.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[page gone] ${JSON.stringify(details)}`);
    });
  }

  window.on('resize', applyViewBounds);
  window.on('closed', () => {
    void session?.close();
    session = null;
    view = null;
    window = null;
  });

  void window.loadURL(pathToFileURL(UI_INDEX).href);

  const smoke = process.env.NEXUS_SMOKE_URL;
  if (smoke !== undefined && smoke !== '') {
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    runSmoke(smoke);
  }
}

function initializePrimaryInstance(): void {
  ipcMain.handle('nexus', async (_event: IpcMainInvokeEvent, message: unknown) => {
    const { channel, payload } = (message ?? {}) as { channel?: string; payload?: unknown };
    if (typeof channel !== 'string') throw new Error('A channel is required.');
    return handle(channel, payload);
  });

  ipcMain.on('nexus:view-bounds', (_event, bounds: unknown) => {
    viewBounds = isBounds(bounds) ? bounds : DEFAULT_VIEW_BOUNDS;
    if (isBounds(bounds)) boundsReported = bounds;
    applyViewBounds();
  });

  app.whenReady().then(createWindow).catch((error: unknown) => {
    console.error(`Nexus failed to start: ${String(error)}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

startSingleInstanceApplication(app, () => window, initializePrimaryInstance);
