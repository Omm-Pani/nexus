import { recoverShadowRoots } from './shadow.js';
import type {
  DriverFrame,
  FrameOwner,
  PageDriver,
} from './types.js';
import { FRAME_OWNER_SOURCE } from './playwright.js';

/**
 * The Chrome DevTools Protocol as this driver needs it.
 *
 * Deliberately not Electron- or Playwright-specific: Electron's
 * `webContents.debugger` and a raw WebSocket to `--remote-debugging-port` both
 * satisfy it with a few lines of adapter, so the desktop app and any future
 * attach-to-running-Chrome mode share one implementation.
 */
export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(handler: CdpEventHandler): void;
  off(handler: CdpEventHandler): void;
}

export type CdpEventHandler = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void;

interface FrameRecord {
  frameId: string;
  parentFrameId: string | null;
  url: string;
  /** Session that owns this frame. Undefined for the root target. */
  sessionId: string | undefined;
  /** Main-world execution context, if one has been announced yet. */
  contextId: number | undefined;
}

interface RemoteObject {
  objectId?: string;
  value?: unknown;
  subtype?: string;
  description?: string;
}

interface EvaluateResult {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function exceptionMessage(result: EvaluateResult): string | null {
  const details = result.exceptionDetails;
  if (details === undefined) return null;
  return details.exception?.description ?? details.text ?? 'Evaluation failed.';
}

/**
 * Drives a page over CDP.
 *
 * Cross-origin iframes live in their own targets and are unreachable from the
 * root session, so this auto-attaches flatly and tracks which session owns each
 * frame. Without that, extraction on any site that embeds a third-party
 * checkout, map, or player silently stops at the iframe boundary.
 */
export interface CdpDriverOptions {
  /**
   * Attach flatly to out-of-process iframe targets.
   *
   * Off by default for Electron compatibility. Individual iframe targets are
   * attached when enumerating frames, including targets created during swaps.
   */
  autoAttachToFrames?: boolean;
}

export class CdpDriver implements PageDriver {
  readonly kind = 'cdp' as const;

  readonly #autoAttach: boolean;
  readonly #transport: CdpTransport;
  readonly #frames = new Map<string, FrameRecord>();
  readonly #sessionReady = new Map<string | undefined, Promise<void>>();
  readonly #sessions = new Set<string | undefined>();
  readonly #initScripts: string[] = [];
  #mainFrameId: string | null = null;
  #url = 'about:blank';
  #attached = false;
  #handler: CdpEventHandler | null = null;

  constructor(transport: CdpTransport, options: CdpDriverOptions = {}) {
    this.#transport = transport;
    this.#autoAttach = options.autoAttachToFrames ?? false;
  }

  /** Enable the domains and begin tracking frames. Idempotent. */
  async attach(): Promise<void> {
    if (this.#attached) return;
    this.#attached = true;

    this.#handler = (method, params, sessionId) => {
      this.#handleEvent(method, params, sessionId);
    };
    this.#transport.on(this.#handler);

    await this.#enableSession(undefined);
    await this.#refreshFrameTree();
  }

  async detach(): Promise<void> {
    if (!this.#attached) return;
    this.#attached = false;
    if (this.#handler !== null) this.#transport.off(this.#handler);
    this.#handler = null;
    this.#frames.clear();
    this.#sessions.clear();
    this.#sessionReady.clear();
  }

  url(): string {
    return this.#url;
  }

  async title(): Promise<string> {
    const main = this.#mainFrame();
    if (main === null) return '';
    try {
      return await this.evaluate<string>(this.#toDriverFrame(main, 'main'), '() => document.title');
    } catch {
      return '';
    }
  }

  async addInitScript(source: string): Promise<void> {
    const wrapped = `(${source})()`;
    const isNew = !this.#initScripts.includes(wrapped);
    if (isNew) this.#initScripts.push(wrapped);
    for (const sessionId of isNew ? this.#sessions : []) {
      await this.#transport
        .send('Page.addScriptToEvaluateOnNewDocument', { source: wrapped }, sessionId)
        .catch(() => undefined);
    }
    // Documents already open never saw the init script, so install into each.
    await this.#refreshFrameTree();
    for (const record of this.#frames.values()) {
      if (record.contextId === undefined) continue;
      await this.#rawEvaluate(record, wrapped).catch(() => undefined);
    }
  }

  async prepareDom(): Promise<void> {
    for (const sessionId of this.#sessions) {
      await recoverShadowRoots((method, params) => this.#transport.send(method, params, sessionId));
    }
  }

  async frames(): Promise<DriverFrame[]> {
    await this.#refreshFrameTree();
    // Process swaps can announce a frame before its iframe target exists.
    // Wait briefly for that target, without applying auto-attach to WebContents.
    for (let attempt = 0; attempt < 8; attempt++) {
      const missing = [...this.#frames.values()].filter((record) => record.parentFrameId !== null && record.contextId === undefined);
      if (missing.length === 0) break;
      const targets = await this.#transport.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string }> }>('Target.getTargets').catch(() => null);
      for (const record of missing) {
        const target = targets?.targetInfos?.find((target) => target.type === 'iframe' && target.targetId === record.frameId);
        if (target === undefined) continue;
        try {
          const attached = await this.#transport.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          record.sessionId = attached.sessionId;
          record.url = target.url;
          await this.#enableSession(attached.sessionId);
          for (const script of this.#initScripts) await this.#rawEvaluate(this.#frames.get(record.frameId) ?? record, script);
        } catch { /* Report inaccessible frames through scanState's warnings. */ }
      }
      if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const paths = await this.#resolvePaths();
    const ordered: DriverFrame[] = [];
    for (const [frameId, path] of paths) {
      const record = this.#frames.get(frameId);
      if (record === undefined) continue;
      ordered.push(this.#toDriverFrame(record, path));
    }
    ordered.sort((left, right) =>
      left.path === 'main' ? -1 : right.path === 'main' ? 1 : left.path.localeCompare(right.path),
    );
    return ordered;
  }

  async evaluate<T>(frame: DriverFrame, fnSource: string, arg?: unknown): Promise<T> {
    const record = this.#record(frame);
    const expression = `(${fnSource})(${JSON.stringify(arg ?? null)})`;
    return this.#rawEvaluate<T>(record, expression);
  }

  async frameOwner(frame: DriverFrame): Promise<FrameOwner> {
    return this.#evaluateOnFrameOwner<FrameOwner>(frame, FRAME_OWNER_SOURCE);
  }

  async #evaluateOnFrameOwner<T>(
    frame: DriverFrame,
    fnSource: string,
    arg?: unknown,
  ): Promise<T> {
    const record = this.#record(frame);
    if (record.parentFrameId === null) {
      throw new Error('The main frame has no owning element.');
    }
    const parent = this.#frames.get(record.parentFrameId);
    if (parent === undefined || parent.contextId === undefined) {
      throw new Error('The owning frame is not reachable.');
    }

    // The owner element lives in the parent document, which for a cross-origin
    // iframe is a different session than the frame itself.
    const owner = await this.#transport.send<{ backendNodeId?: number }>(
      'DOM.getFrameOwner',
      { frameId: record.frameId },
      parent.sessionId,
    );
    if (owner.backendNodeId === undefined) {
      throw new Error('Could not resolve the owning frame element.');
    }
    const resolved = await this.#transport.send<{ object?: RemoteObject }>(
      'DOM.resolveNode',
      { backendNodeId: owner.backendNodeId, executionContextId: parent.contextId },
      parent.sessionId,
    );
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      throw new Error('Could not bind the owning frame element.');
    }
    try {
      const result = await this.#transport.send<EvaluateResult>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function (arg) { return (${fnSource})(this, arg); }`,
          arguments: [{ value: arg ?? null }],
          returnByValue: true,
          awaitPromise: true,
        },
        parent.sessionId,
      );
      const failure = exceptionMessage(result);
      if (failure !== null) throw new Error(failure);
      return result.result?.value as T;
    } finally {
      await this.#transport
        .send('Runtime.releaseObject', { objectId }, parent.sessionId)
        .catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- internals

  #mainFrame(): FrameRecord | null {
    return this.#mainFrameId === null ? null : this.#frames.get(this.#mainFrameId) ?? null;
  }

  #toDriverFrame(record: FrameRecord, path: string): DriverFrame {
    return {
      id: record.frameId,
      path,
      url: record.url,
      parentId: record.parentFrameId,
    };
  }

  #record(frame: DriverFrame): FrameRecord {
    const record = this.#frames.get(frame.id);
    if (record === undefined) throw new Error(`Unknown frame: ${frame.path}`);
    return record;
  }

  async #rawEvaluate<T>(record: FrameRecord, expression: string): Promise<T> {
    if (record.contextId === undefined) {
      throw new Error('The frame has no execution context yet.');
    }
    const result = await this.#transport.send<EvaluateResult>(
      'Runtime.evaluate',
      {
        expression,
        contextId: record.contextId,
        returnByValue: true,
        awaitPromise: true,
        // The instrumentation is intentionally global; a side-effect-free
        // evaluation would refuse to install it.
        userGesture: false,
      },
      record.sessionId,
    );
    const failure = exceptionMessage(result);
    if (failure !== null) throw new Error(failure);
    return result.result?.value as T;
  }

  #enableSession(sessionId: string | undefined): Promise<void> {
    const pending = this.#sessionReady.get(sessionId);
    if (pending !== undefined) return pending;
    const ready = this.#initializeSession(sessionId);
    this.#sessionReady.set(sessionId, ready);
    return ready;
  }

  async #initializeSession(sessionId: string | undefined): Promise<void> {
    if (this.#sessions.has(sessionId)) return;
    this.#sessions.add(sessionId);
    const send = (method: string, params?: Record<string, unknown>) =>
      this.#transport.send(method, params, sessionId).catch(() => undefined);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Runtime.addBinding', { name: '__nexusObserved' });
    await send('Runtime.addBinding', { name: '__nexusSettled' });
    if (this.#autoAttach) {
      // Flat auto-attach surfaces out-of-process iframes as sibling sessions on
      // the same connection rather than as a separate socket per target.
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    }
    for (const script of this.#initScripts) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
    }
  }

  #handleEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context as
        | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
        | undefined;
      const frameId = context?.auxData?.frameId;
      // Isolated worlds share a frame; only the default world holds __nexus.
      if (frameId === undefined || context?.id === undefined) return;
      if (context.auxData?.isDefault === false) return;
      const record = this.#frames.get(frameId);
      if (record === undefined) {
        this.#frames.set(frameId, {
          frameId,
          parentFrameId: null,
          url: '',
          sessionId,
          contextId: context.id,
        });
        return;
      }
      record.contextId = context.id;
      record.sessionId = sessionId;
      return;
    }

    if (method === 'Runtime.executionContextDestroyed') {
      for (const record of this.#frames.values()) {
        if (record.sessionId === sessionId && record.contextId === params.executionContextId) record.contextId = undefined;
      }
      return;
    }

    if (method === 'Runtime.executionContextsCleared') {
      for (const record of this.#frames.values()) {
        if (record.sessionId === sessionId) record.contextId = undefined;
      }
      return;
    }

    if (method === 'Page.frameNavigated') {
      const frame = params.frame as
        | { id?: string; parentId?: string; url?: string }
        | undefined;
      if (frame?.id === undefined) return;
      const record = this.#frames.get(frame.id);
      const next: FrameRecord = {
        frameId: frame.id,
        parentFrameId: frame.parentId ?? (sessionId === undefined ? null : record?.parentFrameId ?? null),
        url: frame.url ?? '',
        sessionId,
        contextId: record?.contextId,
      };
      this.#frames.set(frame.id, next);
      if (next.parentFrameId === null) {
        this.#mainFrameId = frame.id;
        this.#url = next.url;
      }
      return;
    }

    if (method === 'Page.frameDetached') {
      const frameId = params.frameId;
      if (typeof frameId === 'string') {
        if (params.reason === 'swap') {
          const record = this.#frames.get(frameId);
          if (record !== undefined) record.contextId = undefined;
        } else this.#frames.delete(frameId);
      }
      return;
    }

    if (method === 'Target.detachedFromTarget') {
      const detached = params.sessionId;
      if (typeof detached === 'string') {
        this.#sessions.delete(detached);
        this.#sessionReady.delete(detached);
        for (const record of this.#frames.values()) {
          if (record.sessionId === detached) record.contextId = undefined;
        }
      }
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const target = params.targetInfo as { type?: string } | undefined;
      const childSession = params.sessionId;
      if (typeof childSession !== 'string') return;
      if (target?.type !== 'iframe' && target?.type !== 'page') return;
      void this.#enableSession(childSession);
    }
  }

  async #refreshFrameTree(): Promise<void> {
    for (const sessionId of [...this.#sessions]) {
      const tree = await this.#transport
        .send<{ frameTree?: unknown }>('Page.getFrameTree', {}, sessionId)
        .catch(() => null);
      if (tree === null || tree.frameTree === undefined) continue;
      this.#absorb(tree.frameTree, null, sessionId);
    }
  }

  #absorb(node: unknown, parentFrameId: string | null, sessionId: string | undefined): void {
    if (node === null || typeof node !== 'object') return;
    const tree = node as {
      frame?: { id?: string; parentId?: string; url?: string };
      childFrames?: unknown[];
    };
    const frame = tree.frame;
    if (frame?.id !== undefined) {
      const existing = this.#frames.get(frame.id);
      const resolvedParent = frame.parentId ?? parentFrameId ?? (sessionId === undefined ? null : existing?.parentFrameId ?? null);
      this.#frames.set(frame.id, {
        frameId: frame.id,
        parentFrameId: resolvedParent,
        url: frame.url ?? existing?.url ?? '',
        // A frame announced by a child session belongs to that session; keep
        // whichever session actually created its execution context.
        sessionId: existing?.contextId === undefined ? sessionId : existing.sessionId,
        contextId: existing?.contextId,
      });
      if (resolvedParent === null) {
        this.#mainFrameId = frame.id;
        this.#url = frame.url ?? this.#url;
      }
      for (const child of tree.childFrames ?? []) {
        this.#absorb(child, frame.id, sessionId);
      }
    }
  }

  /** Build `main/iframe#id/...` paths by asking each parent for its owner. */
  async #resolvePaths(): Promise<Map<string, string>> {
    const paths = new Map<string, string>();
    if (this.#mainFrameId === null) return paths;
    paths.set(this.#mainFrameId, 'main');

    const pending = [...this.#frames.values()].filter(
      (record) => record.frameId !== this.#mainFrameId,
    );
    // Parents must resolve before children; iterate until nothing moves.
    let progressed = true;
    while (progressed && pending.length > 0) {
      progressed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const record = pending[index] as FrameRecord;
        const parentPath =
          record.parentFrameId === null ? undefined : paths.get(record.parentFrameId);
        if (parentPath === undefined) continue;
        let segment: string;
        try {
          segment = (
            await this.#evaluateOnFrameOwner<FrameOwner>(
              this.#toDriverFrame(record, `${parentPath}/?`),
              FRAME_OWNER_SOURCE,
            )
          ).segment;
        } catch {
          segment = `iframe#${record.frameId.slice(0, 8)}`;
        }
        paths.set(record.frameId, `${parentPath}/${segment}`);
        pending.splice(index, 1);
        progressed = true;
      }
    }
    return paths;
  }
}
