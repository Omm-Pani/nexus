export { ObservationJournal } from './observe/journal.js';
import { createHash } from 'node:crypto';

import type {
  Action,
  DomSnapshot,
  Collection,
  ExtractionPhase,
  Group,
  Locator,
  Observable,
  StateArtifact,
  Warning,
} from '@nexus/schema';
import type { Page } from 'playwright';

import {
  type DriverFrame,
  fromPlaywrightPage,
  isPageDriver,
  type PageDriver,
} from './driver/index.js';

import {
  buildComponentTree,
} from './component-tree/index.js';
import { buildNavigationGraph } from './graph/index.js';
import { fingerprintState, normalizeRoute, stableHash } from './identity/index.js';
import { rawActionElementIdPrefix, StateElementIdAllocator } from './ids.js';
import { BOOTSTRAP_SOURCE } from './instrument/index.js';
import type {
  RawAction,
  RawCollection,
  RawFrameResult,
  RawObservable,
  RawRect,
  RawRegion,
} from './instrument/types.js';

export { writeArtifactBundle, writeStateArtifact } from './artifact/write-artifact.js';
export { BOOTSTRAP_SOURCE, installInstrumentation, nexusBootstrap } from './instrument/index.js';
export type {
  NexusMaterialCause,
  NexusQuiescence,
  NexusSemanticSurface,
  NexusSettledNotification,
} from './instrument/index.js';
export { normalizeRoute } from './identity/index.js';
export { buildNavigationGraph, navigationGraphNodeId } from './graph/index.js';
export {
  buildComponentTree,
  componentPathForRef,
  componentPathIndex,
} from './component-tree/index.js';
export {
  actionElementIdPrefix,
  allocatorForArtifact,
  StateElementIdAllocator,
} from './ids.js';
export {
  mergePresentationGeometry,
  type PresentationGeometryMerge,
} from './presentation/index.js';
export {
  CdpDriver,
  fromPlaywrightPage,
  isPageDriver,
  PlaywrightDriver,
  type CdpDriverOptions,
  type CdpEventHandler,
  type CdpTransport,
  type DriverFrame,
  type PageDriver,
} from './driver/index.js';

export interface ExtractionGroupPayload {
  group: Group;
  actions: Action[];
  observables: Observable[];
}

export interface ScanStateOptions {
  personaId?: string;
  buildId?: string;
  quiescenceTimeoutMs?: number;
  maxNodesPerFrame?: number;
  maxDepth?: number;
  observedMethods?: readonly string[];
  onPhase?: (phase: ExtractionPhase) => void | Promise<void>;
  onGroup?: (payload: ExtractionGroupPayload) => void | Promise<void>;
}

interface FrameResult {
  frame: DriverFrame;
  path: string;
  geometry: FrameGeometry;
  raw: RawFrameResult;
}

interface FrameGeometry {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  clip: RawRect;
}

interface RegionWithFrame {
  framePath: string;
  raw: RawRegion;
}

interface ActionWithFrame {
  framePath: string;
  raw: RawAction;
}

interface ObservableWithFrame {
  framePath: string;
  raw: RawObservable;
}

interface CollectionWithFrame {
  framePath: string;
  raw: RawCollection;
}

function phaseOneStateId(url: string, personaId: string): string {
  return createHash('sha256')
    .update(`phase-1\n${url}\n${personaId}`)
    .digest('hex');
}

function legacyRoute(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

function isRealPlaywrightPage(page: Page): boolean {
  const value = page as unknown as Record<string, unknown>;
  return typeof value.frames === 'function'
    && typeof value.addInitScript === 'function'
    && typeof value.mainFrame === 'function';
}

async function legacyEmptyArtifact(
  page: Page,
  options: ScanStateOptions,
  startedAt: number,
): Promise<StateArtifact> {
  const url = page.url();
  const personaId = options.personaId ?? 'anonymous';
  const title = await page.title().catch(() => '');
  const artifact: StateArtifact = {
    schemaVersion: 1,
    stateId: phaseOneStateId(url, personaId),
    url,
    routeTemplate: legacyRoute(url),
    title,
    personaId,
    buildId: options.buildId ?? 'phase-1',
    capturedAt: new Date().toISOString(),
    timings: { total: Math.max(0, performance.now() - startedAt) },
    groups: [],
    actions: [],
    observables: [],
    collections: [],
    warnings: [],
  };
  artifact.navigationGraph = buildNavigationGraph(artifact);
  artifact.componentTree = buildComponentTree(artifact);
  return artifact;
}

function intersectRect(left: RawRect, right: RawRect): RawRect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.w, right.x + right.w);
  const bottomEdge = Math.min(left.y + left.h, right.y + right.h);
  return {
    x,
    y,
    w: Math.max(0, rightEdge - x),
    h: Math.max(0, bottomEdge - y),
  };
}

function composeRect(rect: RawRect, geometry: FrameGeometry): RawRect {
  return {
    x: geometry.offsetX + rect.x * geometry.scaleX,
    y: geometry.offsetY + rect.y * geometry.scaleY,
    w: rect.w * geometry.scaleX,
    h: rect.h * geometry.scaleY,
  };
}

function intersects(rect: RawRect, clip: RawRect): boolean {
  return rect.w > 0
    && rect.h > 0
    && clip.w > 0
    && clip.h > 0
    && rect.x + rect.w > clip.x
    && rect.y + rect.h > clip.y
    && rect.x < clip.x + clip.w
    && rect.y < clip.y + clip.h;
}

/**
 * Return the affine viewport mapping for a frame.  Each iframe's
 * getBoundingClientRect() is relative to its parent viewport, while extracted
 * element rectangles are relative to the child viewport.  Accumulating the
 * content-box origin (including the iframe border) composes both same- and
 * cross-origin descendants into main-frame screencast coordinates.
 */
async function geometryForFrame(
  driver: PageDriver,
  frame: DriverFrame,
  byId: Map<string, DriverFrame>,
  cache: Map<string, Promise<FrameGeometry>>,
): Promise<FrameGeometry> {
  const cached = cache.get(frame.id);
  if (cached !== undefined) return cached;

  const pending = (async (): Promise<FrameGeometry> => {
    const viewport = await driver.evaluate<{ width: number; height: number }>(
      frame,
      '() => ({ width: window.innerWidth, height: window.innerHeight })',
    );
    if (frame.parentId === null) {
      return {
        offsetX: 0,
        offsetY: 0,
        scaleX: 1,
        scaleY: 1,
        clip: { x: 0, y: 0, w: viewport.width, h: viewport.height },
      };
    }

    const parent = byId.get(frame.parentId);
    if (parent === undefined) {
      throw new Error('Attached child frame has no parent frame.');
    }
    const parentGeometry = await geometryForFrame(driver, parent, byId, cache);
    const placement = await driver.frameOwner(frame);
    const localScaleX = viewport.width > 0 ? placement.width / viewport.width : 1;
    const localScaleY = viewport.height > 0 ? placement.height / viewport.height : 1;
    const scaleX = parentGeometry.scaleX * localScaleX;
    const scaleY = parentGeometry.scaleY * localScaleY;
    const offsetX = parentGeometry.offsetX + placement.x * parentGeometry.scaleX;
    const offsetY = parentGeometry.offsetY + placement.y * parentGeometry.scaleY;
    const ownViewport = {
      x: offsetX,
      y: offsetY,
      w: viewport.width * scaleX,
      h: viewport.height * scaleY,
    };
    return {
      offsetX,
      offsetY,
      scaleX,
      scaleY,
      clip: intersectRect(parentGeometry.clip, ownViewport),
    };
  })();
  cache.set(frame.id, pending);
  return pending;
}

async function readFrame(
  driver: PageDriver,
  frame: DriverFrame,
  framePath: string,
  maxNodes: number,
  maxDepth: number,
): Promise<RawFrameResult> {
  return driver.evaluate<RawFrameResult>(
    frame,
    `(options) => {
      const runtime = window.__nexus;
      if (runtime === undefined) throw new Error('Nexus instrumentation is unavailable.');
      return runtime.extract(options);
    }`,
    { framePath, maxNodes, maxDepth },
  );
}

function warning(
  code: Warning['code'],
  detail: string,
  ref?: string,
): Warning {
  return ref === undefined ? { code, detail } : { code, detail, ref };
}

function locatorRecipes(raw: RawAction, framePath: string): Locator[] {
  const common = { frame: framePath, shadowPath: [...raw.shadowPath] };
  const locators: Locator[] = [];
  if (raw.locator.testId !== null) {
    locators.push({ kind: 'testid', value: raw.locator.testId, ...common });
  }
  if (raw.role !== '' && raw.label !== '') {
    locators.push({
      kind: 'role_name',
      value: raw.label,
      role: raw.role,
      name: raw.label,
      ...common,
    });
  }
  if (raw.locator.associatedLabel !== null) {
    locators.push({ kind: 'label', value: raw.locator.associatedLabel, ...common });
  }
  if (raw.locator.placeholder !== null) {
    locators.push({ kind: 'placeholder', value: raw.locator.placeholder, ...common });
  }
  if (raw.label !== '' && raw.visible) {
    locators.push({ kind: 'text', value: raw.label, ...common });
  }
  locators.push({ kind: 'structural', value: raw.locator.structural, ...common });
  const seen = new Set<string>();
  return locators.filter((locator) => {
    const key = `${locator.kind}|${locator.value}|${locator.role ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableActionId(raw: RawAction, framePath: string): string {
  if (
    raw.collectionKey !== null
    && raw.collectionMemberKey !== null
    && raw.relPath !== null
  ) {
    return stableHash(
      'collection-action-v1',
      framePath,
      raw.collectionKey,
      raw.collectionMemberKey,
      raw.relPath,
      raw.role,
      raw.type,
      raw.label,
    );
  }
  return stableHash(
    'action-v1',
    framePath,
    raw.shadowPath.join('>'),
    raw.locator.testId ?? raw.locator.structural,
    raw.role,
    raw.type,
    raw.label,
  );
}

function stableObservableId(raw: RawObservable, framePath: string): string {
  if (
    raw.collectionKey !== null
    && raw.collectionMemberKey !== null
    && raw.relPath !== null
  ) {
    return stableHash(
      'collection-observable-v1',
      framePath,
      raw.collectionKey,
      raw.collectionMemberKey,
      raw.relPath,
      raw.kind,
      raw.label,
    );
  }
  return stableHash(
    'observable-v1',
    framePath,
    raw.nodeKey,
    raw.kind,
    raw.label,
  );
}

function addOptionalActionState(raw: RawAction): Action['state'] {
  const state: Action['state'] = { disabled: raw.state.disabled };
  if (raw.state.expanded !== null) state.expanded = raw.state.expanded;
  if (raw.state.checked !== null) state.checked = raw.state.checked;
  if (raw.state.selected !== null) state.selected = raw.state.selected;
  if (raw.state.pressed !== null) state.pressed = raw.state.pressed;
  if (raw.state.readonly !== null) state.readonly = raw.state.readonly;
  if (raw.state.required !== null) state.required = raw.state.required;
  return state;
}

function templateLabel(
  label: string,
  anchor: string | null,
  emptyFallback = label,
): string {
  let value = label;
  if (anchor !== null && anchor !== '' && value.includes(anchor)) {
    value = value.replace(anchor, '').replace(/\s+/gu, ' ').trim();
  }
  value = value.replace(/\s+\d+$/u, '').trim();
  if (/^Add$/iu.test(value)) return 'Add product';
  return value || emptyFallback;
}

function collectionItemName(label: string): string {
  if (/\b(?:inventory|product|catalog)\b/iu.test(label)) return 'product';
  if (/\bapps?\b/iu.test(label)) return 'app';
  if (/\bcustomers?\b/iu.test(label)) return 'customer';
  if (/\borders?\b/iu.test(label)) return 'order';
  return 'item';
}

function elapsed(start: number): number {
  return Math.round(Math.max(0, performance.now() - start) * 100) / 100;
}

/**
 * Extract a deterministic state inventory from all currently attached frames.
 * Call installInstrumentation(page) before the first navigation to retain
 * listeners and closed roots created by application startup code.
 */
export async function scanState(
  target: Page | PageDriver,
  options: ScanStateOptions = {},
): Promise<StateArtifact> {
  const startedAt = performance.now();
  // Test doubles and Phase 1 callers pass an object that is neither. They get
  // the documented empty artifact rather than an exception.
  if (!isPageDriver(target) && !isRealPlaywrightPage(target as Page)) {
    return legacyEmptyArtifact(target as Page, options, startedAt);
  }
  const driver: PageDriver = isPageDriver(target)
    ? target
    : fromPlaywrightPage(target as Page);

  const timings: Record<string, number> = {};
  const warnings: Warning[] = [];
  const emitPhase = async (phase: ExtractionPhase): Promise<void> => {
    await options.onPhase?.(phase);
  };

  await emitPhase('injecting');
  const instrumentStarted = performance.now();
  await driver.addInitScript(BOOTSTRAP_SOURCE);
  timings.instrumenting = elapsed(instrumentStarted);

  const frameEntries = (await driver.frames()).map((frame) => ({
    frame,
    path: frame.path,
  }));
  await driver.prepareDom?.().catch((error: unknown) => {
    warnings.push(warning('shadow_root_unreachable', `Closed-root recovery failed: ${String(error)}`));
  });
  const framesById = new Map(frameEntries.map(({ frame }) => [frame.id, frame]));

  // Compare the iframes each document declares against the frames the driver
  // could actually reach. A frame that is simply absent from the driver's tree
  // produces no per-frame error, so without this check an out-of-process iframe
  // would be reported as an empty region of the page rather than as an
  // unreachable one — coverage that looks complete but is not.
  await Promise.all(frameEntries.map(async ({ frame, path }) => {
    const declared = await driver
      .evaluate<number>(frame, `() => document.querySelectorAll('iframe, frame').length`)
      .catch(() => 0);
    const reached = frameEntries.filter(
      (entry) => entry.frame.parentId === frame.id,
    ).length;
    if (declared > reached) {
      warnings.push(warning(
        'frame_inaccessible',
        `${declared - reached} of ${declared} embedded frames could not be reached `
        + `(likely cross-origin). Their contents are absent from this inventory.`,
        path,
      ));
    }
  }));

  await emitPhase('settling');
  const settleStarted = performance.now();
  const timeout = options.quiescenceTimeoutMs ?? 8_000;
  await Promise.all(frameEntries.map(async ({ frame, path }) => {
    try {
      const settled = await driver.evaluate<boolean>(
        frame,
        `(timeoutMs) => {
          const runtime = window.__nexus;
          return runtime === undefined ? false : runtime.waitForQuiescence(timeoutMs);
        }`,
        timeout,
      );
      if (!settled) {
        warnings.push(warning(
          'quiescence_timeout',
          `Frame did not become quiescent within ${timeout}ms.`,
          path,
        ));
      }
    } catch (error) {
      warnings.push(warning(
        'frame_inaccessible',
        `Could not observe frame quiescence: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ));
    }
  }));
  timings.settling = elapsed(settleStarted);

  await emitPhase('walking');
  const walkStarted = performance.now();
  const frameResults: FrameResult[] = [];
  const dom: DomSnapshot[] = [];
  const geometryCache = new Map<string, Promise<FrameGeometry>>();
  for (const { frame, path } of frameEntries) {
    try {
      const raw = await readFrame(
        driver,
        frame,
        path,
        options.maxNodesPerFrame ?? 20_000,
        options.maxDepth ?? 100,
      );
      // Read the placement after quiescence and alongside the DOM walk so the
      // arena overlay cannot use a pre-settle iframe position.
      const geometry = await geometryForFrame(driver, frame, framesById, geometryCache);
      frameResults.push({ frame, path, geometry, raw });
      const snapshot = await driver.evaluate<DomSnapshot>(frame, '(path) => window.__nexusDom.snapshot(path)', path);
      for (const element of snapshot.elements) element.rect = composeRect(element.rect, geometry);
      dom.push(snapshot);
      for (const rawWarning of raw.warnings) {
        warnings.push(rawWarning.ref === null
          ? warning(rawWarning.code, rawWarning.detail)
          : warning(rawWarning.code, rawWarning.detail, rawWarning.ref));
      }
    } catch (error) {
      warnings.push(warning(
        'frame_inaccessible',
        `Could not extract frame: ${error instanceof Error ? error.message : String(error)}`,
        path,
      ));
    }
  }
  timings.walking = elapsed(walkStarted);

  await emitPhase('classifying');
  const classifyStarted = performance.now();
  const regions: RegionWithFrame[] = frameResults.flatMap(({ path, raw }) =>
    raw.regions.map((region) => ({ framePath: path, raw: region })),
  ).sort((left, right) =>
    left.framePath.localeCompare(right.framePath) || left.raw.order - right.raw.order,
  );
  const allRawActions: ActionWithFrame[] = frameResults.flatMap(({ path, raw }) =>
    raw.actions.map((action) => ({ framePath: path, raw: action })),
  ).sort((left, right) =>
    left.framePath.localeCompare(right.framePath) || left.raw.order - right.raw.order,
  );
  // A delegated listener belongs to a framework root, not to every visual
  // control below it. Retain a listener-only element when it is the actual
  // target, but collapse an ID-addressable ancestor that contains independently
  // evidenced descendants.
  const rawActions: ActionWithFrame[] = allRawActions.filter((entry) => {
    const { raw } = entry;
    const isListenerOnlyContainer = raw.evidence.includes('listener_registry')
      && !raw.evidence.some((signal) =>
        ['native_tag', 'ax_role', 'aria_role', 'react_props', 'contenteditable', 'inline_handler'].includes(signal),
      );
    if (!isListenerOnlyContainer || !raw.locator.structural.startsWith('#')) return true;
    const id = raw.locator.structural.slice(1);
    return !allRawActions.some((candidate) =>
      candidate !== entry
      && candidate.framePath === entry.framePath
      && candidate.raw.ancestorIds.includes(id)
      && candidate.raw.evidence.some((signal) =>
        ['native_tag', 'ax_role', 'aria_role', 'react_props', 'contenteditable', 'inline_handler'].includes(signal),
      ),
    );
  });
  const rawObservables: ObservableWithFrame[] = frameResults.flatMap(({ path, raw }) =>
    raw.observables.map((observable) => ({ framePath: path, raw: observable })),
  ).sort((left, right) =>
    left.framePath.localeCompare(right.framePath) || left.raw.order - right.raw.order,
  );
  const rawCollections: CollectionWithFrame[] = frameResults.flatMap(({ path, raw }) =>
    raw.collections.map((collection) => ({ framePath: path, raw: collection })),
  ).sort((left, right) =>
    left.framePath.localeCompare(right.framePath) || left.raw.order - right.raw.order,
  );
  const geometryByFramePath = new Map(
    frameResults.map(({ path, geometry }) => [path, geometry] as const),
  );
  const geometryForPath = (framePath: string): FrameGeometry => {
    const geometry = geometryByFramePath.get(framePath);
    if (geometry === undefined) {
      throw new Error(`Missing viewport geometry for ${framePath}.`);
    }
    return geometry;
  };
  timings.classifying = elapsed(classifyStarted);

  await emitPhase('grouping');
  const groupingStarted = performance.now();
  const groupByRegionKey = new Map<string, Group>();
  const groupRegionSource = new Map<string, RegionWithFrame>();
  const groups: Group[] = regions.map((entry, index) => {
    const group: Group = {
      id: `g${index + 1}`,
      label: entry.raw.label,
      kind: entry.raw.kind,
      global: entry.raw.global,
      conditional: entry.raw.conditional,
      actions: [],
      observables: [],
      frame: entry.framePath,
      shadowPath: [...entry.raw.shadowPath],
    };
    groupByRegionKey.set(entry.raw.key, group);
    groupRegionSource.set(group.id, entry);
    return group;
  });
  for (const entry of regions) {
    const group = groupByRegionKey.get(entry.raw.key);
    const parent = entry.raw.parentKey === null
      ? undefined
      : groupByRegionKey.get(entry.raw.parentKey);
    if (group !== undefined && parent !== undefined && parent.id !== group.id) {
      group.parentGroup = parent.id;
    }
  }

  const fallbackGroup = groups[0];
  const elementIds = new StateElementIdAllocator();
  const actions: Action[] = rawActions.map(({ framePath, raw }) => {
    const geometry = geometryForPath(framePath);
    const rect = composeRect(raw.rect, geometry);
    const observedMethods = new Set(
      (options.observedMethods ?? []).map((method) => method.toUpperCase()),
    );
    let risk = raw.risk;
    if (risk === 'unknown' && raw.kind === 'submit') {
      if (observedMethods.has('DELETE')) risk = 'destructive';
      else if ([...observedMethods].some((method) => ['POST', 'PUT', 'PATCH'].includes(method))) {
        risk = 'mutating';
      }
    }
    const action: Action = {
      id: elementIds.next(rawActionElementIdPrefix(raw)),
      stableId: stableActionId(raw, framePath),
      label: raw.label.slice(0, 180),
      type: raw.type,
      kind: raw.kind,
      risk,
      confidence: raw.confidence,
      evidence: [...raw.evidence],
      state: addOptionalActionState(raw),
      visible: raw.visible,
      inViewport: raw.visible && intersects(rect, geometry.clip),
      hitTestable: raw.hitTestable,
      occludedBy: raw.occludedBy,
      region: groupByRegionKey.get(raw.regionKey)?.id ?? fallbackGroup?.id ?? 'g0',
      frame: framePath,
      shadowPath: [...raw.shadowPath],
      rect,
      locators: locatorRecipes(raw, framePath),
    };
    if (raw.value !== null) action.value = raw.value;
    if (raw.placeholder !== null) action.placeholder = raw.placeholder;
    if (raw.observedDestination !== null) action.observedDestination = raw.observedDestination;
    return action;
  });

  const actionByNodeKey = new Map<string, Action>();
  rawActions.forEach(({ raw }, index) => {
    const action = actions[index];
    if (action !== undefined) actionByNodeKey.set(raw.nodeKey, action);
  });
  actions.forEach((action, index) => {
    const source = rawActions[index];
    if (source === undefined) return;
    let region = regions.find(({ raw }) => raw.key === source.raw.regionKey)?.raw;
    while (region !== undefined) {
      if (region.controlledBy !== null) {
        const controller = actionByNodeKey.get(region.controlledBy);
        if (controller !== undefined && controller.id !== action.id) action.parentAction = controller.id;
        break;
      }
      const parentKey = region.parentKey;
      region = parentKey === null
        ? undefined
        : regions.find(({ raw }) => raw.key === parentKey)?.raw;
    }
  });

  // A <select> option's owner is known exactly, so it supersedes any
  // aria-controls linkage inferred from the surrounding region.
  actions.forEach((action, index) => {
    const source = rawActions[index];
    if (source === undefined || source.raw.optionOfKey === null) return;
    const owner = actionByNodeKey.get(source.raw.optionOfKey);
    if (owner !== undefined && owner.id !== action.id) action.parentAction = owner.id;
  });

  const observables: Observable[] = rawObservables.map(({ framePath, raw }) => {
    const geometry = geometryForPath(framePath);
    return {
      id: elementIds.next('obs'),
      stableId: stableObservableId(raw, framePath),
      kind: raw.kind,
      label: raw.label.slice(0, 180),
      valueType: raw.valueType,
      currentValue: raw.currentValue.slice(0, 1000),
      region: groupByRegionKey.get(raw.regionKey)?.id ?? fallbackGroup?.id ?? 'g0',
      ...(raw.anchor === null ? {} : { anchor: raw.anchor }),
      frame: framePath,
      shadowPath: [...raw.shadowPath],
      rect: composeRect(raw.rect, geometry),
      changedBy: [],
    };
  });
  const observableByNodeKey = new Map<string, Observable>();
  rawObservables.forEach(({ raw }, index) => {
    const observable = observables[index];
    if (observable !== undefined) observableByNodeKey.set(raw.nodeKey, observable);
  });

  actions.forEach((action, index) => {
    const source = rawActions[index];
    if (source !== undefined) groupByRegionKey.get(source.raw.regionKey)?.actions.push(action.id);
  });
  observables.forEach((observable, index) => {
    const source = rawObservables[index];
    if (source !== undefined) groupByRegionKey.get(source.raw.regionKey)?.observables.push(observable.id);
  });

  const collections: Collection[] = rawCollections.map(({ framePath, raw }) => {
    const memberActions = rawActions
      .map((entry, actionIndex) => ({ entry, action: actions[actionIndex] as Action }))
      .filter(({ entry }) => entry.raw.collectionKey === raw.key);
    const memberObservables = rawObservables
      .map((entry, observableIndex) => ({ entry, observable: observables[observableIndex] as Observable }))
      .filter(({ entry }) => entry.raw.collectionKey === raw.key);
    const actionTemplates = new Map<string, Collection['itemActions'][number]>();
    for (const { entry, action } of memberActions) {
      const fallback = action.kind === 'navigate' || action.kind === 'open'
        ? `Open ${collectionItemName(raw.label)}`
        : 'Item action';
      const label = templateLabel(action.label, entry.raw.anchor, fallback);
      const key = `${label}|${action.kind}|${action.risk}|${entry.raw.relPath ?? ''}`;
      actionTemplates.set(key, {
        label,
        kind: action.kind,
        risk: action.risk,
        relPath: entry.raw.relPath ?? ':scope',
      });
    }
    const observableTemplates = new Map<string, Collection['itemObservables'][number]>();
    for (const { entry, observable } of memberObservables) {
      const label = templateLabel(observable.label, entry.raw.anchor);
      const key = `${label}|${observable.valueType}|${entry.raw.relPath ?? ''}`;
      observableTemplates.set(key, {
        label,
        valueType: observable.valueType,
        relPath: entry.raw.relPath ?? ':scope',
      });
    }
    const collection: Collection = {
      id: elementIds.next('col'),
      label: raw.label,
      templateId: stableHash('collection-v1', framePath, raw.key, raw.anchorRelPath),
      anchorField: {
        relPath: raw.anchorRelPath,
        entropy: raw.anchorEntropy,
        stability: raw.anchorStability,
        type: raw.anchorType,
      },
      instancesObserved: raw.instancesObserved,
      instancesDeclared: raw.instancesDeclared,
      traversal: raw.traversal,
      itemActions: [...actionTemplates.values()],
      itemObservables: [...observableTemplates.values()],
      anchors: [...raw.anchors],
      rows: (raw.rows ?? []).map((row) => {
        const anchorAction = row.anchorActionNodeKey === null
          ? undefined
          : actionByNodeKey.get(row.anchorActionNodeKey);
        const cells = row.cells.flatMap((cell) => {
          const action = cell.actionNodeKey === null
            ? undefined
            : actionByNodeKey.get(cell.actionNodeKey);
          const observable = cell.observableNodeKey === null
            ? undefined
            : observableByNodeKey.get(cell.observableNodeKey);
          // A classifier filter may remove a listener-only false positive
          // after the in-page walk. Do not publish a dangling concrete cell.
          if (cell.type === 'action' && action === undefined) return [];
          if (cell.type === 'observable' && observable === undefined) return [];
          return [{
            column: cell.column,
            type: cell.type,
            value: cell.value,
            rect: composeRect(cell.rect, geometryForPath(framePath)),
            ...(action === undefined ? {} : { actionId: action.id }),
            ...(observable === undefined ? {} : { observableId: observable.id }),
          }];
        });
        return {
          rowKey: row.rowKey,
          anchor: row.anchor,
          rect: composeRect(row.rect, geometryForPath(framePath)),
          ...(anchorAction === undefined ? {} : { anchorActionId: anchorAction.id }),
          cells,
        };
      }),
      frame: framePath,
      shadowPath: [...raw.shadowPath],
    };
    if (raw.scrollContainer !== null) collection.scrollContainer = raw.scrollContainer;

    const collectionGroup: Group = {
      id: `g${groups.length + 1}`,
      label: raw.label,
      kind: 'collection',
      global: false,
      conditional: false,
      actions: [...new Set(memberActions.map(({ action }) => action.id))],
      observables: [...new Set(memberObservables.map(({ observable }) => observable.id))],
      frame: framePath,
      shadowPath: [...raw.shadowPath],
    };
    const parentRegionId = groupByRegionKey.get(raw.parentRegionKey)?.id
      ?? memberActions[0]?.action.region
      ?? memberObservables[0]?.observable.region;
    if (parentRegionId !== undefined) collectionGroup.parentGroup = parentRegionId;
    groups.push(collectionGroup);
    collection.groupId = collectionGroup.id;
    return collection;
  });

  const collectionByRawKey = new Map(
    rawCollections.map(({ raw }, index) => [raw.key, collections[index] as Collection]),
  );
  actions.forEach((action, index) => {
    const raw = rawActions[index]?.raw;
    if (
      raw?.collectionKey === null
      || raw?.collectionKey === undefined
      || raw.collectionMemberKey === null
      || raw.anchor === null
    ) return;
    const collection = collectionByRawKey.get(raw.collectionKey);
    if (collection === undefined) return;
    action.collection = {
      id: collection.id,
      itemKey: raw.collectionMemberKey,
      anchor: raw.anchor,
    };
  });
  observables.forEach((observable, index) => {
    const raw = rawObservables[index]?.raw;
    if (
      raw?.collectionKey === null
      || raw?.collectionKey === undefined
      || raw.collectionMemberKey === null
      || raw.anchor === null
    ) return;
    const collection = collectionByRawKey.get(raw.collectionKey);
    if (collection === undefined) return;
    observable.collection = {
      id: collection.id,
      itemKey: raw.collectionMemberKey,
      anchor: raw.anchor,
    };
  });

  for (const group of groups) {
    const source = groupRegionSource.get(group.id);
    if (source?.raw.controlledBy !== null && source?.raw.controlledBy !== undefined) {
      const controller = actionByNodeKey.get(source.raw.controlledBy);
      if (controller !== undefined) group.parentAction = controller.id;
    }
  }
  timings.grouping = elapsed(groupingStarted);

  await emitPhase('observing');
  const observingStarted = performance.now();
  // Interaction and mutation deltas are streamed separately by the observer.
  timings.observing = elapsed(observingStarted);

  const url = driver.url();
  const title = (await driver.title()) || frameResults[0]?.raw.title || '';
  const personaId = options.personaId ?? 'anonymous';
  const routeTemplate = normalizeRoute(url);
  const overlayStack = regions
    .filter(({ raw }) => (raw.kind === 'dialog' || raw.kind === 'menu') && !raw.conditional)
    .map(({ raw }) => `${raw.kind}:${raw.label}`);
  // Meaningful same-URL views are distinguished by active landmark and form
  // names, not by every transient control. A Login -> Checkout wizard changes
  // state, while an isolated error button or counter remains a state revision.
  const viewContext = regions
    .filter(({ raw }) =>
      !raw.conditional
      && ['main', 'form', 'dialog', 'menu', 'tabset'].includes(raw.kind)
      && raw.label.trim() !== '',
    )
    .map(({ raw }) => `${raw.kind}:${raw.label}`);
  const primaryRegionShape = frameResults
    .map(({ path, raw }) => `${path}:${raw.documentShape}`)
    .join('\n');
  const semanticStateId = fingerprintState({
    routeTemplate,
    overlayStack,
    primaryRegionShape,
    actionVocabulary: actions.map(({ label }) => label),
    viewContext,
    personaId,
  });

  // Every DOM value/attribute/structure participates; document-local IDs and
  // viewport rectangles do not turn identical captures into new states.
  const stateId = stableHash(semanticStateId, JSON.stringify(dom.map((snapshot) => ({
    frame: snapshot.frame, url: snapshot.url,
    elements: snapshot.elements.map(({ id, documentId, parentId, rect, ...element }) => element),
  }))));
  const artifact: StateArtifact = {
    schemaVersion: 1,
    dom,
    stateId,
    url,
    routeTemplate,
    title,
    personaId,
    buildId: options.buildId ?? 'dom-v1',
    capturedAt: new Date().toISOString(),
    timings,
    groups,
    actions,
    observables,
    collections,
    warnings,
  };
  artifact.navigationGraph = buildNavigationGraph(artifact);
  artifact.componentTree = buildComponentTree(artifact);

  if (options.onGroup !== undefined) {
    for (const group of groups) {
      await options.onGroup({
        group,
        actions: actions.filter(({ id }) => group.actions.includes(id)),
        observables: observables.filter(({ id }) => group.observables.includes(id)),
      });
    }
  }
  timings.total = elapsed(startedAt);
  return artifact;
}
