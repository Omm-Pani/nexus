import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { LoadURLOptions, WebContentsView } from 'electron';

import {
  BOOTSTRAP_SOURCE,
  ObservationJournal,
  CdpDriver,
  mergePresentationGeometry,
  scanState,
  writeArtifactBundle,
  writeStateArtifact,
} from '@nexus/extractor';
import type {
  ExtractionPhase,
  OrchestratorEvent,
  StateArtifact,
} from '@nexus/schema';

import { ElectronCdpTransport } from './cdp-transport.js';

const PHASES: readonly ExtractionPhase[] = [
  'navigating', 'injecting', 'settling', 'walking',
  'classifying', 'grouping', 'observing', 'writing',
];

export interface SettledSignal {
  epoch?: number;
  causes: string[];
  surfaceDigest?: string;
  presentationDigest?: string;
  /** Host-derived: this signal advanced quantized presentation geometry. */
  presentationChanged?: boolean;
}

export interface SettledCursor {
  epoch?: number;
  surfaceDigest?: string;
  presentationDigest?: string;
}

interface CaptureRequest {
  trigger: string;
  automatic: boolean;
  causes: string[];
}

const SETTLE_BACKOFF_BASE_MS = 250;
const SETTLE_BACKOFF_MAX_MS = 5_000;

/**
 * Validate the advisory page payload before it is allowed to schedule work.
 * Older bootstraps only sent `{ settled: true }`, so epoch, causes, and the
 * cheap surface digest deliberately remain optional during rolling upgrades.
 */
export function parseSettledSignal(value: unknown): SettledSignal | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as {
    settled?: unknown;
    epoch?: unknown;
    causes?: unknown;
    surface?: unknown;
  };
  if (candidate.settled !== true) return null;
  if (
    candidate.epoch !== undefined
    && (
      typeof candidate.epoch !== 'number'
      || !Number.isSafeInteger(candidate.epoch)
      || candidate.epoch < 0
    )
  ) return null;

  const causes = Array.isArray(candidate.causes)
    ? [...new Set(candidate.causes.flatMap((cause) => {
        if (typeof cause !== 'string') return [];
        const normalized = cause.trim().toLowerCase().slice(0, 64);
        return normalized === '' ? [] : [normalized];
      }))].slice(0, 32)
    : [];

  let surfaceDigest: string | undefined;
  let presentationDigest: string | undefined;
  if (candidate.surface !== undefined) {
    if (candidate.surface === null || typeof candidate.surface !== 'object') return null;
    const surface = candidate.surface as {
      digest?: unknown;
      presentationDigest?: unknown;
    };
    const digest = surface.digest;
    if (typeof digest !== 'string' || digest.trim() === '' || digest.length > 256) return null;
    surfaceDigest = digest;
    if (surface.presentationDigest !== undefined) {
      if (
        typeof surface.presentationDigest !== 'string'
        || surface.presentationDigest.trim() === ''
        || surface.presentationDigest.length > 256
      ) return null;
      presentationDigest = surface.presentationDigest;
    }
  }

  return {
    ...(candidate.epoch === undefined ? {} : { epoch: candidate.epoch }),
    causes,
    ...(surfaceDigest === undefined ? {} : { surfaceDigest }),
    ...(presentationDigest === undefined ? {} : { presentationDigest }),
  };
}

/** Advance one execution-context cursor and decide whether a scan is useful. */
export function advanceSettledCursor(
  previous: SettledCursor | undefined,
  signal: SettledSignal,
): { accepted: boolean; cursor: SettledCursor; presentationChanged: boolean } {
  if (
    signal.epoch !== undefined
    && previous?.epoch !== undefined
    && signal.epoch <= previous.epoch
  ) {
    return { accepted: false, cursor: previous, presentationChanged: false };
  }
  const cursor: SettledCursor = {
    ...(signal.epoch === undefined ? {} : { epoch: signal.epoch }),
    ...(signal.surfaceDigest === undefined
      ? previous?.surfaceDigest === undefined ? {} : { surfaceDigest: previous.surfaceDigest }
      : { surfaceDigest: signal.surfaceDigest }),
    ...(signal.presentationDigest === undefined
      ? previous?.presentationDigest === undefined
        ? {}
        : { presentationDigest: previous.presentationDigest }
      : { presentationDigest: signal.presentationDigest }),
  };
  const presentationChanged = signal.presentationDigest !== undefined
    && previous?.presentationDigest !== undefined
    && previous.presentationDigest !== signal.presentationDigest;
  if (
    signal.surfaceDigest !== undefined
    && previous?.surfaceDigest === signal.surfaceDigest
    && !presentationChanged
    && !isInteractiveSettleCause(signal.causes)
  ) {
    return { accepted: false, cursor, presentationChanged: false };
  }
  return { accepted: true, cursor, presentationChanged };
}

/** Native user gestures should never wait behind polling-noise backoff. */
export function isInteractiveSettleCause(causes: readonly string[]): boolean {
  return causes.some((cause) =>
    /(?:interaction|value|input|change|pointer|mouse|click|key|focus|blur|submit|history|popstate|hashchange|touch)/iu
      .test(cause.toLowerCase()),
  );
}

/**
 * Bounded exponential backoff for pages whose DOM churn has no semantic
 * effect. There is no sleeping here: the scheduler asks for a trailing delay,
 * which lets newer signals coalesce into the one pending timer.
 */
export class AutomaticSettleBackoff {
  #neutralNoops = 0;
  #notBefore = 0;

  delay(causes: readonly string[], now = Date.now()): number {
    if (isInteractiveSettleCause(causes)) return 0;
    return Math.max(0, this.#notBefore - now);
  }

  recordResult(changed: boolean, causes: readonly string[], now = Date.now()): void {
    if (changed || isInteractiveSettleCause(causes)) {
      this.reset();
      return;
    }
    this.#neutralNoops += 1;
    const delay = Math.min(
      SETTLE_BACKOFF_MAX_MS,
      SETTLE_BACKOFF_BASE_MS * (2 ** Math.min(this.#neutralNoops - 1, 5)),
    );
    this.#notBefore = now + delay;
  }

  reset(): void {
    this.#neutralNoops = 0;
    this.#notBefore = 0;
  }
}

function canonicalSemanticArtifact(artifact: StateArtifact): unknown {
  const actionStableId = new Map(artifact.actions.map((action) => [action.id, action.stableId]));
  const observableStableId = new Map(artifact.observables.map((observable) => [observable.id, observable.stableId]));
  const groupById = new Map(artifact.groups.map((group) => [group.id, group]));
  const groupPaths = new Map<string, string>();
  const resolvingGroups = new Set<string>();
  const groupPath = (groupId: string): string => {
    const retained = groupPaths.get(groupId);
    if (retained !== undefined) return retained;
    const group = groupById.get(groupId);
    if (group === undefined) return '';
    const own = `${group.kind}:${group.label}`;
    if (resolvingGroups.has(groupId)) return `cycle:${own}`;
    resolvingGroups.add(groupId);
    const parent = group.parentGroup === undefined ? '' : groupPath(group.parentGroup);
    resolvingGroups.delete(groupId);
    const path = parent === '' ? own : `${parent}/${own}`;
    groupPaths.set(groupId, path);
    return path;
  };

  const actions = artifact.actions.map((action) => ({
    stableId: action.stableId,
    label: action.label,
    type: action.type,
    kind: action.kind,
    risk: action.risk,
    confidence: action.confidence,
    evidence: [...action.evidence].sort(),
    state: action.state,
    value: action.value,
    placeholder: action.placeholder,
    visible: action.visible,
    inViewport: action.inViewport,
    hitTestable: action.hitTestable,
    occluded: action.occludedBy !== null,
    region: groupPath(action.region),
    parentAction: action.parentAction === undefined
      ? undefined
      : actionStableId.get(action.parentAction),
    observedDestination: action.observedDestination,
    discoveredVia: action.discoveredVia,
  })).sort((left, right) => left.stableId.localeCompare(right.stableId));

  const observables = artifact.observables.map((observable) => ({
    stableId: observable.stableId,
    kind: observable.kind,
    label: observable.label,
    valueType: observable.valueType,
    currentValue: observable.currentValue,
    region: groupPath(observable.region),
    anchor: observable.anchor,
    changedBy: [...observable.changedBy].sort(),
    discoveredVia: observable.discoveredVia,
    baselineValue: observable.baselineValue,
  })).sort((left, right) => left.stableId.localeCompare(right.stableId));

  const groups = artifact.groups.map((group) => ({
    path: groupPath(group.id),
    kind: group.kind,
    label: group.label,
    global: group.global,
    conditional: group.conditional,
    parentAction: group.parentAction === undefined
      ? undefined
      : actionStableId.get(group.parentAction),
    actions: group.actions.flatMap((id) => actionStableId.get(id) ?? []).sort(),
    observables: group.observables.flatMap((id) => observableStableId.get(id) ?? []).sort(),
  })).sort((left, right) =>
    left.path.localeCompare(right.path)
    || left.actions.join('\u0000').localeCompare(right.actions.join('\u0000'))
    || left.observables.join('\u0000').localeCompare(right.observables.join('\u0000')),
  );

  const collections = artifact.collections.map((collection) => ({
    templateId: collection.templateId,
    label: collection.label,
    anchorField: {
      entropy: collection.anchorField.entropy,
      stability: collection.anchorField.stability,
      type: collection.anchorField.type,
    },
    instancesObserved: collection.instancesObserved,
    instancesDeclared: collection.instancesDeclared,
    traversal: collection.traversal,
    itemActions: collection.itemActions.map((item) => ({
      label: item.label,
      kind: item.kind,
      risk: item.risk,
    })),
    itemObservables: collection.itemObservables.map((item) => ({
      label: item.label,
      valueType: item.valueType,
    })),
    anchors: [...collection.anchors],
    rows: collection.rows?.map((row) => ({
      anchor: row.anchor,
      cells: row.cells.map((cell) => ({
        column: cell.column,
        type: cell.type,
        value: cell.value,
      })),
    })),
  })).sort((left, right) => left.templateId.localeCompare(right.templateId));

  return {
    schemaVersion: artifact.schemaVersion,
    stateId: artifact.stateId,
    dom: artifact.dom?.map(({ sequence, elements, ...frame }) => ({ ...frame, elements: elements.map(({ rect, ...element }) => element) })),
    url: artifact.url,
    routeTemplate: artifact.routeTemplate,
    title: artifact.title,
    personaId: artifact.personaId,
    groups,
    actions,
    observables,
    collections,
    warnings: artifact.warnings
      .map((warning) => ({ code: warning.code, detail: warning.detail }))
      .sort((left, right) =>
        left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail),
      ),
  };
}

/**
 * Hash only user-observable inventory. Persisted artifacts retain full
 * locators and geometry, but local ids, frame numbering, and layout movement
 * cannot turn an unchanged page into a new revision.
 */
export function semanticArtifactDigest(artifact: StateArtifact): string {
  return createHash('sha256')
    .update(stableJson(canonicalSemanticArtifact(artifact)))
    .digest('hex');
}

export interface DesktopSessionOptions {
  view: WebContentsView;
  artifactsRoot: string;
  captureDebounceMs?: number;
  /** Capture/persistence seams used by the desktop runtime regression suite. */
  scan?: typeof scanState;
  writeBundle?: typeof writeArtifactBundle;
  writeState?: typeof writeStateArtifact;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export interface StateIndexEntry {
  stateId: string;
  url: string;
  title: string;
  capturedAt: string;
  status: 'extracting' | 'ready' | 'stale' | 'error';
  parentStateId?: string;
  trigger?: string;
}

/**
 * A session backed by the window's own native page view.
 *
 * Much smaller than the Playwright session manager because the desktop shell
 * removes most of its work: there is no browser to launch, no context to
 * recycle, no screencast to stream, and above all no input forwarding — the
 * user is interacting with a real Chromium view directly, so extraction is the
 * only thing left to coordinate.
 */
export class DesktopSession {
  readonly id = randomUUID();

  readonly #view: WebContentsView;
  readonly #transport: ElectronCdpTransport;
  readonly #driver: CdpDriver;
  readonly #journal: ObservationJournal;
  readonly #listeners = new Set<(event: OrchestratorEvent) => void>();
  readonly #artifacts = new Map<string, StateArtifact>();
  readonly #index = new Map<string, StateIndexEntry>();
  readonly #history: OrchestratorEvent[] = [];
  readonly #options: Required<Omit<DesktopSessionOptions, 'logger'>> & {
    logger: Pick<Console, 'warn' | 'error'>;
  };

  #currentStateId: string | null = null;
  #lastError: string | null = null;
  #captureTimer: ReturnType<typeof setTimeout> | null = null;
  #captureQueue: Promise<void> = Promise.resolve();
  #captureActive = false;
  #captureReadStarted = false;
  #pendingAutomaticFollowUp: SettledSignal | null = null;
  #automaticCapturePending = false;
  #pendingCaptureRequest: CaptureRequest = {
    trigger: 'initial navigation',
    automatic: false,
    causes: [],
  };
  readonly #settledByContext = new Map<string, SettledCursor>();
  readonly #settleBackoff = new AutomaticSettleBackoff();
  #suppressCapture = true;
  #suppressTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  /** Invalidates a scan whose document changed while it was being read. */
  #documentGeneration = 0;

  constructor(options: DesktopSessionOptions) {
    this.#options = {
      view: options.view,
      artifactsRoot: options.artifactsRoot,
      captureDebounceMs: options.captureDebounceMs ?? 200,
      scan: options.scan ?? scanState,
      writeBundle: options.writeBundle ?? writeArtifactBundle,
      writeState: options.writeState ?? writeStateArtifact,
      logger: options.logger ?? console,
    };
    this.#journal = new ObservationJournal(join(options.artifactsRoot, this.id),
      (event) => this.#publish(event),
      (error) => this.#publish({ t: 'extraction.error', stateId: this.#currentStateId ?? 'current', message: `Observation persistence failed: ${String(error)}` }));
    this.#view = options.view;
    this.#transport = new ElectronCdpTransport(this.#view.webContents);
    this.#driver = new CdpDriver(this.#transport);
  }

  get driver(): CdpDriver { return this.#driver; }

  async start(): Promise<void> {
    // A WebContentsView that has never committed a document does not answer
    // CDP: Page.enable simply never returns and the WebContents is torn down.
    // Committing about:blank first is what makes the protocol available, and
    // it happens before any init script so instrumentation still wins the race
    // against the target page's own startup code.
    if (this.#view.webContents.getURL() === '') {
      await this.#view.webContents.loadURL('about:blank');
    }
    this.#transport.attach();
    await this.#driver.attach();
    // Must be registered before the first navigation so delegated listeners and
    // closed shadow roots created during application startup stay observable.
    await this.#driver.addInitScript(BOOTSTRAP_SOURCE);
    await this.#installSettledBinding();
    this.#attachLifecycle();
    this.#setSuppressed(false);
  }

  subscribe(listener: (event: OrchestratorEvent) => void, replay = true): () => void {
    this.#listeners.add(listener);
    if (replay) for (const event of this.#history) listener(event);
    return () => this.#listeners.delete(listener);
  }

  async goto(url: string, loadOptions?: LoadURLOptions): Promise<void> {
    this.#setSuppressed(true);
    this.#publish({ t: 'extraction.started', stateId: `capture_${randomUUID()}`, url });
    try {
      await this.#view.webContents.loadURL(url, loadOptions);
    } finally {
      this.#setSuppressed(false);
    }
    this.scheduleCapture('navigation', 0);
  }

  stateIndex(): {
    sessionId: string;
    currentStateId: string | null;
    states: StateIndexEntry[];
    lastError: string | null;
  } {
    return {
      sessionId: this.id,
      currentStateId: this.#currentStateId,
      states: [...this.#index.values()],
      lastError: this.#lastError,
    };
  }

  state(stateId: string): StateArtifact {
    const artifact = this.#artifacts.get(stateId);
    if (artifact === undefined) throw new Error(`State not found: ${stateId}`);
    return artifact;
  }

  async resetHistory(): Promise<Extract<OrchestratorEvent, { t: 'history.reset' }>> {
    const reset = this.#captureQueue.catch(() => undefined).then(async () => {
      if (this.#closed) throw new Error('Session is closed.');
      const generation = this.#documentGeneration;
      const url = this.#view.webContents.getURL();
      let through = this.#journal.sequence;
      const artifact = await this.#options.scan(this.#driver, {
        onPhase: (phase) => { if (phase === 'walking') through = this.#journal.sequence; },
      });
      const valid = () => !this.#closed && this.#documentGeneration === generation && this.#view.webContents.getURL() === url;
      if (!valid()) throw new Error('The page navigated while resetting history. Try again once it settles.');
      await this.#options.writeBundle(join(this.#options.artifactsRoot, this.id), artifact);
      if (!valid()) throw new Error('The page navigated while resetting history. Try again once it settles.');
      const pending = this.#history.flatMap((event) => event.t === 'dom.observed' && event.batch.lastSequence > through
        ? [{ ...event, batch: { ...event.batch, fromStateId: artifact.stateId, firstSequence: Math.max(through + 1, event.batch.firstSequence), observations: event.batch.observations.slice(Math.max(0, through + 1 - event.batch.firstSequence)) } }] : []);
      this.#artifacts.clear(); this.#artifacts.set(artifact.stateId, artifact);
      this.#index.clear();
      this.#index.set(artifact.stateId, { stateId: artifact.stateId, url: artifact.url, title: artifact.title, capturedAt: artifact.capturedAt, status: 'ready' });
      this.#currentStateId = artifact.stateId;
      this.#lastError = null;
      this.#history.length = 0;
      this.#settleBackoff.reset();
      const event = this.#journal.reset(artifact, through);
      for (const observation of pending) this.#publish(observation);
      return event;
    });
    this.#captureQueue = reset.then(() => undefined, () => undefined);
    return reset;
  }

  /** Draw highlight boxes in the page. The native view cannot be drawn over. */
  async highlight(
    items: Array<{ x: number; y: number; w: number; h: number; label?: string; tone?: string; primary?: boolean }>,
  ): Promise<void> {
    const frames = await this.#driver.frames().catch(() => []);
    const main = frames.find((frame) => frame.path === 'main');
    if (main === undefined) return;
    await this.#driver
      .evaluate(main, `(payload) => { window.__nexus?.highlight(payload); }`, items)
      .catch(() => undefined);
  }

  async clearHighlight(): Promise<void> {
    const frames = await this.#driver.frames().catch(() => []);
    const main = frames.find((frame) => frame.path === 'main');
    if (main === undefined) return;
    await this.#driver
      .evaluate(main, `() => { window.__nexus?.clearHighlight(); }`)
      .catch(() => undefined);
  }

  scheduleCapture(trigger: string, delay = this.#options.captureDebounceMs): void {
    if (this.#closed) return;
    this.#settleBackoff.reset();
    this.#pendingAutomaticFollowUp = null;
    if (this.#captureTimer !== null) {
      clearTimeout(this.#captureTimer);
      if (this.#pendingCaptureRequest.automatic) this.#automaticCapturePending = false;
    }
    const request: CaptureRequest = { trigger, automatic: false, causes: [] };
    this.#pendingCaptureRequest = request;
    this.#captureTimer = setTimeout(() => {
      this.#captureTimer = null;
      this.#enqueueCapture(request);
    }, delay);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#captureTimer !== null) clearTimeout(this.#captureTimer);
    if (this.#suppressTimer !== null) clearTimeout(this.#suppressTimer);
    await this.#driver.detach().catch(() => undefined);
    this.#transport.detach();
    await this.#journal.close();
    this.#listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  #publish(event: OrchestratorEvent): void {
    // A presentation refresh is an edge-trigger for already-connected UIs.
    // Replaying it would cause redundant hydration after stateIndex/state have
    // already supplied the latest persisted geometry.
    if (event.t !== 'state.presentation') {
      this.#history.push(event);
      if (this.#history.length > 1_000) this.#history.shift();
    }
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* a bad subscriber must not stop others */ }
    }
  }

  async #installSettledBinding(): Promise<void> {
    // A binding registered without a context applies to every context the
    // target creates, including documents from later navigations.
    await this.#transport.send('Runtime.addBinding', { name: '__nexusSettled' }).catch(() => undefined);
    this.#transport.on((method, params, sessionId) => {
      if (method === 'Runtime.executionContextsCleared') {
        this.#settledByContext.clear();
        return;
      }
      if (method === 'Runtime.executionContextDestroyed') {
        const contextId = params.executionContextId;
        if (typeof contextId === 'number') {
          this.#settledByContext.delete(settledContextKey(sessionId, contextId));
        }
        return;
      }
      if (method !== 'Runtime.bindingCalled') return;
      if (params.name === '__nexusObserved') {
        if (!this.#closed && this.#journal.receive(params.payload, this.#currentStateId)) {
          this.#scheduleAutomaticCapture({ causes: ['dom'] }, 'DOM activity');
        }
        return;
      }
      if (params.name !== '__nexusSettled') return;
      if (this.#closed || this.#suppressCapture) return;
      let state: unknown;
      try { state = JSON.parse(String(params.payload ?? '')); } catch { return; }
      const signal = parseSettledSignal(state);
      if (signal === null) return;

      const executionContextId = params.executionContextId;
      let presentationChanged = false;
      if (typeof executionContextId === 'number') {
        const key = settledContextKey(sessionId, executionContextId);
        const advanced = advanceSettledCursor(this.#settledByContext.get(key), signal);
        presentationChanged = advanced.presentationChanged;
        this.#settledByContext.set(key, advanced.cursor);
        // A bounded cursor table avoids retaining metadata for detached frames
        // if Chromium omits a destruction event during target teardown.
        while (this.#settledByContext.size > 512) {
          const oldest = this.#settledByContext.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#settledByContext.delete(oldest);
        }
        if (!advanced.accepted) return;
      }
      this.#scheduleAutomaticCapture({
        ...signal,
        presentationChanged,
      });
    });
  }

  #scheduleAutomaticCapture(
    signal: SettledSignal,
    trigger = 'page settled',
  ): void {
    if (this.#closed || this.#suppressCapture) return;
    if (this.#captureActive) {
      // The epoch that caused the current capture was consumed before it
      // started. A distinct settle after walking begins describes a newer DOM
      // generation, but many such notifications still need only one follow-up.
      if (this.#captureReadStarted) {
        this.#pendingAutomaticFollowUp = mergeSettledSignals(
          this.#pendingAutomaticFollowUp,
          signal,
        );
      }
      return;
    }

    // An explicit navigation/load capture already waiting in the debounce
    // window will include this settle. Never replace its request metadata or
    // make the explicit lifecycle silent.
    if (this.#captureTimer !== null && !this.#pendingCaptureRequest.automatic) return;

    if (this.#automaticCapturePending) {
      if (this.#captureTimer !== null && this.#pendingCaptureRequest.automatic) {
        const merged = mergeSettledSignals({
          causes: this.#pendingCaptureRequest.causes,
        }, signal);
        this.#pendingCaptureRequest = {
          ...this.#pendingCaptureRequest,
          causes: merged.causes,
        };
        // A native user gesture is allowed to pull a neutral trailing capture
        // forward rather than waiting behind polling-noise backoff.
        if (isInteractiveSettleCause(signal.causes) || signal.presentationChanged === true) {
          clearTimeout(this.#captureTimer);
          const request = this.#pendingCaptureRequest;
          this.#captureTimer = setTimeout(() => {
            this.#captureTimer = null;
            this.#enqueueCapture(request);
          }, this.#options.captureDebounceMs);
        }
      }
      return;
    }

    this.#automaticCapturePending = true;
    const request: CaptureRequest = {
      trigger,
      automatic: true,
      causes: signal.causes,
    };
    this.#pendingCaptureRequest = request;
    const delay = Math.max(
      this.#options.captureDebounceMs,
      signal.presentationChanged === true ? 0 : this.#settleBackoff.delay(signal.causes),
    );
    this.#captureTimer = setTimeout(() => {
      this.#captureTimer = null;
      this.#enqueueCapture(this.#pendingCaptureRequest);
    }, delay);
  }

  /**
   * Suppression exists so a capture is not attempted against a document that is
   * being torn down. Every path that sets it must have a path that clears it:
   * a flag left raised silently stops all further extraction, and the symptom
   * is an inventory that looks merely incomplete rather than broken.
   */
  #setSuppressed(value: boolean): void {
    this.#suppressCapture = value;
    if (value && this.#captureTimer !== null) {
      clearTimeout(this.#captureTimer);
      this.#captureTimer = null;
      if (this.#pendingCaptureRequest.automatic) this.#automaticCapturePending = false;
    }
    if (this.#suppressTimer !== null) clearTimeout(this.#suppressTimer);
    this.#suppressTimer = null;
    if (!value) return;
    // Backstop for a navigation that neither completes nor reports a failure.
    this.#suppressTimer = setTimeout(() => {
      this.#suppressTimer = null;
      if (!this.#suppressCapture || this.#closed) return;
      this.#suppressCapture = false;
      this.scheduleCapture('navigation timed out');
    }, 15_000);
  }

  #attachLifecycle(): void {
    const contents = this.#view.webContents;
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      // An in-place navigation replaces no document, so nothing is being torn
      // down and there is nothing to suppress.
      if (isMainFrame && !isInPlace) {
        this.#settledByContext.clear();
        this.#settleBackoff.reset();
        this.#pendingAutomaticFollowUp = null;
        this.#setSuppressed(true);
      }
    });
    contents.on('did-navigate', () => {
      // `did-navigate` is emitted only after a new main-frame document has
      // committed. Keep this epoch distinct from URL-only history/hash changes;
      // the executor compares the exact URL separately for those boundaries.
      this.#documentGeneration += 1;
    });
    contents.on('did-frame-finish-load', (_event, isMainFrame) => {
      if (!isMainFrame && !this.#suppressCapture) this.scheduleCapture('iframe loaded');
    });
    contents.on('did-finish-load', () => {
      this.#setSuppressed(false);
      this.scheduleCapture('page loaded');
    });
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.#setSuppressed(false);
      this.scheduleCapture(isMainFrame ? 'in-page navigation' : 'iframe navigation');
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      // Clear before deciding whether this is worth reporting. ERR_ABORTED (-3)
      // is raised by ordinary redirects and cancelled prefetches; treating it
      // as uninteresting must not also leave capture suppressed forever.
      this.#setSuppressed(false);
      if (code === -3) return;
      this.#lastError = `${description} (${code})`;
      this.#publish({ t: 'extraction.error', stateId: `capture_${randomUUID()}`, message: this.#lastError });
    });
  }

  #enqueueCapture(request: CaptureRequest): void {
    this.#captureQueue = this.#captureQueue
      .catch(() => undefined)
      .then(async () => { await this.#capture(request); })
      .catch((error: unknown) => {
        if (this.#closed) return;
        this.#options.logger.warn(`Capture failed: ${errorText(error)}`);
      });
  }

  async #capture(request: CaptureRequest): Promise<boolean> {
    const { trigger } = request;
    if (this.#closed || this.#suppressCapture) {
      if (request.automatic) this.#automaticCapturePending = false;
      return false;
    }
    const documentGeneration = this.#documentGeneration;
    const captureId = `capture_${randomUUID()}`;
    const url = this.#view.webContents.getURL();
    const captureIsCurrent = (): boolean => !this.#closed
      && !this.#suppressCapture
      && documentGeneration === this.#documentGeneration
      && this.#view.webContents.getURL() === url;
    let observedThrough = this.#journal.sequence;
    const parentStateId = this.#currentStateId;
    this.#captureActive = true;
    this.#captureReadStarted = false;
    const lifecycle: OrchestratorEvent[] = [];
    let lifecycleVisible = !request.automatic;
    const publishLifecycle = (event: OrchestratorEvent): void => {
      if (lifecycleVisible) this.#publish(event);
      else lifecycle.push(event);
    };
    const provisionalEntry = (): StateIndexEntry => ({
      stateId: captureId,
      url,
      title: 'Extracting…',
      capturedAt: new Date().toISOString(),
      status: 'extracting',
      ...(parentStateId === null ? {} : { parentStateId }),
      trigger,
    });
    const revealLifecycle = (): void => {
      if (lifecycleVisible) return;
      lifecycleVisible = true;
      this.#index.set(captureId, provisionalEntry());
      for (const event of lifecycle.splice(0)) this.#publish(event);
    };

    if (!request.automatic) {
      this.#lastError = null;
      this.#index.set(captureId, provisionalEntry());
    }
    publishLifecycle({ t: 'extraction.started', stateId: captureId, url });

    const emitted = new Set<ExtractionPhase>();
    const emitPhase = (phase: ExtractionPhase): void => {
      if (emitted.has(phase)) return;
      emitted.add(phase);
      publishLifecycle({ t: 'extraction.phase', stateId: captureId, phase });
    };

    try {
      emitPhase('navigating');
      const scanned = await this.#options.scan(this.#driver, {
        onPhase: (phase) => {
          emitPhase(phase);
          if (phase === 'walking') { this.#captureReadStarted = true; observedThrough = this.#journal.sequence; }
        },
      });
      // A navigation can begin while the in-page walk is running. Never publish
      // an artifact assembled from execution contexts belonging to two document
      // generations; the load lifecycle schedules a fresh capture.
      if (
        !captureIsCurrent()
      ) {
        this.#index.delete(captureId);
        return false;
      }
      for (const phase of PHASES.slice(4, -1)) emitPhase(phase);

      let artifact = scanned;
      const retained = this.#artifacts.get(artifact.stateId);
      const semanticallySame = retained !== undefined
        && semanticArtifactDigest(retained) === semanticArtifactDigest(artifact);
      const stateChanged = this.#currentStateId !== artifact.stateId;
      this.#journal.commit(parentStateId, artifact.stateId, observedThrough, trigger);

      let presentationChanged = false;
      if (semanticallySame && retained !== undefined) {
        const presentation = mergePresentationGeometry(retained, artifact);
        // Even an explicit rescan must continue with retained element ids and
        // locators. Only viewport rectangles are allowed to cross this equal-
        // semantic boundary from a freshly numbered scan.
        artifact = presentation.artifact;
        if (presentation.changed) {
          await this.#options.writeState(join(this.#options.artifactsRoot, this.id), artifact)
            .catch((error: unknown) => {
              this.#options.logger.warn(
                `Could not persist presentation geometry: ${errorText(error)}`,
              );
              return undefined;
            });
          if (
            !captureIsCurrent()
          ) return false;
          this.#artifacts.set(artifact.stateId, artifact);
          presentationChanged = true;
        }
      }

      if (
        request.automatic
        && semanticallySame
        && !stateChanged
      ) {
        // The scan was entirely speculative and was never made visible. Keep
        // the existing ready row and element identities exactly as they were.
        if (presentationChanged) {
          this.#publish({ t: 'state.presentation', stateId: artifact.stateId });
        }
        this.#settleBackoff.recordResult(presentationChanged, request.causes);
        return true;
      }
      if (request.automatic) {
        this.#settleBackoff.recordResult(true, request.causes);
        revealLifecycle();
        this.#lastError = null;
      }

      emitPhase('writing');
      // An explicit navigation still receives its normal lifecycle when it
      // reaches an already-known state, but identical data is not rewritten
      // and does not invalidate compact-element identities.
      if (!semanticallySame) {
        await this.#options.writeBundle(join(this.#options.artifactsRoot, this.id), artifact)
          .catch((error: unknown) => {
            this.#options.logger.warn(`Could not persist artifact: ${errorText(error)}`);
            return undefined;
          });
      }

      // Navigation may start while persistence is in flight. Never make an
      // artifact from the previous document current, and remove its
      // provisional row instead of leaking a permanent "extracting" entry.
      if (
        !captureIsCurrent()
      ) {
        this.#index.delete(captureId);
        return false;
      }

      const existing = retained !== undefined;
      const existingEntry = this.#index.get(artifact.stateId);
      if (!existing && parentStateId !== null && parentStateId !== artifact.stateId) {
        this.#publish({
          t: 'state.discovered',
          stateId: artifact.stateId,
          url: artifact.url,
          parentStateId,
          trigger,
          label: artifact.title || artifact.url,
        });
      }

      for (const group of artifact.groups) {
        this.#publish({
          t: 'extraction.group',
          stateId: artifact.stateId,
          group,
          actions: artifact.actions.filter(({ id }) => group.actions.includes(id)),
          observables: artifact.observables.filter(({ id }) => group.observables.includes(id)),
        });
      }
      for (const warning of artifact.warnings) {
        this.#publish({ t: 'extraction.warning', stateId: artifact.stateId, warning });
      }

      this.#index.delete(captureId);
      for (const entry of this.#index.values()) {
        if (entry.status === 'ready') entry.status = 'stale';
      }
      this.#index.set(artifact.stateId, {
        stateId: artifact.stateId,
        url: artifact.url,
        title: artifact.title,
        capturedAt: artifact.capturedAt,
        status: 'ready',
        ...(existingEntry?.parentStateId !== undefined
          ? {
              parentStateId: existingEntry.parentStateId,
              ...(existingEntry.trigger === undefined ? {} : { trigger: existingEntry.trigger }),
            }
          : !existing && parentStateId !== null && parentStateId !== artifact.stateId
            ? { parentStateId, trigger }
            : {}),
      });
      if (!semanticallySame) {
        this.#artifacts.set(artifact.stateId, artifact);
      }

      this.#currentStateId = artifact.stateId;

      this.#publish({
        t: 'extraction.completed',
        stateId: artifact.stateId,
        counts: {
          groups: artifact.groups.length,
          actions: artifact.actions.length,
          observables: artifact.observables.length,
          collections: artifact.collections.length,
          warnings: artifact.warnings.length,
        },
        timings: artifact.timings,
      });
      return true;
    } catch (error) {
      const message = errorText(error);
      if (request.automatic) {
        this.#settleBackoff.recordResult(false, request.causes);
        revealLifecycle();
      }
      const provisional = this.#index.get(captureId);
      this.#lastError = message;
      this.#index.set(captureId, {
        stateId: captureId,
        url,
        title: 'Extraction failed',
        capturedAt: new Date().toISOString(),
        status: 'error',
        ...(provisional?.parentStateId === undefined
          ? {}
          : { parentStateId: provisional.parentStateId }),
        trigger,
      });
      this.#publish({ t: 'extraction.error', stateId: captureId, message });
    } finally {
      const followUp = this.#pendingAutomaticFollowUp;
      this.#pendingAutomaticFollowUp = null;
      this.#captureActive = false;
      this.#captureReadStarted = false;
      if (request.automatic) this.#automaticCapturePending = false;
      if (followUp !== null && !this.#closed && !this.#suppressCapture) {
        this.#scheduleAutomaticCapture(followUp, 'page settled during extraction');
      }
    }
    return false;
  }
}

function settledContextKey(sessionId: string | undefined, executionContextId: number): string {
  return `${sessionId ?? 'root'}:${executionContextId}`;
}

function mergeSettledSignals(
  previous: SettledSignal | null,
  next: SettledSignal,
): SettledSignal {
  if (previous === null) return next;
  const epoch = previous.epoch === undefined
    ? next.epoch
    : next.epoch === undefined
      ? previous.epoch
      : Math.max(previous.epoch, next.epoch);
  const surfaceDigest = next.surfaceDigest ?? previous.surfaceDigest;
  const presentationDigest = next.presentationDigest ?? previous.presentationDigest;
  return {
    ...(epoch === undefined ? {} : { epoch }),
    causes: [...new Set([...previous.causes, ...next.causes])],
    ...(surfaceDigest === undefined ? {} : { surfaceDigest }),
    ...(presentationDigest === undefined ? {} : { presentationDigest }),
    ...(previous.presentationChanged === true || next.presentationChanged === true
      ? { presentationChanged: true }
      : {}),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const properties = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${properties.join(',')}}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
