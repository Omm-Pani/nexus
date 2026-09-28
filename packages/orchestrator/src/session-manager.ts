import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as extractor from '@nexus/extractor';
import type {
  ExtractionGroupPayload,
  ScanStateOptions,
} from '@nexus/extractor';
import type {
  ExtractionPhase,
  OrchestratorEvent,
  StateArtifact,
} from '@nexus/schema';
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type CDPSession,
  type Frame,
  chromium,
  type Page,
} from 'playwright';

import type {
  CreateSessionRequest,
  InputCommand,
  KeyInputCommand,
  MouseButton,
  MouseInputCommand,
  SessionSnapshot,
  SessionStateIndex,
  SessionStateIndexEntry,
} from './protocol.js';

const EXTRACTION_PHASES: readonly ExtractionPhase[] = [
  'navigating',
  'injecting',
  'settling',
  'walking',
  'classifying',
  'grouping',
  'observing',
  'writing',
];
const DEFAULT_ARTIFACTS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  '.nexus',
  'sessions',
);

const MOUSE_TYPES = new Set<MouseInputCommand['type']>([
  'mousePressed',
  'mouseReleased',
  'mouseMoved',
  'mouseWheel',
]);
const MOUSE_BUTTONS = new Set<MouseButton>([
  'none',
  'left',
  'middle',
  'right',
  'back',
  'forward',
]);
const KEY_TYPES = new Set<KeyInputCommand['type']>(['keyDown', 'keyUp', 'char']);

type EventListener = (event: OrchestratorEvent) => void;

export interface ScanInvocationOptions extends ScanStateOptions {
  observedMethods: string[];
}

export type ScanStateFunction = (
  page: Page,
  options?: ScanInvocationOptions,
) => Promise<StateArtifact>;

export type InstallInstrumentationFunction = (page: Page) => Promise<void>;

const MIN_AUTOMATIC_SETTLE_BACKOFF_MS = 250;
const MAX_AUTOMATIC_SETTLE_BACKOFF_MS = 5_000;
const VOLATILE_ARTIFACT_KEYS = new Set(['buildId', 'capturedAt', 'timings']);

interface SettledDocumentState {
  lastEpoch: number | null;
  lastSurface: string | null;
  lastPresentation: string | null;
}

interface CaptureSchedulingOptions {
  automatic?: boolean;
  bypassBackoff?: boolean;
}

export interface SessionManagerDependencies {
  launchBrowser?: () => Promise<Browser>;
  installInstrumentation?: InstallInstrumentationFunction;
  scan?: ScanStateFunction;
  writeBundle?: typeof extractor.writeArtifactBundle;
  writeState?: typeof extractor.writeStateArtifact;
  createCdpSession?: (context: BrowserContext, page: Page) => Promise<CDPSession | null>;
  artifactsRoot?: string;
  captureDebounceMs?: number;
  eventHistoryLimit?: number;
  logger?: Pick<Console, 'error' | 'warn'>;
}

export class SessionNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'session_not_found';

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class StateNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'state_not_found';

  constructor(stateId: string) {
    super(`State not found: ${stateId}`);
    this.name = 'StateNotFoundError';
  }
}

export class InvalidRequestError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_request';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class InputUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'input_unavailable';

  constructor(message = 'Browser input is unavailable for this session.') {
    super(message);
    this.name = 'InputUnavailableError';
  }
}

interface ManagedSession {
  id: string;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession | null;
  /** True when CDP, rather than Playwright's URL-level event, owns document epochs. */
  cdpTracksDocuments: boolean;
  outputDirectory: string;
  artifacts: Map<string, StateArtifact>;
  stateIndex: Map<string, SessionStateIndexEntry>;
  currentStateId: string | null;
  lastError: string | null;
  eventHistory: OrchestratorEvent[];
  latestFrame: Extract<OrchestratorEvent, { t: 'frame' }> | null;
  listeners: Set<EventListener>;
  observedMethods: Set<string>;
  inputQueue: Promise<void>;
  navigationQueue: Promise<void>;
  captureQueue: Promise<void>;
  captureTimer: ReturnType<typeof setTimeout> | null;
  pendingTrigger: string;
  pendingCaptureId: string | null;
  pendingCaptureAutomatic: boolean;
  pendingCaptureDueAt: number;
  capturePhases: Map<string, Set<ExtractionPhase>>;
  captureActive: boolean;
  captureReadStarted: boolean;
  captureDirty: boolean;
  captureDirtyTrigger: string;
  captureDirtyBypassBackoff: boolean;
  automaticNoopStreak: number;
  automaticBackoffUntil: number;
  settledDocuments: WeakMap<Frame, SettledDocumentState>;
  suppressAutomaticCapture: boolean;
  /** Increments for every committed main-frame document navigation. */
  documentGeneration: number;
  journal: extractor.ObservationJournal;
  closed: boolean;
}

const STATE_CHANGING_KEYS = new Set([
  'Enter',
  ' ',
  'Space',
  'Spacebar',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab',
  'Escape',
  'Select',
  'NumpadEnter',
]);

function validateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError('A URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidRequestError(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidRequestError(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  return parsed.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalFiniteNumber(
  value: unknown,
  property: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidRequestError(`${property} must be a finite number.`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, property: string): number {
  const parsed = optionalFiniteNumber(value, property);
  if (parsed === undefined) {
    throw new InvalidRequestError(`${property} is required.`);
  }
  return parsed;
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  if (!isRecord(value)) {
    throw new InvalidRequestError('Request body must be a JSON object.');
  }

  const url = validateUrl(value.url);
  if (value.credentials === undefined) return { url };
  if (!isRecord(value.credentials)) {
    throw new InvalidRequestError('credentials must be a JSON object.');
  }

  const username = value.credentials.username;
  const password = value.credentials.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw new InvalidRequestError('credentials require string username and password fields.');
  }

  return { url, credentials: { username, password } };
}

export function parseGotoRequest(value: unknown): string {
  if (!isRecord(value)) {
    throw new InvalidRequestError('Request body must be a JSON object.');
  }
  return validateUrl(value.url);
}

export function parseInputCommand(value: unknown): InputCommand {
  if (!isRecord(value)) {
    throw new InvalidRequestError('Input command must be a JSON object.');
  }

  if (value.method !== undefined) {
    if (
      value.method !== 'Input.dispatchMouseEvent' &&
      value.method !== 'Input.dispatchKeyEvent'
    ) {
      throw new InvalidRequestError('Only CDP mouse and key input methods are allowed.');
    }
    if (!isRecord(value.params)) {
      throw new InvalidRequestError('Raw CDP input requires a params object.');
    }
    return { method: value.method, params: value.params };
  }

  if (value.kind === 'mouse') {
    if (typeof value.type !== 'string' || !MOUSE_TYPES.has(value.type as MouseInputCommand['type'])) {
      throw new InvalidRequestError('Invalid mouse input type.');
    }
    if (
      value.button !== undefined &&
      (typeof value.button !== 'string' || !MOUSE_BUTTONS.has(value.button as MouseButton))
    ) {
      throw new InvalidRequestError('Invalid mouse button.');
    }

    const command: MouseInputCommand = {
      kind: 'mouse',
      type: value.type as MouseInputCommand['type'],
      x: requiredFiniteNumber(value.x, 'x'),
      y: requiredFiniteNumber(value.y, 'y'),
    };
    if (typeof value.button === 'string') command.button = value.button as MouseButton;
    const clickCount = optionalFiniteNumber(value.clickCount, 'clickCount');
    if (clickCount !== undefined) command.clickCount = clickCount;
    const deltaX = optionalFiniteNumber(value.deltaX, 'deltaX');
    if (deltaX !== undefined) command.deltaX = deltaX;
    const deltaY = optionalFiniteNumber(value.deltaY, 'deltaY');
    if (deltaY !== undefined) command.deltaY = deltaY;
    const modifiers = optionalFiniteNumber(value.modifiers, 'modifiers');
    if (modifiers !== undefined) command.modifiers = modifiers;
    return command;
  }

  if (value.kind === 'key') {
    if (typeof value.type !== 'string' || !KEY_TYPES.has(value.type as KeyInputCommand['type'])) {
      throw new InvalidRequestError('Invalid key input type.');
    }

    const command: KeyInputCommand = {
      kind: 'key',
      type: value.type as KeyInputCommand['type'],
    };
    for (const property of ['key', 'code', 'text'] as const) {
      const propertyValue = value[property];
      if (propertyValue !== undefined && typeof propertyValue !== 'string') {
        throw new InvalidRequestError(`${property} must be a string.`);
      }
      if (typeof propertyValue === 'string') command[property] = propertyValue;
    }
    const modifiers = optionalFiniteNumber(value.modifiers, 'modifiers');
    if (modifiers !== undefined) command.modifiers = modifiers;
    if (command.key === undefined && command.code === undefined && command.text === undefined) {
      throw new InvalidRequestError('Key input requires key, code, or text.');
    }
    return command;
  }

  throw new InvalidRequestError('Input kind must be mouse or key.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function stableArtifactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableArtifactValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE_ARTIFACT_KEYS.has(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableArtifactValue(child)]),
    );
  }
  return value;
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

export function artifactSemanticDigest(artifact: StateArtifact): string {
  return createHash('sha256')
    .update(JSON.stringify(stableArtifactValue(canonicalSemanticArtifact(artifact))))
    .digest('hex');
}

function isAutomaticSettleTrigger(trigger: string): boolean {
  return trigger.startsWith('page settled');
}

function settledCausesAreInteractive(causes: readonly string[]): boolean {
  return causes.some((cause) =>
    /(?:click|input|value|change|key|pointer|mouse|touch|interaction|history|popstate|hashchange|submit)/i
      .test(cause),
  );
}

export class SessionManager {
  readonly #dependencies: Required<
    Pick<
      SessionManagerDependencies,
      | 'launchBrowser'
      | 'installInstrumentation'
      | 'scan'
      | 'writeBundle'
      | 'writeState'
      | 'createCdpSession'
      | 'artifactsRoot'
      | 'captureDebounceMs'
      | 'eventHistoryLimit'
      | 'logger'
    >
  >;
  readonly #sessions = new Map<string, ManagedSession>();
  #browser: Browser | null = null;
  #startPromise: Promise<Browser> | null = null;
  #expectedContextCount = 0;
  #lifecycleQueue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(dependencies: SessionManagerDependencies = {}) {
    this.#dependencies = {
      launchBrowser:
        dependencies.launchBrowser ?? (() => chromium.launch({ headless: true })),
      installInstrumentation:
        dependencies.installInstrumentation ?? extractor.installInstrumentation,
      scan:
        dependencies.scan ??
        (extractor.scanState as unknown as ScanStateFunction),
      writeBundle: dependencies.writeBundle ?? extractor.writeArtifactBundle,
      writeState: dependencies.writeState ?? extractor.writeStateArtifact,
      createCdpSession:
        dependencies.createCdpSession ??
        (async (context, page) => context.newCDPSession(page)),
      artifactsRoot: dependencies.artifactsRoot ?? DEFAULT_ARTIFACTS_ROOT,
      captureDebounceMs: dependencies.captureDebounceMs ?? 180,
      eventHistoryLimit: dependencies.eventHistoryLimit ?? 1_000,
      logger: dependencies.logger ?? console,
    };
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get expectedContextCount(): number {
    return this.#expectedContextCount;
  }

  async start(): Promise<void> {
    await this.#browserHandle();
  }

  async createSession(request: CreateSessionRequest): Promise<string> {
    const normalized = parseCreateSessionRequest(request);
    return this.#withLifecycleLock(async () => {
      const browser = await this.#browserHandle();
      this.#assertNoContextLeak(browser);
      this.#expectedContextCount += 1;

      let context: BrowserContext | null = null;
      try {
        const options: BrowserContextOptions = {
          viewport: { width: 1280, height: 720 },
        };
        if (normalized.credentials !== undefined) {
          options.httpCredentials = normalized.credentials;
        }
        context = await browser.newContext(options);
        const page = await context.newPage();

        // This must be the first page operation. The extractor installs init
        // scripts here so delegated listeners and closed roots are observable.
        await this.#dependencies.installInstrumentation(page);

        const id = randomUUID();
        const session: ManagedSession = {
          id,
          context,
          page,
          cdp: null,
          cdpTracksDocuments: false,
          outputDirectory: join(this.#dependencies.artifactsRoot, id),
          artifacts: new Map(),
          stateIndex: new Map(),
          currentStateId: null,
          lastError: null,
          eventHistory: [],
          latestFrame: null,
          listeners: new Set(),
          observedMethods: new Set(),
          inputQueue: Promise.resolve(),
          navigationQueue: Promise.resolve(),
          captureQueue: Promise.resolve(),
          captureTimer: null,
          pendingTrigger: 'initial navigation',
          pendingCaptureId: null,
          pendingCaptureAutomatic: false,
          pendingCaptureDueAt: 0,
          capturePhases: new Map(),
          captureActive: false,
          captureReadStarted: false,
          captureDirty: false,
          captureDirtyTrigger: 'page settled',
          captureDirtyBypassBackoff: false,
          automaticNoopStreak: 0,
          automaticBackoffUntil: 0,
          settledDocuments: new WeakMap(),
          suppressAutomaticCapture: true,
          documentGeneration: 0,
          journal: new extractor.ObservationJournal(join(this.#dependencies.artifactsRoot, id),
            (event) => this.#publish(session, event),
            (error) => this.#publish(session, { t: 'extraction.error', stateId: session.currentStateId ?? 'current', message: `Observation persistence failed: ${String(error)}` })),
          closed: false,
        };

        this.#sessions.set(id, session);
        this.#attachPageLifecycle(session);
        await this.#attachSettledBinding(session);
        await this.#attachCdp(session);

        // Navigation and the first extraction intentionally continue in the
        // background. The caller can attach the WebSocket immediately and
        // receive the provisional extraction lifecycle while a slow page is
        // still loading.
        const initialCaptureId = this.#beginCapture(
          session,
          normalized.url,
          'initial navigation',
        );
        void this.#queueNavigation(
          session,
          normalized.url,
          'initial navigation',
          initialCaptureId,
        ).catch(() => undefined);
        return id;
      } catch (error) {
        if (context !== null) {
          const failedSession = [...this.#sessions.values()].find(
            (session) => session.context === context,
          );
          if (failedSession !== undefined) this.#sessions.delete(failedSession.id);
          await context.close().catch(() => undefined);
        }
        this.#expectedContextCount -= 1;
        throw error;
      }
    });
  }

  async goto(sessionId: string, url: string): Promise<void> {
    const normalizedUrl = validateUrl(url);
    const session = this.#session(sessionId);
    await this.#queueNavigation(session, normalizedUrl, 'goto');
  }

  async resetHistory(sessionId: string): Promise<Extract<OrchestratorEvent, { t: 'history.reset' }>> {
    const session = this.#session(sessionId);
    await session.navigationQueue;
    const reset = session.captureQueue.catch(() => undefined).then(async () => {
      if (session.closed) throw new SessionNotFoundError(sessionId);
      const generation = session.documentGeneration;
      const url = session.page.url();
      let through = session.journal.sequence;
      const artifact = await this.#dependencies.scan(session.page, {
        observedMethods: [],
        onPhase: (phase) => { if (phase === 'walking') through = session.journal.sequence; },
      });
      const valid = () => !session.closed && session.documentGeneration === generation && session.page.url() === url;
      if (!valid()) throw new Error('The page navigated while resetting history. Try again once it settles.');
      await this.#dependencies.writeBundle(session.outputDirectory, artifact);
      if (!valid()) throw new Error('The page navigated while resetting history. Try again once it settles.');
      const pending = session.eventHistory.flatMap((event) => event.t === 'dom.observed' && event.batch.lastSequence > through
        ? [{ ...event, batch: { ...event.batch, fromStateId: artifact.stateId, firstSequence: Math.max(through + 1, event.batch.firstSequence), observations: event.batch.observations.slice(Math.max(0, through + 1 - event.batch.firstSequence)) } }] : []);
      session.artifacts.clear(); session.artifacts.set(artifact.stateId, artifact);
      session.stateIndex.clear();
      session.stateIndex.set(artifact.stateId, { stateId: artifact.stateId, url: artifact.url, title: artifact.title, capturedAt: artifact.capturedAt, status: 'ready' });
      session.currentStateId = artifact.stateId;
      session.lastError = null;
      session.eventHistory.length = 0;
      session.automaticNoopStreak = 0; session.automaticBackoffUntil = 0;
      const event = session.journal.reset(artifact, through);
      for (const observation of pending) this.#publish(session, observation);
      return event;
    });
    session.captureQueue = reset.then(() => undefined, () => undefined);
    return reset;
  }

  async dispatchInput(sessionId: string, value: unknown): Promise<void> {
    const session = this.#session(sessionId);
    const command = parseInputCommand(value);
    const navigationBarrier = session.navigationQueue;

    // HTTP requests and WebSocket messages can arrive concurrently. A single
    // queue per browser session preserves press/release and key event order,
    // while a rejected dispatch does not poison later input.
    const dispatch = session.inputQueue
      .catch(() => undefined)
      .then(async () => {
        // Only the navigation barrier is honoured. Waiting for the capture
        // queue to drain here put a full DOM walk in front of every click and
        // keystroke, which is what made the live view feel like a remote
        // desktop. Extraction reads the page; it does not own it, and a
        // gesture that lands mid-scan simply produces another debounced scan.
        await navigationBarrier;
        if (session.closed) throw new SessionNotFoundError(sessionId);
        await this.#dispatchInputCommand(session, command);
      });
    session.inputQueue = dispatch.catch(() => undefined);
    await dispatch;
  }

  async #dispatchInputCommand(
    session: ManagedSession,
    command: InputCommand,
  ): Promise<void> {

    if ('method' in command) {
      if (session.cdp === null) {
        throw new InputUnavailableError('Raw CDP input requires an active CDP session.');
      }
      await session.cdp.send(command.method as never, command.params as never);
      this.#scheduleAfterRawInput(session, command.method, command.params);
      return;
    }

    if (command.kind === 'mouse') {
      if (command.type === 'mousePressed') session.observedMethods.clear();
      if (session.cdp !== null) {
        const params = {
          type: command.type,
          x: command.x,
          y: command.y,
          ...(command.button === undefined ? {} : { button: command.button }),
          ...(command.clickCount === undefined ? {} : { clickCount: command.clickCount }),
          ...(command.deltaX === undefined ? {} : { deltaX: command.deltaX }),
          ...(command.deltaY === undefined ? {} : { deltaY: command.deltaY }),
          ...(command.modifiers === undefined ? {} : { modifiers: command.modifiers }),
        };
        await session.cdp.send('Input.dispatchMouseEvent', params);
      } else {
        await this.#dispatchMouseWithPlaywright(session.page, command);
      }

      if (command.type === 'mouseReleased' || command.type === 'mouseWheel') {
        this.#scheduleCapture(session, command.type, this.#dependencies.captureDebounceMs);
      }
      return;
    }

    if (command.type === 'keyDown') {
      session.observedMethods.clear();
    }
    if (session.cdp !== null) {
      const params = {
        type: command.type,
        ...(command.key === undefined ? {} : { key: command.key }),
        ...(command.code === undefined ? {} : { code: command.code }),
        ...(command.text === undefined ? {} : { text: command.text }),
        ...(command.modifiers === undefined ? {} : { modifiers: command.modifiers }),
      };
      await session.cdp.send('Input.dispatchKeyEvent', params);
    } else {
      await this.#dispatchKeyWithPlaywright(session.page, command);
    }

    if (this.#keyInputMayChangeState(command.type, command.key, command.code, command.text)) {
      this.#scheduleCapture(
        session,
        this.#keyTrigger(command.key, command.code, command.text),
        this.#dependencies.captureDebounceMs,
      );
    }
  }

  getState(sessionId: string, stateId: string): StateArtifact {
    const artifact = this.#session(sessionId).artifacts.get(stateId);
    if (artifact === undefined) throw new StateNotFoundError(stateId);
    return artifact;
  }

  getStateIndex(sessionId: string): SessionStateIndex {
    const session = this.#session(sessionId);
    return {
      sessionId,
      currentStateId: session.currentStateId,
      states: [...session.stateIndex.values()],
      lastError: session.lastError,
    };
  }

  snapshot(sessionId: string): SessionSnapshot {
    const session = this.#session(sessionId);
    return {
      index: this.getStateIndex(sessionId),
      artifacts: new Map(session.artifacts),
      events: [...session.eventHistory],
      latestFrame: session.latestFrame,
    };
  }

  subscribe(sessionId: string, listener: EventListener, replay = true): () => void {
    const session = this.#session(sessionId);
    session.listeners.add(listener);
    if (replay) {
      try {
        if (session.latestFrame !== null) listener(session.latestFrame);
        for (const event of session.eventHistory) listener(event);
      } catch (error) {
        session.listeners.delete(listener);
        this.#dependencies.logger.warn(
          `Event replay listener failed: ${errorMessage(error)}`,
        );
      }
    }
    return () => session.listeners.delete(listener);
  }

  /** Flushes debounce and capture queues. Primarily useful to deterministic tests. */
  async waitForIdle(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    await session.navigationQueue;
    await session.inputQueue;
    while (!session.closed) {
      if (session.captureTimer !== null) {
        clearTimeout(session.captureTimer);
        session.captureTimer = null;
        const captureId = session.pendingCaptureId;
        session.pendingCaptureId = null;
        session.pendingCaptureAutomatic = false;
        session.pendingCaptureDueAt = 0;
        this.#enqueueCapture(session, session.pendingTrigger, captureId);
      }
      const queue = session.captureQueue;
      await queue;
      if (session.captureTimer === null && queue === session.captureQueue) return;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#withLifecycleLock(async () => {
      const session = this.#session(sessionId);
      session.closed = true;
      if (session.captureTimer !== null) clearTimeout(session.captureTimer);
      session.captureTimer = null;
      session.pendingCaptureId = null;
      session.pendingCaptureAutomatic = false;
      session.pendingCaptureDueAt = 0;

      // Closing the browser context is what aborts a blocked goto, CDP input, or
      // page evaluation. Never wait for those queues before issuing the abort.
      const drains = Promise.allSettled([
        session.inputQueue,
        session.navigationQueue,
        session.captureQueue,
      ]);
      void drains;
      if (session.cdp !== null) void session.cdp.detach().catch(() => undefined);
      try {
        await session.context.close();
        await session.journal.close();
      } finally {
        this.#sessions.delete(sessionId);
        this.#expectedContextCount -= 1;
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#withLifecycleLock(async () => {
      for (const session of this.#sessions.values()) {
        session.closed = true;
        if (session.captureTimer !== null) clearTimeout(session.captureTimer);
        session.captureTimer = null;
        session.pendingCaptureId = null;
        session.pendingCaptureAutomatic = false;
        session.pendingCaptureDueAt = 0;
      }

      const sessions = [...this.#sessions.values()];
      for (const session of sessions) {
        void Promise.allSettled([
          session.inputQueue,
          session.navigationQueue,
          session.captureQueue,
        ]);
        if (session.cdp !== null) void session.cdp.detach().catch(() => undefined);
      }

      // Context/browser closure rejects outstanding Playwright work. Awaiting
      // operation queues first would deadlock shutdown when a page is hung.
      const browser = this.#browser;
      this.#browser = null;
      await Promise.allSettled([
        ...sessions.map(async (session) => { await session.context.close(); await session.journal.close(); }),
        ...(browser === null ? [] : [browser.close()]),
      ]);
      this.#sessions.clear();
      this.#expectedContextCount = 0;
    });
  }

  async #browserHandle(): Promise<Browser> {
    if (this.#closed) throw new Error('The session manager has been closed.');
    if (this.#browser !== null) return this.#browser;
    if (this.#startPromise === null) {
      this.#startPromise = this.#dependencies.launchBrowser().then((browser) => {
        this.#browser = browser;
        return browser;
      });
    }
    return this.#startPromise;
  }

  async #withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleQueue;
    let release = (): void => undefined;
    this.#lifecycleQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #session(sessionId: string): ManagedSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) throw new SessionNotFoundError(sessionId);
    return session;
  }

  #assertNoContextLeak(browser: Browser): void {
    const actual = browser.contexts().length;
    if (actual > this.#expectedContextCount) {
      throw new Error(`Context leak: ${actual}; expected ${this.#expectedContextCount}`);
    }
  }

  #attachPageLifecycle(session: ManagedSession): void {
    session.page.on('framenavigated', (frame) => {
      // Playwright reuses Frame objects across document navigations. Epochs
      // emitted by instrumentation restart for each document, so the
      // de-duplication cursor must restart with them.
      session.settledDocuments.delete(frame);
      if (frame !== session.page.mainFrame()) {
        if (!session.suppressAutomaticCapture) this.#scheduleCapture(session, 'iframe navigation', this.#dependencies.captureDebounceMs);
        return;
      }
      // Playwright also emits `framenavigated` for same-document history/hash
      // changes. CDP distinguishes those from a newly committed document. In
      // the degraded no-CDP path this remains the best available invalidation
      // signal; normal Chromium sessions use Page.frameNavigated below.
      if (!session.cdpTracksDocuments) session.documentGeneration += 1;
      if (session.suppressAutomaticCapture) return;
      this.#scheduleCapture(
        session,
        'main-frame navigation',
        this.#dependencies.captureDebounceMs,
      );
    });

    session.context.on('page', (popup) => {
      if (popup === session.page) return;
      // OAuth popups are allowed to complete in this existing context but are
      // never adopted as the session page or sent through extraction.
      void popup
        .waitForEvent('close', { timeout: 60_000 })
        .catch(async () => popup.close().catch(() => undefined));
    });
  }

  async #attachSettledBinding(session: ManagedSession): Promise<void> {
    try {
      await session.page.exposeBinding('__nexusObserved', (_source, payload: unknown) => {
        if (session.closed || !session.journal.receive(payload, session.currentStateId)) return;
        if (session.suppressAutomaticCapture) return;
        if (session.captureActive) {
          session.captureDirty = true;
          session.captureDirtyTrigger = 'DOM activity during extraction';
          session.captureDirtyBypassBackoff = true;
        } else if (session.captureTimer === null) {
          this.#scheduleCapture(session, 'DOM activity', this.#dependencies.captureDebounceMs, null, { automatic: true, bypassBackoff: true });
        }
      });
      await session.page.exposeBinding(
        '__nexusSettled',
        (source, payload: unknown) => {
          // The bootstrap sends JSON so the same call works over a CDP binding.
          let state: unknown = payload;
          if (typeof payload === 'string') {
            try { state = JSON.parse(payload); } catch { return; }
          }
          if (
            session.closed ||
            !isRecord(state) ||
            state.settled !== true
          ) {
            return;
          }

          const epoch = typeof state.epoch === 'number'
            && Number.isSafeInteger(state.epoch)
            && state.epoch >= 0
            ? state.epoch
            : null;
          const causes = Array.isArray(state.causes)
            ? state.causes.filter((cause): cause is string => typeof cause === 'string').slice(0, 16)
            : [];
          const surface = isRecord(state.surface)
            && typeof state.surface.digest === 'string'
            && state.surface.digest !== ''
            ? state.surface.digest.slice(0, 256)
            : null;
          const presentation = isRecord(state.surface)
            && typeof state.surface.presentationDigest === 'string'
            && state.surface.presentationDigest !== ''
            ? state.surface.presentationDigest.slice(0, 256)
            : null;
          const signalFrame = source.frame ?? session.page.mainFrame();
          const documentState = session.settledDocuments.get(signalFrame) ?? {
            lastEpoch: null,
            lastSurface: null,
            lastPresentation: null,
          };

          // A signal is scoped to its Playwright Frame and current document.
          // Duplicate/out-of-order epochs and a new epoch describing the same
          // cheap semantic surface are notifications, not extraction work.
          if (
            epoch !== null
            && documentState.lastEpoch !== null
            && epoch <= documentState.lastEpoch
          ) return;
          if (epoch !== null) documentState.lastEpoch = epoch;
          const repeatedSurface = surface !== null
            && documentState.lastSurface === surface;
          const changedPresentation = presentation !== null
            && documentState.lastPresentation !== null
            && documentState.lastPresentation !== presentation;
          if (surface !== null) documentState.lastSurface = surface;
          if (presentation !== null) documentState.lastPresentation = presentation;
          session.settledDocuments.set(signalFrame, documentState);
          if ((repeatedSurface && !changedPresentation) || session.suppressAutomaticCapture) return;

          const bypassBackoff = changedPresentation || settledCausesAreInteractive(causes);
          if (session.captureActive) {
            // The extractor's own quiescence wait emits once before walking.
            // Only a settle observed after the read begins means the DOM may
            // have changed underneath this capture and needs a follow-up.
            if (session.captureReadStarted) {
              session.captureDirty = true;
              session.captureDirtyTrigger = 'page settled during extraction';
              session.captureDirtyBypassBackoff ||= bypassBackoff;
            }
            return;
          }
          this.#scheduleCapture(
            session,
            'page settled',
            this.#dependencies.captureDebounceMs,
            null,
            { automatic: true, bypassBackoff },
          );
        },
      );
    } catch (error) {
      // Extraction remains usable without push notifications because explicit
      // navigation and user input still schedule captures.
      this.#dependencies.logger.warn(
        `Dynamic page notifications unavailable: ${errorMessage(error)}`,
      );
    }
  }

  #queueNavigation(
    session: ManagedSession,
    url: string,
    trigger: string,
    startedCaptureId: string | null = null,
  ): Promise<void> {
    const inputBarrier = session.inputQueue;
    const navigation = session.navigationQueue
      .catch(() => undefined)
      .then(async () => {
        if (startedCaptureId === null) {
          await inputBarrier;
          if (session.closed) throw new SessionNotFoundError(session.id);

          // A pending debounce describes the document we are about to replace.
          // Cancel it and wait for any capture that has already begun so scans
          // and page navigation never overlap.
          if (session.captureTimer !== null) clearTimeout(session.captureTimer);
          session.captureTimer = null;
          session.pendingCaptureId = null;
          session.pendingCaptureAutomatic = false;
          session.pendingCaptureDueAt = 0;
          await this.#waitForCaptureDrain(session);
          if (session.closed) throw new SessionNotFoundError(session.id);
        }

        const captureId = startedCaptureId ?? this.#beginCapture(session, url, trigger);
        session.observedMethods.clear();
        session.suppressAutomaticCapture = true;
        try {
          await session.page.goto(url, { waitUntil: 'domcontentloaded' });
        } catch (error) {
          if (!session.closed) {
            this.#recordCaptureFailure(session, captureId, url, trigger, error);
          }
          throw error;
        } finally {
          session.suppressAutomaticCapture = false;
        }
        if (!session.closed) {
          this.#enqueueCapture(session, trigger, captureId);
          // Include any dirty follow-up appended by the correlated capture
          // before allowing another queued navigation to replace the page.
          await this.#waitForCaptureDrain(session);
        }
      });
    session.navigationQueue = navigation.catch((error: unknown) => {
      if (!session.closed) {
        this.#dependencies.logger.error(
          `Navigation failed: ${errorMessage(error)}`,
        );
      }
    });
    return navigation;
  }

  async #attachCdp(session: ManagedSession): Promise<void> {
    try {
      const cdp = await this.#dependencies.createCdpSession(session.context, session.page);
      session.cdp = cdp;
      if (cdp === null) return;
      cdp.on('Page.frameNavigated', (payload: {
        frame?: { id?: unknown; parentId?: unknown };
      }) => {
        const frame = payload.frame;
        if (
          frame === undefined
          || typeof frame.id !== 'string'
          || typeof frame.parentId === 'string'
        ) return;
        session.documentGeneration += 1;
      });
      cdp.on('Network.requestWillBeSent', (payload: { request?: { method?: unknown } }) => {
        const method = payload.request?.method;
        if (typeof method === 'string') session.observedMethods.add(method.toUpperCase());
      });
      cdp.on(
        'Page.screencastFrame',
        (payload: { data?: unknown; sessionId?: unknown }) => {
          if (typeof payload.data === 'string') {
            this.#publish(session, { t: 'frame', data: payload.data });
          }
          if (typeof payload.sessionId === 'number') {
            void cdp
              .send('Page.screencastFrameAck', { sessionId: payload.sessionId })
              .catch((error: unknown) =>
                this.#dependencies.logger.warn(
                  `Could not acknowledge screencast frame: ${errorMessage(error)}`,
                ),
              );
          }
        },
      );
      session.cdpTracksDocuments = await cdp.send('Page.enable')
        .then(() => true)
        .catch((error: unknown) => {
          this.#dependencies.logger.warn(
            `CDP document lifecycle unavailable: ${errorMessage(error)}`,
          );
          return false;
        });
      await cdp.send('Network.enable').catch((error: unknown) =>
        this.#dependencies.logger.warn(
          `CDP network capture unavailable: ${errorMessage(error)}`,
        ),
      );
      await cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 60,
          maxWidth: 1280,
          maxHeight: 720,
          everyNthFrame: 2,
        })
        .catch((error: unknown) =>
          this.#dependencies.logger.warn(
            `CDP screencast unavailable: ${errorMessage(error)}`,
          ),
        );
    } catch (error) {
      session.cdp = null;
      this.#dependencies.logger.warn(`CDP unavailable: ${errorMessage(error)}`);
    }
  }

  #scheduleCapture(
    session: ManagedSession,
    trigger: string,
    delay: number,
    captureId: string | null = null,
    options: CaptureSchedulingOptions = {},
  ): void {
    if (session.closed) return;
    const automatic = options.automatic ?? isAutomaticSettleTrigger(trigger);
    const now = Date.now();
    const backoffRemaining = automatic && !options.bypassBackoff
      ? Math.max(0, session.automaticBackoffUntil - now)
      : 0;
    const effectiveDelay = Math.max(delay, backoffRemaining);
    const dueAt = now + effectiveDelay;

    if (automatic && session.captureTimer !== null) {
      // An explicit input/navigation scan already covers this notification.
      // Multiple automatic notifications share one trailing timer instead of
      // continually pushing the debounce window forward.
      if (!session.pendingCaptureAutomatic) return;
      if (!options.bypassBackoff || session.pendingCaptureDueAt <= dueAt) return;
    }

    if (session.captureTimer !== null) clearTimeout(session.captureTimer);
    session.pendingTrigger = trigger;
    session.pendingCaptureAutomatic = automatic;
    session.pendingCaptureDueAt = dueAt;
    // Keep an already-started navigation capture correlated when a settled or
    // input signal coalesces into the same debounce window.
    if (captureId !== null || session.pendingCaptureId === null) {
      session.pendingCaptureId = captureId;
    }
    session.captureTimer = setTimeout(() => {
      session.captureTimer = null;
      const pendingCaptureId = session.pendingCaptureId;
      session.pendingCaptureId = null;
      session.pendingCaptureAutomatic = false;
      session.pendingCaptureDueAt = 0;
      this.#enqueueCapture(session, session.pendingTrigger, pendingCaptureId);
    }, effectiveDelay);
  }

  #enqueueCapture(
    session: ManagedSession,
    trigger: string,
    captureId: string | null = null,
  ): void {
    const capture = session.captureQueue
      .catch(() => undefined)
      .then(async () => {
        if (!session.closed) await this.#capture(session, trigger, captureId);
      });
    session.captureQueue = capture.catch((error: unknown) => {
      if (!session.closed) {
        this.#dependencies.logger.error(`Extraction failed: ${errorMessage(error)}`);
      }
    });
  }

  async #waitForCaptureDrain(session: ManagedSession): Promise<void> {
    while (!session.closed) {
      const queue = session.captureQueue;
      await queue;
      if (queue === session.captureQueue) return;
    }
  }

  #beginCapture(
    session: ManagedSession,
    url: string,
    trigger: string,
    captureId = `capture_${randomUUID()}`,
  ): string {
    const phases = new Set<ExtractionPhase>(['navigating']);
    session.capturePhases.set(captureId, phases);
    session.lastError = null;
    const parentStateId = session.currentStateId;
    if (parentStateId !== null) {
      const parent = session.stateIndex.get(parentStateId);
      if (parent !== undefined && parent.status !== 'error') parent.status = 'stale';
    }
    session.currentStateId = null;
    session.stateIndex.set(captureId, {
      stateId: captureId,
      url,
      title: 'Extracting…',
      capturedAt: new Date().toISOString(),
      status: 'extracting',
      ...(parentStateId === null ? {} : { parentStateId }),
      trigger,
    });
    this.#publish(session, {
      t: 'extraction.started',
      stateId: captureId,
      url,
    });
    this.#publish(session, {
      t: 'extraction.phase',
      stateId: captureId,
      phase: 'navigating',
    });
    return captureId;
  }

  #recordCaptureFailure(
    session: ManagedSession,
    captureId: string,
    url: string,
    trigger: string,
    error: unknown,
  ): void {
    const message = errorMessage(error);
    const provisional = session.stateIndex.get(captureId);
    session.lastError = message;
    session.capturePhases.delete(captureId);
    session.stateIndex.set(captureId, {
      stateId: captureId,
      url,
      title: 'Navigation failed',
      capturedAt: new Date().toISOString(),
      status: 'error',
      ...(provisional?.parentStateId === undefined
        ? {}
        : { parentStateId: provisional.parentStateId }),
      trigger,
    });
    this.#publish(session, { t: 'extraction.error', stateId: captureId, message });
  }

  async #capture(
    session: ManagedSession,
    trigger: string,
    pendingCaptureId: string | null = null,
  ): Promise<boolean> {
    const browser = await this.#browserHandle();
    this.#assertNoContextLeak(browser);
    const documentGeneration = session.documentGeneration;
    let observedThrough = session.journal.sequence;
    const captureUrl = session.page.url();
    const captureIsCurrent = (): boolean => !session.closed
      && session.documentGeneration === documentGeneration
      && session.page.url() === captureUrl;

    const automatic = pendingCaptureId === null && isAutomaticSettleTrigger(trigger);
    let lifecycleAnnounced = !automatic;
    const captureId = pendingCaptureId ?? (automatic
      ? `capture_${randomUUID()}`
      : this.#beginCapture(session, session.page.url(), trigger));
    const captureParentStateId = automatic
      ? session.currentStateId
      : session.stateIndex.get(captureId)?.parentStateId ?? null;

    const emittedPhases = automatic
      ? new Set<ExtractionPhase>()
      : session.capturePhases.get(captureId) ?? new Set<ExtractionPhase>();
    if (!automatic) session.capturePhases.set(captureId, emittedPhases);
    const emitPhase = (phase: ExtractionPhase): void => {
      if (!EXTRACTION_PHASES.includes(phase) || emittedPhases.has(phase)) return;
      emittedPhases.add(phase);
      if (lifecycleAnnounced) {
        this.#publish(session, { t: 'extraction.phase', stateId: captureId, phase });
      }
    };
    const announceDeferredLifecycle = (): void => {
      if (lifecycleAnnounced) return;
      this.#beginCapture(session, session.page.url(), trigger, captureId);
      lifecycleAnnounced = true;
      session.capturePhases.set(captureId, emittedPhases);
      for (const phase of EXTRACTION_PHASES) {
        if (phase !== 'navigating' && emittedPhases.has(phase)) {
          this.#publish(session, { t: 'extraction.phase', stateId: captureId, phase });
        }
      }
    };

    emitPhase('navigating');
    emitPhase('injecting');
    emitPhase('settling');
    emitPhase('walking');

    const observedMethods = [...session.observedMethods].sort();
    session.observedMethods.clear();
    session.captureActive = true;
    session.captureReadStarted = false;
    session.captureDirty = false;
    session.captureDirtyTrigger = 'page settled during extraction';
    session.captureDirtyBypassBackoff = false;
    let succeeded = false;
    let artifactStateId: string | null = null;

    try {
      const earlyGroups: ExtractionGroupPayload[] = [];
      const scanned = await this.#dependencies.scan(session.page, {
        observedMethods,
        onPhase: (phase) => {
          emitPhase(phase);
          if (phase === 'walking') { session.captureReadStarted = true; observedThrough = session.journal.sequence; }
        },
        onGroup: (payload) => {
          earlyGroups.push(payload);
        },
      });
      // A hard document or exact top-level URL can change while the walker is
      // awaiting page JavaScript. Never publish that mixed-generation scan;
      // the navigation/settle lifecycle will drive a fresh capture instead.
      if (!captureIsCurrent()) {
        session.capturePhases.delete(captureId);
        session.stateIndex.delete(captureId);
        return false;
      }
      let artifact = scanned;
      artifactStateId = artifact.stateId;

      for (const phase of EXTRACTION_PHASES.slice(4, -1)) emitPhase(phase);

      const retainedArtifact = session.artifacts.get(artifact.stateId);
      const semanticallyUnchanged = retainedArtifact !== undefined
        && artifactSemanticDigest(retainedArtifact) === artifactSemanticDigest(artifact);
      const stateChanged = captureParentStateId !== artifact.stateId;
      session.journal.commit(captureParentStateId, artifact.stateId, observedThrough, trigger);

      let presentationChanged = false;
      if (semanticallyUnchanged && retainedArtifact !== undefined) {
        const presentation = extractor.mergePresentationGeometry(retainedArtifact, artifact);
        // A digest intentionally ignores local ids and locators. Continue with
        // the retained element graph and import only fresh viewport rects.
        artifact = presentation.artifact;
        if (presentation.changed) {
          await this.#dependencies.writeState(session.outputDirectory, artifact)
            .catch((error: unknown) => {
              this.#dependencies.logger.warn(
                `Could not persist presentation geometry: ${errorMessage(error)}`,
              );
              return undefined;
            });
          if (!captureIsCurrent()) {
            session.capturePhases.delete(captureId);
            session.stateIndex.delete(captureId);
            return false;
          }
          session.artifacts.set(artifact.stateId, artifact);
          presentationChanged = true;
        }
      }

      if (semanticallyUnchanged && automatic && !stateChanged) {
        // Odoo and similar applications can mutate framework bookkeeping on a
        // timer without changing anything a user can act on. Walking is
        // still allowed as a correctness fallback, but the no-op is completely
        // silent and does not replace the durable artifact or invalidate model
        // bindings.
        session.capturePhases.delete(captureId);
        if (presentationChanged) {
          this.#publish(session, { t: 'state.presentation', stateId: artifact.stateId });
        }
        this.#recordAutomaticCaptureOutcome(session, !presentationChanged);
        succeeded = true;
        return true;
      }

      if (automatic) announceDeferredLifecycle();

      if (semanticallyUnchanged && retainedArtifact !== undefined) {
        // Explicit input/navigation gets an immediate lifecycle and therefore
        // needs a terminal event, but it must not rewrite an identical bundle
        // or advance the artifact revision.
        const retainedEntry = session.stateIndex.get(artifact.stateId);
        if (captureId !== artifact.stateId) session.stateIndex.delete(captureId);
        if (retainedEntry !== undefined) retainedEntry.status = 'ready';
        session.currentStateId = artifact.stateId;
        if (automatic && stateChanged) this.#recordAutomaticCaptureOutcome(session, false);
        session.capturePhases.delete(captureId);
        this.#publish(session, {
          t: 'extraction.phase',
          stateId: artifact.stateId,
          phase: 'writing',
        });
        this.#publishExtractionCompleted(session, artifact);
        succeeded = true;
        return true;
      }

      const parentStateId = captureParentStateId;
      const existing = session.artifacts.has(artifact.stateId);
      const existingEntry = session.stateIndex.get(artifact.stateId);
      if (!existing && parentStateId !== null && parentStateId !== artifact.stateId) {
        this.#publish(session, {
          t: 'state.discovered',
          stateId: artifact.stateId,
          url: artifact.url,
          parentStateId,
          trigger,
          label: artifact.title || artifact.url,
        });
      }

      for (const entry of session.stateIndex.values()) {
        if (
          entry.stateId !== artifact.stateId &&
          entry.stateId !== captureId &&
          entry.status !== 'error'
        ) {
          entry.status = 'stale';
        }
      }
      if (captureId !== artifact.stateId) session.stateIndex.delete(captureId);
      const discoveryParentStateId = existingEntry?.parentStateId
        ?? (!existing && parentStateId !== null && parentStateId !== artifact.stateId
          ? parentStateId
          : undefined);
      const discoveryTrigger = existingEntry?.trigger
        ?? (discoveryParentStateId === undefined ? undefined : trigger);
      const nextEntry: SessionStateIndexEntry = {
        stateId: artifact.stateId,
        url: artifact.url,
        title: artifact.title,
        capturedAt: artifact.capturedAt,
        status: 'extracting',
        ...(discoveryParentStateId === undefined
          ? {}
          : {
              parentStateId: discoveryParentStateId,
              ...(discoveryTrigger === undefined ? {} : { trigger: discoveryTrigger }),
            }),
      };
      session.stateIndex.set(artifact.stateId, nextEntry);

      const streamedGroupIds = new Set<string>();
      for (const early of earlyGroups) {
        this.#publish(session, {
          t: 'extraction.group',
          stateId: artifact.stateId,
          group: early.group,
          actions: early.actions,
          observables: early.observables,
        });
        streamedGroupIds.add(early.group.id);
      }

      const actions = new Map(artifact.actions.map((action) => [action.id, action]));
      const observables = new Map(
        artifact.observables.map((observable) => [observable.id, observable]),
      );
      for (const group of artifact.groups) {
        if (streamedGroupIds.has(group.id)) continue;
        this.#publish(session, {
          t: 'extraction.group',
          stateId: artifact.stateId,
          group,
          actions: group.actions.flatMap((id) => {
            const action = actions.get(id);
            return action === undefined ? [] : [action];
          }),
          observables: group.observables.flatMap((id) => {
            const observable = observables.get(id);
            return observable === undefined ? [] : [observable];
          }),
        });
      }
      for (const warning of artifact.warnings) {
        this.#publish(session, {
          t: 'extraction.warning',
          stateId: artifact.stateId,
          warning,
        });
      }

      this.#publish(session, {
        t: 'extraction.phase',
        stateId: artifact.stateId,
        phase: 'writing',
      });
      await this.#dependencies.writeBundle(session.outputDirectory, artifact);
      if (!captureIsCurrent()) {
        session.capturePhases.delete(captureId);
        session.stateIndex.delete(captureId);
        return false;
      }

      session.artifacts.set(artifact.stateId, artifact);
      this.#recordAutomaticCaptureOutcome(session, false);
      session.currentStateId = artifact.stateId;
      nextEntry.status = 'ready';
      session.capturePhases.delete(captureId);
      this.#publishExtractionCompleted(session, artifact);
      succeeded = true;
      return true;
    } catch (error) {
      if (!lifecycleAnnounced) announceDeferredLifecycle();
      const message = errorMessage(error);
      if (artifactStateId !== null && artifactStateId !== captureId) {
        const artifactEntry = session.stateIndex.get(artifactStateId);
        if (artifactEntry?.status === 'extracting') {
          session.stateIndex.delete(artifactStateId);
        }
      }
      session.lastError = message;
      session.capturePhases.delete(captureId);
      session.stateIndex.set(captureId, {
        stateId: captureId,
        url: session.page.url(),
        title: 'Extraction failed',
        capturedAt: new Date().toISOString(),
        status: 'error',
        ...(captureParentStateId === null
          ? {}
          : { parentStateId: captureParentStateId }),
        trigger,
      });
      this.#publish(session, { t: 'extraction.error', stateId: captureId, message });
      throw error;
    } finally {
      const needsFollowUp = succeeded && session.captureDirty && !session.closed;
      const followUpTrigger = session.captureDirtyTrigger;
      const bypassBackoff = session.captureDirtyBypassBackoff;
      session.captureActive = false;
      session.captureReadStarted = false;
      session.captureDirty = false;
      session.captureDirtyBypassBackoff = false;
      if (needsFollowUp) {
        this.#scheduleCapture(
          session,
          followUpTrigger,
          this.#dependencies.captureDebounceMs,
          null,
          { automatic: true, bypassBackoff },
        );
      }
    }
  }

  #recordAutomaticCaptureOutcome(session: ManagedSession, unchanged: boolean): void {
    if (!unchanged) {
      session.automaticNoopStreak = 0;
      session.automaticBackoffUntil = 0;
      return;
    }
    session.automaticNoopStreak = Math.min(8, session.automaticNoopStreak + 1);
    const base = Math.max(
      MIN_AUTOMATIC_SETTLE_BACKOFF_MS,
      this.#dependencies.captureDebounceMs,
    );
    const delay = Math.min(
      MAX_AUTOMATIC_SETTLE_BACKOFF_MS,
      base * (2 ** (session.automaticNoopStreak - 1)),
    );
    session.automaticBackoffUntil = Date.now() + delay;
  }

  #publishExtractionCompleted(session: ManagedSession, artifact: StateArtifact): void {
    this.#publish(session, {
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
  }

  #publish(session: ManagedSession, event: OrchestratorEvent): void {
    if (event.t === 'frame') {
      session.latestFrame = event;
    } else if (event.t !== 'state.presentation') {
      session.eventHistory.push(event);
      const overflow = session.eventHistory.length - this.#dependencies.eventHistoryLimit;
      if (overflow > 0) session.eventHistory.splice(0, overflow);
    }
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#dependencies.logger.warn(`Event listener failed: ${errorMessage(error)}`);
      }
    }
  }

  async #dispatchMouseWithPlaywright(page: Page, command: MouseInputCommand): Promise<void> {
    const button = command.button === undefined || command.button === 'none'
      ? 'left'
      : command.button;
    if (button === 'back' || button === 'forward') {
      throw new InputUnavailableError(`Playwright fallback does not support ${button} clicks.`);
    }
    if (command.type === 'mouseMoved') {
      await page.mouse.move(command.x, command.y);
    } else if (command.type === 'mousePressed') {
      await page.mouse.move(command.x, command.y);
      await page.mouse.down({
        button,
        ...(command.clickCount === undefined ? {} : { clickCount: command.clickCount }),
      });
    } else if (command.type === 'mouseReleased') {
      await page.mouse.move(command.x, command.y);
      await page.mouse.up({
        button,
        ...(command.clickCount === undefined ? {} : { clickCount: command.clickCount }),
      });
    } else {
      await page.mouse.wheel(command.deltaX ?? 0, command.deltaY ?? 0);
    }
  }

  async #dispatchKeyWithPlaywright(page: Page, command: KeyInputCommand): Promise<void> {
    const key = command.key ?? command.code;
    if (command.type === 'char') {
      const text = command.text ?? command.key;
      if (text === undefined) throw new InvalidRequestError('char input requires text or key.');
      await page.keyboard.insertText(text);
    } else if (key === undefined) {
      throw new InvalidRequestError(`${command.type} input requires key or code.`);
    } else if (command.type === 'keyDown') {
      await page.keyboard.down(key);
    } else {
      await page.keyboard.up(key);
    }
  }

  #keyInputMayChangeState(
    type: unknown,
    key: unknown,
    code: unknown,
    text: unknown,
  ): boolean {
    if (type === 'char') return typeof text === 'string' || typeof key === 'string';
    if (type === 'keyUp') return true;
    if (type !== 'keyDown' && type !== 'rawKeyDown') return false;
    return [key, code, text].some(
      (candidate) =>
        typeof candidate === 'string' &&
        (STATE_CHANGING_KEYS.has(candidate) || candidate === '\r' || candidate === '\n'),
    );
  }

  #keyTrigger(key: unknown, code: unknown, text: unknown): string {
    const value = [key, code, text].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
    );
    return value === undefined ? 'keyboard input' : `keyboard ${value}`;
  }

  #scheduleAfterRawInput(
    session: ManagedSession,
    method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent',
    params: Record<string, unknown>,
  ): void {
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') session.observedMethods.clear();
      if (params.type === 'mouseReleased' || params.type === 'mouseWheel') {
        this.#scheduleCapture(
          session,
          String(params.type),
          this.#dependencies.captureDebounceMs,
        );
      }
    } else {
      if (params.type === 'keyDown') session.observedMethods.clear();
      if (
        this.#keyInputMayChangeState(
          params.type,
          params.key,
          params.code,
          params.text,
        )
      ) {
        this.#scheduleCapture(
          session,
          this.#keyTrigger(params.key, params.code, params.text),
          this.#dependencies.captureDebounceMs,
        );
      }
    }
  }
}
