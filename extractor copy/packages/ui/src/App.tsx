import { ActivityPanel } from './activity-panel.js';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  collectionCellSourceKey,
  resolveHoverTarget,
  targetForAction,
  targetForObservable,
  type HoverTarget,
} from './hover-target.js';
import {
  exactPageKey,
  groupStatesByExactUrl,
  pageContainsCurrentState,
  type ExactUrlPage,
} from './page-history.js';
import { buildActionForest, semanticRootGroups, type ActionTreeNode } from './semantic-tree.js';
import {
  projectComponentTree,
  type ComponentTreeProjection,
} from './component-tree.js';
import {
  collectionCellColumn,
  collectionColumns,
  compactCollectionTable,
  normalizedCollectionText,
  visibleCollectionCells,
  type PresentedCollectionCell,
  type PresentedCollectionRow,
} from './collection-table.js';
import { createTransport, type HighlightBox } from './transport.js';
import type {
  Action,
  DomSnapshot,
  Collection,
  ComponentTree,
  ComponentTreeNode,
  ComponentTreeRelation,
  ElementType,
  ExtractionCounts,
  ExtractionPhase,
  Group,
  Observable,
  OrchestratorEvent,
  Reveal,
  StateArtifact,
  Warning,
} from '@nexus/schema';

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
// Resolved once: the desktop build injects its bridge before the bundle runs.
const transport = createTransport(API_BASE);
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

type ExtractionStatus = 'extracting' | 'ready' | 'stale' | 'error';
type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

interface StateRecord {
  stateId: string;
  url: string;
  routeTemplate: string;
  title: string;
  label: string;
  status: ExtractionStatus;
  phase: ExtractionPhase | null;
  parentStateId: string | null;
  trigger: string | null;
  groups: Group[];
  actions: Action[];
  observables: Observable[];
  collections: Collection[];
  componentTree: ComponentTree | null;
  dom: DomSnapshot[];
  warnings: Warning[];
  timings: Record<string, number>;
  counts: ExtractionCounts | null;
  errorMessage: string | null;
}

interface CaptureProgress {
  stateId: string;
  url: string;
  phase: ExtractionPhase;
  errorMessage: string | null;
}

interface ArenaGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
}

type PresentedCollection = Collection & {
  groupId?: string;
  rows?: PresentedCollectionRow[];
};

interface CollectionBinding {
  collection: PresentedCollection;
  group: Group | null;
  parentGroupId: string | null;
  actions: Action[];
  observables: Observable[];
}

type InputPayload =
  | { kind: 'mouse'; type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }
  | { kind: 'mouse'; type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; key?: string; code?: string; text?: string; modifiers?: number };

type WireEvent =
  | Exclude<OrchestratorEvent, { t: 'frame' }>
  | (Extract<OrchestratorEvent, { t: 'frame' }> & {
      width?: number;
      height?: number;
      url?: string;
    });

const TYPE_LABELS: ElementType[] = ['navigation', 'button', 'input', 'text', 'container', 'toggle', 'observable'];
// Mirrors the --navigation/--button/... custom properties in styles.css. The
// page overlay is drawn inside the target document, which cannot see them.
const TYPE_TONES: Record<ElementType, string> = {
  navigation: '#2563eb',
  button: '#d97706',
  input: '#16a34a',
  text: '#6b7280',
  container: '#7c3aed',
  toggle: '#dc2626',
  observable: '#0891b2',
};
const PHASES: ExtractionPhase[] = ['navigating', 'injecting', 'settling', 'walking', 'classifying', 'grouping', 'observing', 'writing'];

function apiUrl(path: string): string { return `${API_BASE}${path}`; }

function streamUrl(sessionId: string): string {
  const target = new URL(apiUrl(`/session/${encodeURIComponent(sessionId)}/stream`), window.location.href);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  return target.href;
}

async function parseResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) return null;
  try { return JSON.parse(body) as unknown; } catch { return body; }
}

function nestedMessage(payload: unknown, seen = new Set<unknown>()): string | null {
  if (typeof payload === 'string') return payload.trim().length > 0 ? payload.trim() : null;
  if (typeof payload !== 'object' || payload === null || seen.has(payload)) return null;
  seen.add(payload);
  const value = payload as Record<string, unknown>;
  for (const key of ['message', 'detail', 'error', 'cause', 'reason']) {
    const resolved = nestedMessage(value[key], seen);
    if (resolved !== null) return resolved;
  }
  for (const nested of Object.values(value)) {
    const resolved = nestedMessage(nested, seen);
    if (resolved !== null) return resolved;
  }
  return null;
}

function responseMessage(payload: unknown, fallback: string): string {
  return nestedMessage(payload) ?? fallback;
}

function isStateArtifact(value: unknown): value is StateArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<StateArtifact>;
  return typeof item.stateId === 'string' && typeof item.url === 'string' && Array.isArray(item.groups) && Array.isArray(item.actions) && Array.isArray(item.observables) && Array.isArray(item.collections);
}

/**
 * The key that decides which page a state belongs under.
 *
 * States are distinct *within* a page: opening a menu or failing validation
 * changes the fingerprint but not the address. Grouping on the address keeps
 * those together instead of spawning a sibling tab for each variation.
 */
/**
 * A short name for one state within a page. The raw trigger ("mouseReleased")
 * is diagnostic detail, not something to title a state with.
 */
function stateLabel(state: StateRecord, index: number): string {
  const hasKind = (kind: Group['kind']) => state.groups.some((group) => group.kind === kind && !group.conditional);
  if (state.status === 'error') return 'Extraction failed';
  if (state.observables.some((observable) => observable.kind === 'validation' && observable.currentValue !== '')) {
    return 'Validation error';
  }
  if (hasKind('dialog')) return 'Dialog open';
  if (hasKind('menu')) return 'Menu open';
  if (index === 0) return 'Initial';
  if (state.trigger !== null && !/^(?:mouse|key|wheel)/iu.test(state.trigger)) return state.trigger;
  return `State ${index + 1}`;
}

type PageGroup = ExactUrlPage<StateRecord>;

function labelForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.hostname}${path}` || url;
  } catch { return url || 'Untitled page'; }
}

function emptyStateRecord(stateId: string, url: string, status: ExtractionStatus = 'extracting'): StateRecord {
  return { stateId, url, routeTemplate: exactPageKey(url), title: '', label: labelForUrl(url), status, phase: null, parentStateId: null, trigger: null, groups: [], actions: [], observables: [], collections: [], componentTree: null, dom: [], warnings: [], timings: {}, counts: null, errorMessage: null };
}

function recordFromArtifact(artifact: StateArtifact): StateRecord {
  return {
    stateId: artifact.stateId,
    url: artifact.url,
    routeTemplate: artifact.routeTemplate || exactPageKey(artifact.url),
    title: artifact.title,
    label: artifact.title || labelForUrl(artifact.url),
    status: 'ready',
    phase: null,
    parentStateId: null,
    trigger: null,
    groups: artifact.groups,
    actions: artifact.actions,
    observables: artifact.observables,
    collections: artifact.collections,
    componentTree: artifact.componentTree ?? null,
    dom: artifact.dom ?? [],
    warnings: mergeWarnings([], artifact.warnings),
    timings: artifact.timings,
    counts: { groups: artifact.groups.length, actions: artifact.actions.length, observables: artifact.observables.length, collections: artifact.collections.length, warnings: artifact.warnings.length },
    errorMessage: null,
  };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function warningKey(warning: Warning): string {
  return `${warning.code}\u0000${warning.detail}\u0000${warning.ref ?? ''}`;
}

function mergeWarnings(current: Warning[], incoming: Warning[]): Warning[] {
  const merged = new Map(current.map((warning) => [warningKey(warning), warning]));
  for (const warning of incoming) merged.set(warningKey(warning), warning);
  return [...merged.values()];
}

interface StateDelta {
  actionIds: Set<string>;
  observableIds: Set<string>;
  collections: Collection[];
  removedCollections: Collection[];
  removedActionLabels: string[];
  removedObservableLabels: string[];
  changedActions: number;
  newActions: number;
  removedActions: number;
  changedObservables: number;
  newObservables: number;
  removedObservables: number;
  inherited: number;
}

interface StateSemanticReferences {
  actionStableIdByLocalId: Map<string, string>;
  groupPathByLocalId: Map<string, string>;
}

function stateSemanticReferences(actions: Action[], groups: Group[]): StateSemanticReferences {
  const actionStableIdByLocalId = new Map(actions.map((action) => [action.id, action.stableId]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const groupPathByLocalId = new Map<string, string>();
  const resolving = new Set<string>();
  const resolveGroupPath = (groupId: string): string => {
    const retained = groupPathByLocalId.get(groupId);
    if (retained !== undefined) return retained;
    const group = groupById.get(groupId);
    if (group === undefined) return '';
    const own = `${group.kind}:${group.label}`;
    if (resolving.has(groupId)) return `cycle:${own}`;
    resolving.add(groupId);
    const parent = group.parentGroup === undefined ? '' : resolveGroupPath(group.parentGroup);
    resolving.delete(groupId);
    const path = parent === '' ? own : `${parent}/${own}`;
    groupPathByLocalId.set(groupId, path);
    return path;
  };
  groups.forEach((group) => resolveGroupPath(group.id));
  return { actionStableIdByLocalId, groupPathByLocalId };
}

function actionContextSignature(action: Action, references: StateSemanticReferences): string {
  return JSON.stringify({
    label: action.label,
    type: action.type,
    kind: action.kind,
    risk: action.risk,
    state: action.state,
    visible: action.visible,
    hitTestable: action.hitTestable,
    region: references.groupPathByLocalId.get(action.region) ?? '',
    frame: action.frame,
    shadowPath: action.shadowPath,
    parentAction: action.parentAction === undefined
      ? undefined
      : references.actionStableIdByLocalId.get(action.parentAction),
    destination: action.observedDestination,
    revealedBy: action.discoveredVia?.triggerStableId,
    value: action.value,
    placeholder: action.placeholder,
    inViewport: action.inViewport,
    occludedBy: action.occludedBy,
  });
}

function observableContextSignature(observable: Observable, references: StateSemanticReferences): string {
  return JSON.stringify({
    label: observable.label,
    kind: observable.kind,
    valueType: observable.valueType,
    currentValue: observable.currentValue,
    region: references.groupPathByLocalId.get(observable.region) ?? '',
    frame: observable.frame,
    anchor: observable.anchor,
    changedBy: [...observable.changedBy].sort(),
    revealedBy: observable.discoveredVia?.triggerStableId,
  });
}

function collectionContextSignature(collection: Collection): string {
  const presented = collection as PresentedCollection;
  return JSON.stringify({
    templateId: collection.templateId,
    label: collection.label,
    instancesObserved: collection.instancesObserved,
    instancesDeclared: collection.instancesDeclared,
    traversal: collection.traversal,
    anchors: collection.anchors,
    itemActions: collection.itemActions,
    itemObservables: collection.itemObservables,
    rows: presented.rows?.map((row) => ({
      anchor: row.anchor,
      cells: row.cells.map((cell) => ({
        column: cell.column,
        type: cell.type,
        value: cell.value,
      })),
    })),
  });
}

/** Only render what distinguishes a derived state; the complete artifact stays in memory. */
function stateDelta(state: StateRecord, baseline: StateRecord): StateDelta {
  const priorActions = new Map(baseline.actions.map((action) => [action.stableId, action]));
  const priorObservables = new Map(baseline.observables.map((observable) => [observable.stableId, observable]));
  const priorReferences = stateSemanticReferences(baseline.actions, baseline.groups);
  const currentReferences = stateSemanticReferences(state.actions, state.groups);
  const actionIds = new Set<string>();
  const observableIds = new Set<string>();
  let changedActions = 0;
  let newActions = 0;
  let changedObservables = 0;
  let newObservables = 0;

  for (const action of state.actions) {
    const prior = priorActions.get(action.stableId);
    if (prior === undefined) { actionIds.add(action.id); newActions += 1; }
    else if (actionContextSignature(prior, priorReferences) !== actionContextSignature(action, currentReferences)) { actionIds.add(action.id); changedActions += 1; }
  }
  for (const observable of state.observables) {
    const prior = priorObservables.get(observable.stableId);
    if (prior === undefined) { observableIds.add(observable.id); newObservables += 1; }
    else if (observableContextSignature(prior, priorReferences) !== observableContextSignature(observable, currentReferences)) { observableIds.add(observable.id); changedObservables += 1; }
  }
  const currentActionIds = new Set(state.actions.map((action) => action.stableId));
  const currentObservableIds = new Set(state.observables.map((observable) => observable.stableId));
  const priorCollections = new Map(baseline.collections.map((collection) => [collection.templateId, collection]));
  const collections = state.collections.filter((collection) => {
    const prior = priorCollections.get(collection.templateId);
    return prior === undefined || collectionContextSignature(prior) !== collectionContextSignature(collection);
  });
  const currentCollectionIds = new Set(state.collections.map((collection) => collection.templateId));
  const removedActions = baseline.actions.filter((action) => !currentActionIds.has(action.stableId));
  const removedObservables = baseline.observables.filter(
    (observable) => !currentObservableIds.has(observable.stableId),
  );
  return {
    actionIds,
    observableIds,
    collections,
    removedCollections: baseline.collections.filter(
      (collection) => !currentCollectionIds.has(collection.templateId),
    ),
    removedActionLabels: removedActions.map((action) => action.label),
    removedObservableLabels: removedObservables.map((observable) => observable.label),
    changedActions,
    newActions,
    removedActions: removedActions.length,
    changedObservables,
    newObservables,
    removedObservables: removedObservables.length,
    inherited: state.actions.length + state.observables.length - actionIds.size - observableIds.size,
  };
}

function mergeHydratedStatus(current: ExtractionStatus, incoming: ExtractionStatus): ExtractionStatus {
  return incoming === 'extracting' && current !== 'extracting' ? current : incoming;
}

function shortUrl(url: string): string { return url.replace(/^https?:\/\//, ''); }

function selectorForAction(action: Action): string {
  const locator = action.locators[0];
  if (locator === undefined) return action.stableId.slice(0, 16);
  switch (locator.kind) {
    case 'testid': return `[data-testid="${locator.value}"]`;
    case 'role_name': return `${locator.role ?? 'role'} · ${locator.name ?? locator.value}`;
    case 'label': return `label=${locator.value}`;
    case 'placeholder': return `placeholder=${locator.value}`;
    case 'text': return `text=${locator.value}`;
    case 'structural': return locator.value;
  }
}

/**
 * The full gesture chain needed to reach an element, not just the last step.
 * A submenu item is only reproducible if the parent menu's gesture is shown
 * alongside it.
 */
function revealPath(reveal: Reveal | undefined): string {
  if (reveal === undefined) return '—';
  const steps = [...reveal.prerequisites, reveal];
  return steps.map((step) => `${step.triggerLabel} (${step.gesture})`).join(' → ');
}

function actionStateChips(action: Action): string[] {
  const chips = [action.visible ? 'visible' : 'hidden', action.inViewport ? 'in viewport' : 'offscreen', action.hitTestable ? 'hit-testable' : 'blocked'];
  if (action.occludedBy !== null) chips.push('occluded');
  chips.push(action.state.disabled ? 'disabled' : 'enabled');
  if (action.state.expanded !== undefined) chips.push(action.state.expanded ? 'expanded' : 'collapsed');
  if (action.state.checked !== undefined) chips.push(action.state.checked ? 'checked' : 'unchecked');
  if (action.state.selected !== undefined) chips.push(action.state.selected ? 'selected' : 'not selected');
  if (action.state.pressed !== undefined) chips.push(action.state.pressed ? 'pressed' : 'not pressed');
  if (action.state.readonly !== undefined) chips.push(action.state.readonly ? 'readonly' : 'editable');
  if (action.state.required !== undefined) chips.push(action.state.required ? 'required' : 'optional');
  if (action.value !== undefined) chips.push(`value=${action.value || 'empty'}`);
  if (action.placeholder !== undefined) chips.push(`placeholder=${action.placeholder || 'empty'}`);
  return chips;
}

function collectionNameTokens(value: string): Set<string> {
  const generic = new Set(['collection', 'container', 'items', 'item', 'list', 'table', 'region']);
  return new Set(normalizedCollectionText(value).split(' ').filter((token) => token !== '' && !generic.has(token)));
}

function unionRects(rects: Action['rect'][]): Action['rect'] {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

function collectionBindings(
  collections: Collection[],
  groups: Group[],
  actions: Map<string, Action>,
  observables: Map<string, Observable>,
): CollectionBinding[] {
  const usedGroups = new Set<string>();
  const byId = new Map(groups.map((group) => [group.id, group]));
  return collections.map((source) => {
    const collection = source as PresentedCollection;
    let group = collection.groupId === undefined ? undefined : byId.get(collection.groupId);
    if (group?.kind !== 'collection') group = undefined;
    if (group === undefined) {
      group = groups.find((candidate) =>
        candidate.kind === 'collection'
        && !usedGroups.has(candidate.id)
        && normalizedCollectionText(candidate.label) === normalizedCollectionText(collection.label),
      );
    }
    if (group === undefined) {
      group = groups.find((candidate) => candidate.kind === 'collection' && !usedGroups.has(candidate.id));
    }
    if (group !== undefined) usedGroups.add(group.id);
    const memberActions = (group?.actions ?? []).flatMap((id) => {
      const action = actions.get(id);
      return action === undefined ? [] : [action];
    });
    const memberObservables = (group?.observables ?? []).flatMap((id) => {
      const observable = observables.get(id);
      return observable === undefined ? [] : [observable];
    });
    let parentGroupId = group?.parentGroup ?? null;
    if (parentGroupId === null && group !== undefined) {
      const memberIds = new Set([...group.actions, ...group.observables]);
      let owningRegion = groups.find((candidate) =>
        candidate.kind !== 'collection'
        && [...candidate.actions, ...candidate.observables].some((id) => memberIds.has(id)),
      );
      if (owningRegion === undefined) {
        const collectionTokens = collectionNameTokens(collection.label);
        let bestScore = 0;
        for (const candidate of groups) {
          if (candidate.kind === 'collection') continue;
          const score = [...collectionNameTokens(candidate.label)].filter((token) => collectionTokens.has(token)).length;
          if (score > bestScore) { bestScore = score; owningRegion = candidate; }
        }
      }
      parentGroupId = owningRegion?.id ?? null;
    }
    return { collection, group: group ?? null, parentGroupId, actions: memberActions, observables: memberObservables };
  });
}

function fallbackCollectionRows(binding: CollectionBinding): PresentedCollectionRow[] {
  const actionColumns = [...new Map(binding.collection.itemActions.map((item) => [
    `${item.relPath}\u0000${item.kind}`,
    item,
  ])).values()];
  const observableColumns = [...new Map(binding.collection.itemObservables.map((item) => [
    `${item.relPath}\u0000${item.valueType}`,
    item,
  ])).values()];
  const anchors = binding.collection.anchors.length > 0
    ? binding.collection.anchors
    : binding.actions.map((action) => action.label).filter((label, index, all) => all.indexOf(label) === index);
  const rows: PresentedCollectionRow[] = anchors.map((anchor, index) => ({
    rowKey: `${binding.collection.templateId}:${index}`,
    anchor,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    cells: [],
  }));
  if (rows.length === 0 && (binding.actions.length > 0 || binding.observables.length > 0)) {
    rows.push({ rowKey: `${binding.collection.templateId}:0`, anchor: 'Item 1', rect: { x: 0, y: 0, w: 0, h: 0 }, cells: [] });
  }

  binding.actions.forEach((action, index) => {
    const label = normalizedCollectionText(action.label);
    const exactAnchorIndex = rows.findIndex((row) => {
      const anchor = normalizedCollectionText(row.anchor);
      return anchor !== '' && (label === anchor || label.includes(anchor));
    });
    const rowIndex = exactAnchorIndex >= 0
      ? exactAnchorIndex
      : Math.min(rows.length - 1, Math.floor(index / Math.max(1, actionColumns.length)));
    const row = rows[Math.max(0, rowIndex)];
    if (row === undefined) return;
    const column = action.type === 'navigation'
      ? 'Link'
      : action.type === 'input'
        ? 'Input'
        : action.type === 'toggle'
          ? 'Toggle'
          : 'Action';
    row.cells.push({ column, type: 'action', value: action.label, rect: action.rect, actionId: action.id });
    if (row.anchorActionId === undefined && (exactAnchorIndex >= 0 || action.type === 'navigation')) row.anchorActionId = action.id;
  });

  binding.observables.forEach((observable, index) => {
    const anchoredIndex = observable.anchor === undefined
      ? -1
      : rows.findIndex((row) => normalizedCollectionText(row.anchor) === normalizedCollectionText(observable.anchor ?? ''));
    const rowIndex = anchoredIndex >= 0
      ? anchoredIndex
      : Math.min(rows.length - 1, Math.floor(index / Math.max(1, observableColumns.length)));
    const row = rows[Math.max(0, rowIndex)];
    if (row === undefined) return;
    const template = observableColumns[index % Math.max(1, observableColumns.length)];
    row.cells.push({ column: template?.label || observable.label || 'Value', type: 'observable', value: observable.currentValue, rect: observable.rect, observableId: observable.id });
  });

  for (const row of rows) {
    const memberRects = row.cells.map((cell) => cell.rect).filter((rect) => rect.w > 0 && rect.h > 0);
    row.rect = unionRects(memberRects);
    if (row.anchorActionId === undefined) {
      const firstActionId = row.cells.find((cell) => cell.actionId !== undefined)?.actionId;
      if (firstActionId !== undefined) row.anchorActionId = firstActionId;
    }
  }
  return rows;
}

function rowsForCollection(binding: CollectionBinding): PresentedCollectionRow[] {
  return binding.collection.rows === undefined ? fallbackCollectionRows(binding) : binding.collection.rows;
}

function targetForCollectionCell(
  collection: PresentedCollection,
  row: PresentedCollectionRow,
  cell: PresentedCollectionCell,
  actions: Map<string, Action>,
  observables: Map<string, Observable>,
): HoverTarget {
  const action = cell.actionId === undefined ? undefined : actions.get(cell.actionId);
  if (action !== undefined) return targetForAction(action);
  const observable = cell.observableId === undefined ? undefined : observables.get(cell.observableId);
  if (observable !== undefined) return targetForObservable(observable);
  return {
    rect: cell.rect,
    type: cell.type === 'observable' ? 'observable' : cell.type === 'text' ? 'text' : 'container',
    label: cell.value || cell.column,
    sourceKey: collectionCellSourceKey(collection.templateId, row, cell),
  };
}

function targetForCollectionRow(
  collection: PresentedCollection,
  row: PresentedCollectionRow,
  actions: Map<string, Action>,
): HoverTarget {
  const anchorAction = row.anchorActionId === undefined ? undefined : actions.get(row.anchorActionId);
  return anchorAction === undefined
    ? { rect: row.rect, type: 'container', label: row.anchor, sourceKey: { kind: 'collection-row', templateId: collection.templateId, rowKey: row.rowKey } }
    : { rect: row.rect.w > 0 && row.rect.h > 0 ? row.rect : anchorAction.rect, type: anchorAction.type, label: row.anchor, sourceKey: { kind: 'collection-row', templateId: collection.templateId, rowKey: row.rowKey } };
}

function modifiersFor(event: ReactKeyboardEvent): number {
  return (event.altKey ? 1 : 0) + (event.ctrlKey ? 2 : 0) + (event.metaKey ? 4 : 0) + (event.shiftKey ? 8 : 0);
}

function Chevron({ open = false }: { open?: boolean }) { return <span aria-hidden="true" className={`chevron${open ? ' is-open' : ''}`} />; }
function TypeDot({ type }: { type: ElementType }) { return <span aria-hidden="true" className={`type-dot type-${type}`} />; }
function TypeBadge({ type }: { type: ElementType }) { return <span className={`type-badge type-${type}`}>{type}</span>; }

function ActionRow({ action, onHover, actions, children, choice = false }: { action: Action; onHover: (action: Action | null) => void; actions: Map<string, Action>; children?: ReactNode; choice?: boolean }) {
  const chips = actionStateChips(action);
  const primaryChip = action.occludedBy !== null || !action.hitTestable ? 'occluded' : action.state.disabled ? 'disabled' : action.state.expanded !== undefined ? (action.state.expanded ? 'expanded' : 'collapsed') : action.inViewport ? 'visible' : 'offscreen';
  const parentActionLabel = action.parentAction === undefined ? null : actions.get(action.parentAction)?.label ?? action.parentAction;
  return (
    <details className={`element-row${action.occludedBy !== null || !action.hitTestable ? ' is-occluded' : ''}`} onMouseEnter={() => onHover(action)} onMouseLeave={() => onHover(null)}>
      <summary>
        <TypeDot type={action.type} />
        <span className="element-summary"><span className="element-label">{action.label || 'Unlabelled control'}</span></span>
        <span className="element-meta">{choice ? <span className="type-badge type-input">choice</span> : <TypeBadge type={action.type} />}{action.discoveredVia !== undefined && <span className="state-chip is-discovered data-text" title={`Revealed by ${action.discoveredVia.triggerLabel}`}>revealed</span>}<span className="state-chip data-text">{primaryChip}</span></span>
      </summary>
      <div className="element-state-list" aria-label="Element state">{chips.map((chip) => <span className="state-chip data-text" key={chip}>{chip}</span>)}</div>
      <div className="element-details data-text">
        <span>selector</span><strong>{selectorForAction(action)}</strong>
        <span>action</span><strong>{action.kind}</strong>
        <span>risk</span><strong>{action.risk}</strong>
        <span>confidence</span><strong>{Math.round(action.confidence * 100)}%</strong>
        <span>value</span><strong>{action.value === undefined ? '—' : action.value || '(empty)'}</strong>
        <span>placeholder</span><strong>{action.placeholder === undefined ? '—' : action.placeholder || '(empty)'}</strong>
        <span>disabled</span><strong>{action.state.disabled ? 'yes' : 'no'}</strong>
        <span>expanded</span><strong>{action.state.expanded === undefined ? '—' : action.state.expanded ? 'yes' : 'no'}</strong>
        <span>checked</span><strong>{action.state.checked === undefined ? '—' : action.state.checked ? 'yes' : 'no'}</strong>
        <span>selected</span><strong>{action.state.selected === undefined ? '—' : action.state.selected ? 'yes' : 'no'}</strong>
        <span>pressed</span><strong>{action.state.pressed === undefined ? '—' : action.state.pressed ? 'yes' : 'no'}</strong>
        <span>readonly</span><strong>{action.state.readonly === undefined ? '—' : action.state.readonly ? 'yes' : 'no'}</strong>
        <span>required</span><strong>{action.state.required === undefined ? '—' : action.state.required ? 'yes' : 'no'}</strong>
        <span>visible</span><strong>{action.visible ? 'yes' : 'no'}</strong>
        <span>viewport</span><strong>{action.inViewport ? 'yes' : 'no'}</strong>
        <span>hit test</span><strong>{action.hitTestable ? 'pass' : 'blocked'}</strong>
        <span>occluder</span><strong>{action.occludedBy ?? 'none'}</strong>
        <span>region</span><strong>{action.region || 'page'}</strong>
        <span>frame</span><strong>{action.frame}</strong>
        <span>shadow path</span><strong>{action.shadowPath.length > 0 ? action.shadowPath.join(' → ') : 'document root'}</strong>
        <span>parent action</span><strong>{parentActionLabel ?? '—'}</strong>
        <span>revealed by</span><strong>{revealPath(action.discoveredVia)}</strong>
        <span>destination</span><strong>{action.observedDestination ?? '—'}</strong>
        <span>evidence</span><strong>{action.evidence.join(', ') || 'none'}</strong>
      </div>
      {children !== undefined && <div className="action-children" aria-label={`${action.label} choices and child controls`}>{children}</div>}
    </details>
  );
}

function ActionTree({ nodes, actions, onHover, parentKind }: { nodes: ActionTreeNode[]; actions: Map<string, Action>; onHover: (action: Action | null) => void; parentKind?: Action['kind'] }) {
  return <>{nodes.map((node) => <ActionRow key={node.action.id} action={node.action} actions={actions} onHover={onHover} choice={parentKind === 'select'}>{node.children.length > 0 ? <ActionTree nodes={node.children} actions={actions} onHover={onHover} parentKind={node.action.kind} /> : undefined}</ActionRow>)}</>;
}

function ObservableRow({ observable, actions, onHover }: { observable: Observable; actions: Map<string, Action>; onHover: (observable: Observable | null) => void }) {
  const drivers = observable.changedBy.map((stableId) => actions.get(stableId)?.label ?? stableId);
  return (
    <details className="element-row" onMouseEnter={() => onHover(observable)} onMouseLeave={() => onHover(null)}>
      <summary>
        <TypeDot type="observable" />
        <span className="element-summary"><span className="element-label">{observable.label || 'Observed value'}</span></span>
        <span className="element-meta"><TypeBadge type="observable" />{drivers.length > 0 && <span className="state-chip is-dynamic data-text" title={`Changed by ${drivers.join(', ')}`}>dynamic</span>}<span className="state-chip data-text" title={observable.currentValue}>value={observable.currentValue || '—'}</span></span>
      </summary>
      <div className="element-details data-text"><span>kind</span><strong>{observable.kind}</strong><span>value type</span><strong>{observable.valueType}</strong><span>region</span><strong>{observable.region || 'page'}</strong><span>frame</span><strong>{observable.frame}</strong><span>anchor</span><strong>{observable.anchor ?? '—'}</strong><span>baseline</span><strong>{observable.baselineValue ?? '—'}</strong><span>changed by</span><strong>{drivers.join(', ') || '—'}</strong><span>revealed by</span><strong>{revealPath(observable.discoveredVia)}</strong></div>
    </details>
  );
}

function CollectionTable({ binding, actions, observables, onHoverTarget }: { binding: CollectionBinding; actions: Map<string, Action>; observables: Map<string, Observable>; onHoverTarget: (target: HoverTarget | null) => void }) {
  const rows = rowsForCollection(binding);
  const columns = collectionColumns(rows, actions);
  return (
    <section className="collection-table-block" aria-label={`${binding.collection.label || 'Repeated collection'} table`}>
      <header className="collection-table-header">
        <span className="collection-table-title"><TypeDot type="container" /><strong>{binding.collection.label || 'Repeated collection'}</strong></span>
        <span className="collection-table-meta data-text">{binding.collection.instancesObserved} observed · {binding.collection.traversal.replaceAll('_', ' ')}</span>
      </header>
      <div className="collection-table-scroll" tabIndex={0} aria-label={`Scrollable ${binding.collection.label || 'collection'} columns`}>
        <table className={`collection-table${compactCollectionTable(columns) ? ' is-compact' : ''}`}>
          <thead><tr><th scope="col">Object</th>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => {
              const rowTarget = targetForCollectionRow(binding.collection, row, actions);
              const anchorAction = row.anchorActionId === undefined ? undefined : actions.get(row.anchorActionId);
              return (
                <tr key={row.rowKey} tabIndex={0} aria-label={`${row.anchor || 'Unnamed item'} repeated item`} title={row.anchor} onMouseEnter={() => onHoverTarget(rowTarget)} onMouseLeave={() => onHoverTarget(null)} onFocus={(event) => { if (event.target === event.currentTarget) onHoverTarget(rowTarget); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onHoverTarget(null); }}>
                  <th scope="row" className="collection-anchor-cell" data-column="Object">
                    <span className="collection-cell-value"><TypeDot type={anchorAction?.type ?? 'container'} /><span title={row.anchor}>{row.anchor || 'Unnamed item'}</span></span>
                  </th>
                  {columns.map((column) => {
                    const cells = visibleCollectionCells(row, actions).filter((cell) => collectionCellColumn(row, cell, actions) === column);
                    return (
                      <td key={column} data-column={column}>
                        {cells.length === 0
                          ? <span className="collection-empty-cell">—</span>
                          : cells.map((cell, cellIndex) => {
                            const target = targetForCollectionCell(binding.collection, row, cell, actions, observables);
                            const imageName = cell.value === '' || /^image$/iu.test(cell.value) ? row.anchor : `${row.anchor} ${cell.value}`;
                            return <span
                              className={`collection-cell type-${target.type}`}
                              key={`${cell.type}-${cell.actionId ?? cell.observableId ?? cell.value}-${cellIndex}`}
                              tabIndex={0}
                              onMouseEnter={() => onHoverTarget(target)}
                              onMouseLeave={() => onHoverTarget(rowTarget)}
                              onFocus={() => onHoverTarget(target)}
                              onBlur={() => onHoverTarget(rowTarget)}
                              aria-label={cell.type === 'image' ? `${imageName || 'Item'} image identified` : `${cell.value || row.anchor || column} ${column} identified`}
                              title={`${column}: ${cell.value || 'identified'}`}
                            >
                              {cell.type === 'image' ? <span className="collection-image-marker" aria-label="Image">▧</span> : <TypeDot type={target.type} />}
                              <span className="collection-cell-value-text">{cell.value || (cell.type === 'image' ? 'Image' : 'Identified')}</span>
                            </span>;
                          })}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && <tr className="collection-no-rows"><td colSpan={Math.max(1, columns.length + 1)}>Collection metadata changed; row contents are unchanged.</td></tr>}
          </tbody>
        </table>
      </div>
      {binding.collection.instancesDeclared > binding.collection.instancesObserved && <p className="collection-coverage data-text">Showing {binding.collection.instancesObserved} of {binding.collection.instancesDeclared} declared rows</p>}
    </section>
  );
}

function GroupCard({ group, actions, observables, collections = [], defaultOpen, onHoverAction, onHoverObservable, onHoverTarget, children }: { group: Group; actions: Map<string, Action>; observables: Map<string, Observable>; collections?: CollectionBinding[]; defaultOpen: boolean; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void; children?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const groupActions = group.actions.flatMap((id) => { const action = actions.get(id); return action === undefined ? [] : [action]; });
  const actionForest = buildActionForest(groupActions.map(({ id }) => id), actions);
  const groupObservables = group.observables.flatMap((id) => { const observable = observables.get(id); return observable === undefined ? [] : [observable]; });
  const directCount = groupActions.length + groupObservables.length;
  const count = directCount + collections.reduce((total, binding) => total + rowsForCollection(binding).length, 0);
  const parentActionLabel = group.parentAction === undefined ? null : actions.get(group.parentAction)?.label ?? group.parentAction;
  return (
    <details className="group-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="group-summary"><Chevron /><span className="group-heading"><span>{group.label || 'Page controls'}</span><small>{group.kind}{group.conditional ? ' · conditional' : ''}</small></span><span className="group-count data-text">{count}</span></summary>
      {parentActionLabel !== null && <p className="conditional-note data-text">revealed by <strong>{parentActionLabel}</strong></p>}
      {directCount > 0 && <div className="group-items">
        <ActionTree nodes={actionForest} actions={actions} onHover={onHoverAction} />
        {groupObservables.map((observable) => <ObservableRow key={observable.id} observable={observable} actions={actions} onHover={onHoverObservable} />)}
      </div>}
      {collections.map((binding) => <CollectionTable key={binding.collection.templateId} binding={binding} actions={actions} observables={observables} onHoverTarget={onHoverTarget} />)}
      {count === 0 && children === undefined && <p className="group-empty">No visible members in this group.</p>}
      {children !== undefined && <div className="group-children">{children}</div>}
    </details>
  );
}

function GroupTree({ groups, pageTitle, actions, observables, collections, onHoverAction, onHoverObservable, onHoverTarget }: { groups: Group[]; pageTitle: string; actions: Map<string, Action>; observables: Map<string, Observable>; collections: CollectionBinding[]; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void }) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const collectionsByParent = new Map<string, CollectionBinding[]>();
  for (const binding of collections) {
    if (binding.parentGroupId === null || !byId.has(binding.parentGroupId)) continue;
    const entries = collectionsByParent.get(binding.parentGroupId) ?? [];
    entries.push(binding);
    collectionsByParent.set(binding.parentGroupId, entries);
  }
  const renderGroup = (group: Group, depth: number, path: Set<string>, includeChildren = true, collectionSourceId = group.id): ReactNode => {
    if (path.has(group.id)) return <p className="group-empty" key={`${group.id}-cycle`}>Cyclic group reference omitted.</p>;
    const nextPath = new Set(path); nextPath.add(group.id);
    const children = includeChildren
      ? groups.filter((candidate) => candidate.parentGroup === group.id)
      : [];
    return <GroupCard key={group.id} group={group} actions={actions} observables={observables} collections={collectionsByParent.get(collectionSourceId) ?? []} defaultOpen={depth <= 1} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget}>{children.length > 0 ? children.map((child) => renderGroup(child, depth + 1, nextPath)) : undefined}</GroupCard>;
  };
  const orphans = collections.filter((binding) => binding.parentGroupId === null || !byId.has(binding.parentGroupId));
  const rootGroups = semanticRootGroups(groups, pageTitle, new Set(collectionsByParent.keys()));
  return <>
    {rootGroups.map(({ group, sourceGroupId, includeChildren }) => renderGroup(group, 0, new Set(), includeChildren, sourceGroupId))}
    {orphans.map((binding) => {
      const fallbackGroup: Group = { id: `${binding.collection.templateId}-container`, label: binding.collection.label || 'Repeated collection', kind: 'region', global: false, conditional: false, actions: [], observables: [] };
      return <GroupCard key={fallbackGroup.id} group={fallbackGroup} actions={actions} observables={observables} collections={[binding]} defaultOpen onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />;
    })}
  </>;
}

interface CanonicalNodeProps {
  nodeId: string;
  depth: number;
  path: ReadonlySet<string>;
  nodes: ReadonlyMap<string, ComponentTreeNode>;
  relationsByTarget: ReadonlyMap<string, ComponentTreeRelation[]>;
  groups: ReadonlyMap<string, Group>;
  actions: Map<string, Action>;
  observables: Map<string, Observable>;
  collections: ReadonlyMap<string, CollectionBinding>;
  onHoverAction: (action: Action | null) => void;
  onHoverObservable: (observable: Observable | null) => void;
  onHoverTarget: (target: HoverTarget | null) => void;
}

function componentLeafCount(
  nodeId: string,
  nodes: ReadonlyMap<string, ComponentTreeNode>,
  collections: ReadonlyMap<string, CollectionBinding>,
  path = new Set<string>(),
): number {
  if (path.has(nodeId)) return 0;
  const node = nodes.get(nodeId);
  if (node === undefined) return 0;
  if (node.kind === 'control' || node.kind === 'observable') return 1;
  if (node.kind === 'collection') {
    const binding = collections.get(node.ref?.id ?? node.id);
    return binding === undefined ? Math.max(1, node.instances?.observed ?? 0) : Math.max(1, rowsForCollection(binding).length);
  }
  const nextPath = new Set(path);
  nextPath.add(nodeId);
  return node.children.reduce(
    (total, child) => total + componentLeafCount(child, nodes, collections, nextPath),
    0,
  );
}

function ComponentReferenceFallback({ node }: { node: ComponentTreeNode }) {
  return <div className="component-reference-fallback">
    <TypeDot type={node.kind === 'observable' ? 'observable' : 'container'} />
    <span><strong>{node.label || 'Unlabelled component'}</strong><small className="data-text">{node.kind} reference unavailable</small></span>
  </div>;
}

function CanonicalNode({ nodeId, depth, path, nodes, relationsByTarget, groups, actions, observables, collections, onHoverAction, onHoverObservable, onHoverTarget }: CanonicalNodeProps): ReactNode {
  const [open, setOpen] = useState(true);
  const node = nodes.get(nodeId);
  if (node === undefined || path.has(nodeId)) return null;
  const nextPath = new Set(path);
  nextPath.add(nodeId);
  const renderChildren = (children = node.children) => children.map((child) => <CanonicalNode
    key={child}
    nodeId={child}
    depth={depth + 1}
    path={nextPath}
    nodes={nodes}
    relationsByTarget={relationsByTarget}
    groups={groups}
    actions={actions}
    observables={observables}
    collections={collections}
    onHoverAction={onHoverAction}
    onHoverObservable={onHoverObservable}
    onHoverTarget={onHoverTarget}
  />);

  if (node.kind === 'page') return <>{renderChildren()}</>;
  if (node.kind === 'control') {
    const action = actions.get(node.ref?.id ?? node.id);
    if (action === undefined) return <ComponentReferenceFallback node={node} />;
    // Menus and other sections revealed by a control are inventory groups,
    // not technical details that should disappear inside that control's row.
    const sectionIds = node.children.filter((id) => {
      const kind = nodes.get(id)?.kind;
      return kind !== 'control' && kind !== 'observable';
    });
    const sections = new Set(sectionIds);
    const children = renderChildren(node.children.filter((id) => !sections.has(id)));
    return <><ActionRow action={action} actions={actions} onHover={onHoverAction}>{children.length > 0 ? children : undefined}</ActionRow>{renderChildren(sectionIds)}</>;
  }
  if (node.kind === 'observable') {
    const observable = observables.get(node.ref?.id ?? node.id);
    return observable === undefined
      ? <ComponentReferenceFallback node={node} />
      : <ObservableRow observable={observable} actions={actions} onHover={onHoverObservable} />;
  }
  if (node.kind === 'collection') {
    const binding = collections.get(node.ref?.id ?? node.id);
    if (binding !== undefined) {
      return <CollectionTable binding={binding} actions={actions} observables={observables} onHoverTarget={onHoverTarget} />;
    }
  }

  const count = componentLeafCount(node.id, nodes, collections);
  if (count === 0) return null;
  const sourceGroup = node.ref?.kind === 'group' ? groups.get(node.ref.id) : undefined;
  const incomingReveal = (relationsByTarget.get(node.id) ?? []).find(({ kind }) => kind === 'reveals');
  const revealSource = incomingReveal === undefined ? undefined : nodes.get(incomingReveal.from);
  const detail = sourceGroup?.kind ?? node.kind;
  return <details className="group-card component-tree-branch" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="group-summary">
      <Chevron />
      <span className="group-heading"><span>{node.label || 'Page component'}</span><small>{detail}{node.availability !== 'current' ? ` · ${node.availability}` : ''}</small></span>
      <span className="group-count data-text">{count}</span>
    </summary>
    {incomingReveal !== undefined && <p className="conditional-note data-text">revealed by <strong>{revealSource?.label ?? incomingReveal.from}</strong> via {incomingReveal.gesture ?? 'interaction'}</p>}
    <div className="group-children component-tree-children">{renderChildren()}</div>
  </details>;
}

function CanonicalComponentTree({ tree, groups, actions, observables, collections, onHoverAction, onHoverObservable, onHoverTarget }: { tree: ComponentTreeProjection; groups: Map<string, Group>; actions: Map<string, Action>; observables: Map<string, Observable>; collections: CollectionBinding[]; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void }) {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const relationsByTarget = new Map<string, ComponentTreeRelation[]>();
  for (const relation of tree.relations) {
    if (relation.to === undefined) continue;
    const current = relationsByTarget.get(relation.to) ?? [];
    current.push(relation);
    relationsByTarget.set(relation.to, current);
  }
  const collectionsById = new Map(collections.map((binding) => [binding.collection.id, binding]));
  return <div className="component-tree" aria-label="Page component tree">
    <CanonicalNode nodeId={tree.root} depth={-1} path={new Set()} nodes={nodes} relationsByTarget={relationsByTarget} groups={groups} actions={actions} observables={observables} collections={collectionsById} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />
  </div>;
}

function PhaseProgress({ phase }: { phase: ExtractionPhase }) {
  const activeIndex = PHASES.indexOf(phase);
  return <div className="phase-progress" aria-label={`Extraction phase: ${phase}`}><div className="phase-track">{PHASES.map((item, index) => <span key={item} className={index <= activeIndex ? 'is-complete' : ''} />)}</div><span className="phase-label data-text">{phase}</span></div>;
}

function StateTab({ state, baseline, name, expanded, selected, onToggle, onHoverAction, onHoverObservable, onHoverTarget }: { state: StateRecord; baseline: StateRecord | null; name: string; expanded: boolean; selected: boolean; onToggle: () => void; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void }) {
  const groupMap = useMemo(
    () => new Map(state.groups.map((group) => [group.id, group])),
    [state.groups],
  );
  const actionMap = useMemo(() => {
    const lookup = new Map<string, Action>();
    for (const item of state.actions) { lookup.set(item.id, item); lookup.set(item.stableId, item); }
    return lookup;
  }, [state.actions]);
  const observableMap = useMemo(() => {
    const lookup = new Map<string, Observable>();
    for (const item of state.observables) { lookup.set(item.id, item); lookup.set(item.stableId, item); }
    return lookup;
  }, [state.observables]);
  const delta = useMemo(() => baseline === null ? null : stateDelta(state, baseline), [baseline, state]);
  // Every captured state keeps the complete hierarchy; the delta is a summary,
  // never a filter that hides unchanged elements after a passive observation.
  const displayedBindings = useMemo(() => collectionBindings(state.collections, state.groups, actionMap, observableMap), [actionMap, observableMap, state.collections, state.groups]);
  const componentTree = useMemo(() => state.componentTree === null
    ? null
    : projectComponentTree(state.componentTree), [state.componentTree]);
  const relevantGroups = state.groups;
  const referencedActions = new Set(relevantGroups.flatMap((group) => group.actions));
  const referencedObservables = new Set(relevantGroups.flatMap((group) => group.observables));
  const looseActions = state.actions.filter((action) => !referencedActions.has(action.id));
  const looseObservables = state.observables.filter((observable) => !referencedObservables.has(observable.id));
  const collectionActionIds = new Set(state.groups.filter((group) => group.kind === 'collection').flatMap((group) => group.actions));
  const collectionObservableIds = new Set(state.groups.filter((group) => group.kind === 'collection').flatMap((group) => group.observables));
  const displayGroups = relevantGroups.filter((group) => group.kind !== 'collection').map((group) => ({
    ...group,
    actions: group.actions.filter((id) => !collectionActionIds.has(id)),
    observables: group.observables.filter((id) => !collectionObservableIds.has(id)),
  }));
  const looseGroup: Group | null = looseActions.length + looseObservables.length > 0 ? { id: `${state.stateId}-ungrouped`, label: 'Other page elements', kind: 'region', global: false, conditional: false, actions: looseActions.map((action) => action.id), observables: looseObservables.map((observable) => observable.id) } : null;
  const deltaSize = delta === null ? 0 : delta.newActions + delta.changedActions + delta.removedActions + delta.newObservables + delta.changedObservables + delta.removedObservables + delta.collections.length + delta.removedCollections.length;
  return (
    <article className={`state-tab${selected ? ' is-selected' : ''}`}>
      <button className="state-summary" type="button" onClick={onToggle} aria-expanded={expanded}><Chevron open={expanded} /><span className="state-heading"><strong>{name}</strong>{state.trigger !== null && <span className="state-url data-text" title={state.trigger}>via {state.trigger}</span>}</span><span className={`status-chip status-${state.status}`}>{state.status}</span></button>
      {expanded && <div className="state-content">
        {state.status === 'extracting' && state.phase !== null && <PhaseProgress phase={state.phase} />}
        {delta !== null && <div className="state-delta-summary data-text"><strong>Changes from previous state</strong><span>+{delta.newActions + delta.newObservables} new · {delta.changedActions + delta.changedObservables} changed · −{delta.removedActions + delta.removedObservables} unavailable</span>{delta.inherited > 0 && <span>{delta.inherited} unchanged element{delta.inherited === 1 ? '' : 's'} also shown</span>}</div>}
        {delta !== null && (delta.removedActionLabels.length > 0 || delta.removedObservableLabels.length > 0 || delta.removedCollections.length > 0) && <div className="state-delta-summary data-text"><strong>Unavailable now</strong><span>{[...delta.removedActionLabels, ...delta.removedObservableLabels, ...delta.removedCollections.map((collection) => collection.label)].slice(0, 8).join(' · ')}</span></div>}
        {state.componentTree !== null
          ? componentTree === null
            ? deltaSize > 0 && <div className="inline-error" role="status"><strong>Component tree unavailable</strong><span>The extracted hierarchy could not be projected for this state.</span></div>
            : <CanonicalComponentTree tree={componentTree} groups={groupMap} actions={actionMap} observables={observableMap} collections={displayedBindings} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />
          : <>
              <GroupTree groups={displayGroups} pageTitle={state.title} actions={actionMap} observables={observableMap} collections={displayedBindings} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />
              {looseGroup !== null && <GroupCard group={looseGroup} actions={actionMap} observables={observableMap} defaultOpen={relevantGroups.length === 0} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />}
            </>}
        {delta !== null && deltaSize === 0 && <div className="zero-result">No controls or values changed. All current elements remain listed.</div>}
        {state.status === 'extracting' && state.groups.length === 0 && <div className="extracting-message"><span className="activity-dot" />Waiting for completed groups…</div>}
        {state.status === 'error' && <div className="inline-error" role="alert"><strong>Extraction stopped</strong><span>{state.errorMessage ?? 'The backend did not provide an error message. Try loading the page again.'}</span></div>}
        {state.status === 'ready' && state.groups.length === 0 && state.collections.length === 0 && state.actions.length === 0 && <div className="zero-result">No interactive elements were found in this state.</div>}
        {state.warnings.length > 0 && <details className="warning-list"><summary>{state.warnings.length} extraction warning{state.warnings.length === 1 ? '' : 's'}</summary>{state.warnings.map((warning, index) => <p key={`${warning.code}-${index}`}><code>{warning.code}</code> {warning.detail}</p>)}</details>}
      </div>}
    </article>
  );
}

/**
 * One card per address. States of the same page — a menu opening, validation
 * failing — nest inside it rather than appearing as separate pages.
 */
function PageCard({ page, currentStateId, expandedStateId, selectedStateId, onSelect, onHoverAction, onHoverObservable, onHoverTarget }: { page: PageGroup; currentStateId: string | null; expandedStateId: string | null; selectedStateId: string | null; onSelect: (stateId: string) => void; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void }) {
  const containsSelection = page.states.some((state) => state.stateId === selectedStateId);
  const containsCurrent = pageContainsCurrentState(page.states.map(({ stateId }) => stateId), currentStateId);
  const [open, setOpen] = useState(containsCurrent || (currentStateId === null && containsSelection));
  useEffect(() => {
    if (currentStateId !== null) setOpen(containsCurrent || containsSelection);
  }, [containsCurrent, containsSelection, currentStateId]);
  const single = page.states.length === 1;
  const pageTitle = page.states.find((state) => state.stateId === selectedStateId)?.title || page.states.at(-1)?.title || labelForUrl(page.url);
  return (
    <section className={`page-card${containsCurrent ? ' is-current' : ''}${containsSelection ? ' is-selected' : ''}`}>
      <button className="page-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Chevron open={open} />
        <span className="page-heading"><strong>{pageTitle}</strong><span className="state-url data-text" title={page.url}>{shortUrl(page.url)}</span></span>
        <span className="group-count data-text">{page.states.length} state{single ? '' : 's'}</span>
      </button>
      {open && <div className="page-states">
        {page.states.map((state, index) => {
          const parent = state.parentStateId === null ? undefined : page.states.find((candidate) => candidate.stateId === state.parentStateId);
          const baseline = parent ?? page.states[index - 1] ?? null;
          return <StateTab key={state.stateId} state={state} baseline={baseline} name={stateLabel(state, index)} expanded={expandedStateId === state.stateId} selected={selectedStateId === state.stateId} onToggle={() => onSelect(state.stateId)} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />;
        })}
      </div>}
    </section>
  );
}

function DiscoveredPanel({ states, currentStateId, expandedStateId, selectedStateId, captureProgress, onSelect, onHoverAction, onHoverObservable, onHoverTarget }: { states: StateRecord[]; currentStateId: string | null; expandedStateId: string | null; selectedStateId: string | null; captureProgress: CaptureProgress | null; onSelect: (stateId: string) => void; onHoverAction: (action: Action | null) => void; onHoverObservable: (observable: Observable | null) => void; onHoverTarget: (target: HoverTarget | null) => void }) {
  return <aside className="panel discovered-panel" aria-label="Discovered elements">
    <header className="panel-header discovered-header"><h2>Discovered Elements</h2><p>Controls, content, and collections by page section</p></header>
    <div className="type-legend" aria-label="Element type legend">{TYPE_LABELS.map((type) => <span key={type}><TypeDot type={type} />{type}</span>)}</div>
    <div className="state-list">
      {captureProgress !== null && <div className={`capture-banner${captureProgress.errorMessage !== null ? ' is-error' : ''}`} role={captureProgress.errorMessage !== null ? 'alert' : undefined}><div>{captureProgress.errorMessage === null ? <span className="activity-dot" /> : <span className="capture-error-icon">!</span>}<strong>{captureProgress.errorMessage === null ? 'Extracting current page' : 'Extraction failed'}</strong></div>{captureProgress.errorMessage === null ? <PhaseProgress phase={captureProgress.phase} /> : <p>{captureProgress.errorMessage}</p>}</div>}
      {states.length === 0 && captureProgress === null && <div className="panel-empty"><span className="empty-glyph" aria-hidden="true">⌁</span><strong>Enter a URL to begin extraction.</strong><span>Discovered controls and values will appear here as each group completes.</span></div>}
      {groupStatesByExactUrl(states).map((page) => <PageCard key={page.key} page={page} currentStateId={currentStateId} expandedStateId={expandedStateId} selectedStateId={selectedStateId} onSelect={onSelect} onHoverAction={onHoverAction} onHoverObservable={onHoverObservable} onHoverTarget={onHoverTarget} />)}
    </div>
  </aside>;
}

function useArenaGeometry(containerRef: React.RefObject<HTMLDivElement>, frameVersion: number) {
  const [geometry, setGeometry] = useState<ArenaGeometry>({ left: 0, top: 0, width: 0, height: 0, scaleX: 1, scaleY: 1 });
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth; const height = element.clientHeight;
      const scale = Math.min(width / VIEWPORT_WIDTH, height / VIEWPORT_HEIGHT);
      const renderedWidth = VIEWPORT_WIDTH * scale; const renderedHeight = VIEWPORT_HEIGHT * scale;
      setGeometry({ left: (width - renderedWidth) / 2, top: (height - renderedHeight) / 2, width: renderedWidth, height: renderedHeight, scaleX: scale, scaleY: scale });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [containerRef, frameVersion]);
  return geometry;
}

/**
 * Report where the native page view should sit.
 *
 * A WebContentsView is composited over the window and ignores DOM stacking, so
 * the renderer cannot place it with CSS — it can only measure the hole it left
 * and tell the shell. Scroll and resize both move that hole, so both are
 * watched.
 */
function useNativeViewBounds(ref: React.RefObject<HTMLDivElement>, active: boolean) {
  useEffect(() => {
    if (!active || transport.setViewBounds === undefined) return;
    const element = ref.current;
    if (element === null) return;
    let frameHandle: number | null = null;
    const report = () => {
      frameHandle = null;
      const box = element.getBoundingClientRect();
      transport.setViewBounds?.({ x: box.left, y: box.top, width: box.width, height: box.height });
    };
    const schedule = () => {
      if (frameHandle !== null) return;
      frameHandle = window.requestAnimationFrame(report);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frameHandle !== null) window.cancelAnimationFrame(frameHandle);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      transport.setViewBounds?.(null);
    };
  }, [ref, active]);
}

function BrowserArena({ sessionId, url, frame, connection, activeState, hovered, overlayEnabled, onOverlayChange, onInput, inputError }: { sessionId: string | null; url: string; frame: string | null; connection: ConnectionStatus; activeState: StateRecord | null; hovered: HoverTarget | null; overlayEnabled: boolean; onOverlayChange: (enabled: boolean) => void; onInput: (payload: InputPayload, quiet?: boolean) => void; inputError: string | null }) {
  const viewportRef = useRef<HTMLDivElement>(null); const pointerRaf = useRef<number | null>(null);
  const pressedPointers = useRef(new Map<number, { button: 'left' | 'middle' | 'right'; point: { x: number; y: number } }>());
  const native = transport.rendersNatively;
  const geometry = useArenaGeometry(viewportRef, frame === null ? 0 : frame.length);
  useNativeViewBounds(viewportRef, native);
  useEffect(() => () => {
    if (pointerRaf.current !== null) window.cancelAnimationFrame(pointerRaf.current);
    for (const pressed of pressedPointers.current.values()) onInput({ kind: 'mouse', type: 'mouseReleased', ...pressed.point, button: pressed.button, clickCount: 1 }, true);
    pressedPointers.current.clear();
  }, [onInput, sessionId]);
  const coordinates = (clientX: number, clientY: number, clamp = false) => {
    const element = viewportRef.current; if (element === null || geometry.width === 0 || geometry.height === 0) return null;
    const bounds = element.getBoundingClientRect(); const x = (clientX - bounds.left - geometry.left) / geometry.scaleX; const y = (clientY - bounds.top - geometry.top) / geometry.scaleY;
    if (!clamp && (x < 0 || y < 0 || x > VIEWPORT_WIDTH || y > VIEWPORT_HEIGHT)) return null;
    return { x: Math.max(0, Math.min(VIEWPORT_WIDTH, x)), y: Math.max(0, Math.min(VIEWPORT_HEIGHT, y)) };
  };
  const pointerButton = (button: number): 'left' | 'middle' | 'right' => button === 1 ? 'middle' : button === 2 ? 'right' : 'left';
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sessionId === null || frame === null) return; const point = coordinates(event.clientX, event.clientY, pressedPointers.current.has(event.pointerId)); if (point === null) return;
    const pressed = pressedPointers.current.get(event.pointerId); if (pressed !== undefined) pressed.point = point;
    if (pointerRaf.current !== null) return;
    pointerRaf.current = window.requestAnimationFrame(() => { pointerRaf.current = null; onInput({ kind: 'mouse', type: 'mouseMoved', ...point }, true); });
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sessionId === null || frame === null) return; const point = coordinates(event.clientX, event.clientY); if (point === null) return;
    const button = pointerButton(event.button); pressedPointers.current.set(event.pointerId, { button, point });
    event.currentTarget.setPointerCapture(event.pointerId); onInput({ kind: 'mouse', type: 'mousePressed', ...point, button, clickCount: 1 }); event.currentTarget.focus(); event.preventDefault();
  };
  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>, quiet = false) => {
    const pressed = pressedPointers.current.get(event.pointerId); if (pressed === undefined) return;
    const point = coordinates(event.clientX, event.clientY, true) ?? pressed.point;
    pressedPointers.current.delete(event.pointerId); onInput({ kind: 'mouse', type: 'mouseReleased', ...point, button: pressed.button, clickCount: 1 }, quiet);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (sessionId === null || frame === null) return; const point = coordinates(event.clientX, event.clientY); if (point === null) return; event.preventDefault();
    onInput({ kind: 'mouse', type: 'mouseWheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY }, true);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (sessionId === null || frame === null || event.repeat) return; const modifiers = modifiersFor(event);
    onInput({ kind: 'key', type: 'keyDown', key: event.key, code: event.code, modifiers });
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) onInput({ kind: 'key', type: 'char', text: event.key, key: event.key, modifiers });
    if ([' ', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) event.preventDefault();
  };
  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => { if (sessionId !== null && frame !== null) onInput({ kind: 'key', type: 'keyUp', key: event.key, code: event.code, modifiers: modifiersFor(event) }); };
  const overlays = activeState?.actions ?? [];
  return <section className="arena-panel" aria-label="Orchestration arena">
    <div className="browser-chrome"><div className="browser-dots" aria-hidden="true"><i /><i /><i /></div><div className="browser-location data-text" title={url}>{url || 'No page loaded'}</div><div className="arena-tools"><span className={`connection connection-${connection}`}><i />{connection === 'live' ? 'live' : connection}</span><label className="overlay-switch"><input type="checkbox" checked={overlayEnabled} onChange={(event) => onOverlayChange(event.target.checked)} /><span aria-hidden="true" />boxes</label><span className="arena-title">Browser</span></div></div>
    <div className="arena-stage">{native
      ? <div ref={viewportRef} className="native-viewport" aria-label="Live browser view" role="application">
          {sessionId === null && <div className="arena-empty"><div className="browser-placeholder" aria-hidden="true"><span /><span /><span /></div><strong>Your live page will appear here</strong><span>Load a URL to start a browser session and inspect the page as it is extracted.</span></div>}
        </div>
      : <div ref={viewportRef} className={`screencast-viewport${frame !== null ? ' is-interactive' : ''}`} tabIndex={frame === null ? -1 : 0} role="application" aria-label="Interactive live browser view" onPointerMove={handlePointerMove} onPointerDown={handlePointerDown} onPointerUp={(event) => releasePointer(event)} onPointerCancel={(event) => releasePointer(event, true)} onLostPointerCapture={(event) => releasePointer(event, true)} onContextMenu={(event) => event.preventDefault()} onWheel={handleWheel} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp}>
      {frame !== null ? <img draggable={false} src={frame} alt="Live page screencast" /> : <div className="arena-empty"><div className="browser-placeholder" aria-hidden="true"><span /><span /><span /></div><strong>Your live page will appear here</strong><span>Load a URL to start a browser session and inspect the page as it is extracted.</span></div>}
      <div className="overlay-layer" aria-hidden="true">
        {overlayEnabled && overlays.slice(0, 300).map((action) => { const style = { left: geometry.left + action.rect.x * geometry.scaleX, top: geometry.top + action.rect.y * geometry.scaleY, width: Math.max(2, action.rect.w * geometry.scaleX), height: Math.max(2, action.rect.h * geometry.scaleY) } satisfies CSSProperties; return <span key={action.id} className={`control-box type-${action.type}`} style={style} title={action.label} />; })}
        {hovered !== null && <span className={`control-box is-highlighted type-${hovered.type}`} style={{ left: geometry.left + hovered.rect.x * geometry.scaleX, top: geometry.top + hovered.rect.y * geometry.scaleY, width: Math.max(2, hovered.rect.w * geometry.scaleX), height: Math.max(2, hovered.rect.h * geometry.scaleY) }}><b>{hovered.label}</b></span>}
      </div>
    </div>}{!native && frame !== null && <div className="interaction-hint">Click or type directly in the live view</div>}{native && <div className="interaction-hint">Native browser view — interact with the page directly</div>}{inputError !== null && <div className="arena-error" role="alert">{inputError}</div>}</div>
  </section>;
}

export function App() {
  const [draftUrl, setDraftUrl] = useState('');
  const [confirmedUrl, setConfirmedUrl] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Array<Extract<OrchestratorEvent, { t: 'dom.observed' | 'state.transition' }>>>([]);
  const activityLogRef = useRef<typeof activity>([]);
  const activityKeysRef = useRef(new Set<string>());
  const historyEpochRef = useRef(0);
  const appliedResetsRef = useRef(new Set<string>());
  const [resettingHistory, setResettingHistory] = useState(false);
  const [states, setStates] = useState<StateRecord[]>([]);
  const [currentStateId, setCurrentStateId] = useState<string | null>(null);
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [expandedStateId, setExpandedStateId] = useState<string | null>(null);
  const [captureProgress, setCaptureProgress] = useState<CaptureProgress | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [loading, setLoading] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const sessionRef = useRef<string | null>(null);
  const currentStateRef = useRef<string | null>(null);
  const reconnectRef = useRef(0);
  const streamHydratingRef = useRef(true);
  const inputErrorTimer = useRef<number | null>(null);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const eventHandlerRef = useRef<(event: WireEvent, sessionId: string, activate: boolean) => void>(() => undefined);
  const hydrateRef = useRef<(sessionId: string) => Promise<void>>(async () => undefined);
  useEffect(() => { sessionRef.current = sessionId; }, [sessionId]);
  useEffect(() => { currentStateRef.current = currentStateId; }, [currentStateId]);

  useEffect(() => { if (selectedStateId !== currentStateId) setHovered(null); }, [currentStateId, selectedStateId]);

  const upsertState = useCallback((record: StateRecord, activate = true) => {
    setStates((current) => {
      const index = current.findIndex((item) => item.stateId === record.stateId);
      if (index === -1) return [...(activate ? current.map((item) => ({ ...item, status: item.status === 'ready' ? 'stale' as const : item.status })) : current), record];
      return current.map((item, itemIndex) => itemIndex === index ? record : item);
    });
    if (activate) { setSelectedStateId(record.stateId); setExpandedStateId(record.stateId); }
  }, []);
  const patchState = useCallback((stateId: string, updater: (state: StateRecord) => StateRecord) => { setStates((current) => current.map((state) => state.stateId === stateId ? updater(state) : state)); }, []);

  const fetchArtifact = useCallback(async (activeSessionId: string, stateId: string, activate = true) => {
    const epoch = historyEpochRef.current;
    const payload = await transport.state(activeSessionId, stateId).catch((error: unknown) => {
      if (epoch !== historyEpochRef.current) return null;
      throw error;
    });
    if (epoch !== historyEpochRef.current) return;
    if (!isStateArtifact(payload)) throw new Error('The backend returned an invalid state artifact.');
    const artifact = recordFromArtifact(payload);
    setStates((current) => current.map((record) => record.stateId === stateId ? { ...artifact, status: record.status, parentStateId: record.parentStateId, trigger: record.trigger, errorMessage: record.errorMessage, warnings: mergeWarnings(record.warnings, artifact.warnings) } : record));
    if (activate && currentStateRef.current === stateId) { setSelectedStateId(stateId); setExpandedStateId(stateId); }
  }, []);

  const hydrateStates = useCallback(async (activeSessionId: string) => {
    const epoch = historyEpochRef.current;
    try {
      const payload = await transport.states(activeSessionId).catch(() => null); if (payload === null) return;
      if (epoch !== historyEpochRef.current) return;
      const indexPayload = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null;
      const possible = Array.isArray(payload) ? payload : indexPayload !== null && Array.isArray(indexPayload.states) ? indexPayload.states : [];
      const currentStateId = indexPayload !== null && typeof indexPayload.currentStateId === 'string' ? indexPayload.currentStateId : null;
      const lastError = indexPayload !== null && typeof indexPayload.lastError === 'string' && indexPayload.lastError.length > 0 ? indexPayload.lastError : null;
      if (lastError !== null) setAppError(lastError);
      const ids: string[] = [];
      let authoritativeUrl: string | null = null;
      let authoritativeStatus: ExtractionStatus | null = null;
      for (const item of possible) {
        if (isStateArtifact(item)) {
          upsertState(recordFromArtifact(item), false);
          if (item.stateId === currentStateId) { authoritativeUrl = item.url; authoritativeStatus = 'ready'; }
        } else if (typeof item === 'object' && item !== null && typeof (item as { stateId?: unknown }).stateId === 'string') {
          const entry = item as Record<string, unknown>; const id = entry.stateId as string;
          // Capture IDs exist only to correlate navigation/progress and never
          // have an artifact. Keep them in the progress/error banner rather
          // than leaving an unresolvable synthetic page tab behind.
          if (id.startsWith('capture_')) continue;
          ids.push(id);
          const status = ['extracting', 'ready', 'stale', 'error'].includes(String(entry.status)) ? entry.status as ExtractionStatus : 'ready';
          const record = emptyStateRecord(id, typeof entry.url === 'string' ? entry.url : confirmedUrl, status);
          if (typeof entry.title === 'string') { record.title = entry.title; record.label = entry.title || record.label; }
          if (typeof entry.parentStateId === 'string') record.parentStateId = entry.parentStateId;
          if (typeof entry.trigger === 'string') record.trigger = entry.trigger;
          if (id === currentStateId) { if (typeof entry.url === 'string') authoritativeUrl = entry.url; authoritativeStatus = status; }
          setStates((current) => {
            const existing = current.find((candidate) => candidate.stateId === id);
            return existing === undefined ? [...current, record] : current.map((candidate) => candidate.stateId === id ? { ...candidate, url: record.url, title: record.title, label: record.label, status: mergeHydratedStatus(candidate.status, record.status), parentStateId: record.parentStateId, trigger: record.trigger, errorMessage: status === 'error' ? indexPayload !== null && typeof indexPayload.lastError === 'string' ? indexPayload.lastError : candidate.errorMessage : candidate.errorMessage } : candidate);
          });
        }
      }
      await Promise.all(ids.map(async (id) => { try { await fetchArtifact(activeSessionId, id, false); } catch { /* stream remains authoritative */ } }));
      if (epoch !== historyEpochRef.current) return;
      if (currentStateId !== null) {
        currentStateRef.current = currentStateId; setCurrentStateId(currentStateId); setSelectedStateId(currentStateId); setExpandedStateId(currentStateId);
        if (authoritativeUrl !== null) { setConfirmedUrl(authoritativeUrl); setDraftUrl(authoritativeUrl); }
      }
      if (lastError !== null) {
        setLoading(false); setCaptureProgress({ stateId: 'replayed-error', url: authoritativeUrl ?? confirmedUrl, phase: 'navigating', errorMessage: lastError });
      } else if (authoritativeStatus === 'ready' || authoritativeStatus === 'stale') {
        setLoading(false); setCaptureProgress(null);
      }
    } catch { /* reconnect hydration is best effort */ }
  }, [confirmedUrl, fetchArtifact, upsertState]);

  const handleWireEvent = useCallback((event: WireEvent, activeSessionId: string, activate: boolean) => {
    if (event.t === 'history.reset') {
      if (appliedResetsRef.current.has(event.resetId)) return;
      appliedResetsRef.current.add(event.resetId);
      historyEpochRef.current += 1;
      const record = recordFromArtifact(event.artifact);
      record.parentStateId = null; record.trigger = null;
      const initial: Extract<OrchestratorEvent, { t: 'state.transition' }> = { t: 'state.transition', fromStateId: null, toStateId: record.stateId, firstSequence: event.throughSequence + 1, lastSequence: event.throughSequence, trigger: 'history reset', timestamp: event.timestamp };
      activityLogRef.current = [initial];
      activityKeysRef.current = new Set([`state-${initial.firstSequence}-${initial.lastSequence}-${initial.toStateId}`]);
      setActivity([initial]); setStates([record]);
      currentStateRef.current = record.stateId;
      setCurrentStateId(record.stateId); setSelectedStateId(record.stateId); setExpandedStateId(record.stateId);
      setConfirmedUrl(record.url); setDraftUrl(record.url);
      setCaptureProgress(null); setLoading(false); setAppError(null); setHovered(null);
      return;
    }
    if (event.t === 'dom.observed' || event.t === 'state.transition') {
      const key = event.t === 'dom.observed' ? `batch-${event.batch.firstSequence}` : `state-${event.firstSequence}-${event.lastSequence}-${event.toStateId}`;
      if (!activityKeysRef.current.has(key)) {
        activityKeysRef.current.add(key);
        activityLogRef.current.push(event);
        // Render confirmed steps at capture boundaries, not on every pointer event.
        if (event.t === 'state.transition') setActivity([...activityLogRef.current]);
      }
      return;
    }
    if (event.t === 'frame') {
      setFrame(event.data.startsWith('data:') ? event.data : `data:image/jpeg;base64,${event.data}`);
      if (activate && typeof event.url === 'string') { setConfirmedUrl(event.url); setDraftUrl(event.url); }
      return;
    }
    if (event.t === 'extraction.started') {
      if (activate) { setCaptureProgress({ stateId: event.stateId, url: event.url, phase: 'navigating', errorMessage: null }); setConfirmedUrl(event.url); setDraftUrl(event.url); setLoading(true); setAppError(null); }
      return;
    }
    if (event.t === 'extraction.phase') {
      if (activate) setCaptureProgress((current) => ({ stateId: event.stateId, url: current?.url ?? confirmedUrl, phase: event.phase, errorMessage: null }));
      patchState(event.stateId, (record) => ({ ...record, phase: event.phase, status: 'extracting', errorMessage: null }));
      return;
    }
    if (event.t === 'state.discovered') {
      const record = emptyStateRecord(event.stateId, event.url ?? confirmedUrl); record.label = event.label || record.label; record.parentStateId = event.parentStateId; record.trigger = event.trigger; upsertState(record, activate); return;
    }
    if (event.t === 'state.presentation') {
      // Geometry-only refreshes never select/expand a state or show extraction
      // progress. Hydrate the retained artifact so hover boxes track the live
      // page while the operator's current tab and model context remain intact.
      void fetchArtifact(activeSessionId, event.stateId, false).catch(() => undefined);
      return;
    }
    if (event.t === 'extraction.group') {
      setStates((current) => {
        const found = current.find((record) => record.stateId === event.stateId); const base = found ?? emptyStateRecord(event.stateId, captureProgress?.url ?? confirmedUrl);
        const next: StateRecord = { ...base, status: 'extracting', errorMessage: null, groups: mergeById(base.groups, [event.group]), actions: mergeById(base.actions, event.actions), observables: mergeById(base.observables, event.observables) };
        return found === undefined ? [...(activate ? current.map((item) => ({ ...item, status: item.status === 'ready' ? 'stale' as const : item.status })) : current), next] : current.map((item) => item.stateId === event.stateId ? next : item);
      });
      if (activate) { setSelectedStateId(event.stateId); setExpandedStateId(event.stateId); }
      return;
    }
    if (event.t === 'extraction.warning') { patchState(event.stateId, (record) => ({ ...record, warnings: mergeWarnings(record.warnings, [event.warning]) })); return; }
    if (event.t === 'extraction.completed') {
      if (activate) { setCaptureProgress(null); setLoading(false); }
      setStates((current) => {
        const found = current.find((record) => record.stateId === event.stateId); const base = found ?? emptyStateRecord(event.stateId, captureProgress?.url ?? confirmedUrl);
        const complete = { ...base, status: 'ready' as const, phase: null, counts: event.counts, timings: event.timings, errorMessage: null };
        return found === undefined ? [...current, complete] : current.map((item) => item.stateId === event.stateId ? complete : item);
      });
      if (activate) { currentStateRef.current = event.stateId; setCurrentStateId(event.stateId); setSelectedStateId(event.stateId); setExpandedStateId(event.stateId); }
      void fetchArtifact(activeSessionId, event.stateId, activate).catch((error: unknown) => { if (activate) setAppError(error instanceof Error ? error.message : 'The final state artifact could not be loaded.'); });
      return;
    }
    if (activate) {
      setLoading(false); setAppError(event.message);
      setCaptureProgress((current) => current !== null && (current.stateId === event.stateId || event.stateId.startsWith('capture_')) ? { ...current, errorMessage: event.message } : { stateId: event.stateId, url: confirmedUrl, phase: 'navigating', errorMessage: event.message });
    }
    patchState(event.stateId, (record) => ({ ...record, status: 'error', phase: null, errorMessage: event.message }));
  }, [captureProgress?.url, confirmedUrl, fetchArtifact, patchState, upsertState]);

  useEffect(() => { eventHandlerRef.current = handleWireEvent; }, [handleWireEvent]);
  useEffect(() => { hydrateRef.current = hydrateStates; }, [hydrateStates]);

  useEffect(() => {
    if (sessionId === null) return; let disposed = false; let retryTimer: number | null = null; let unsubscribe: (() => void) | null = null;
    const connect = () => {
      if (disposed) return;
      streamHydratingRef.current = true; setConnection(reconnectRef.current === 0 ? 'connecting' : 'reconnecting');
      unsubscribe = transport.subscribe(
        sessionId,
        (parsed) => {
          if (typeof parsed === 'object' && parsed !== null && 't' in parsed) {
            eventHandlerRef.current(parsed as WireEvent, sessionId, !streamHydratingRef.current);
          }
        },
        (status) => {
          if (disposed) return;
          if (status === 'live') {
            reconnectRef.current = 0; setConnection('live');
            void (async () => {
              await hydrateRef.current(sessionId);
              await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
              if (!disposed) await hydrateRef.current(sessionId);
            })().finally(() => { if (!disposed) streamHydratingRef.current = false; });
            return;
          }
          unsubscribe?.(); unsubscribe = null;
          reconnectRef.current += 1; setConnection(reconnectRef.current > 5 ? 'offline' : 'reconnecting');
          retryTimer = window.setTimeout(connect, Math.min(5000, 400 * (2 ** Math.min(reconnectRef.current, 4))));
        },
      );
    };
    connect();
    return () => { disposed = true; if (retryTimer !== null) window.clearTimeout(retryTimer); unsubscribe?.(); };
  }, [sessionId]);

  const handleLoad = async (event: FormEvent) => {
    event.preventDefault(); let requestedUrl = draftUrl.trim(); if (requestedUrl.length === 0) { setAppError('Enter a website URL to begin extraction.'); return; } if (!/^https?:\/\//i.test(requestedUrl)) requestedUrl = `https://${requestedUrl}`;
    try { const parsed = new URL(requestedUrl); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); requestedUrl = parsed.href; } catch { setAppError('Enter a valid HTTP or HTTPS URL.'); return; }
    const restoreUrl = confirmedUrl;
    setDraftUrl(requestedUrl); setAppError(null); setLoading(true); setCaptureProgress({ stateId: 'pending', url: requestedUrl, phase: 'navigating', errorMessage: null });
    try {
      const existingSession = sessionRef.current;
      if (existingSession !== null) await transport.goto(existingSession, requestedUrl);
      else setSessionId(await transport.createSession(requestedUrl));
      setConfirmedUrl(requestedUrl); setDraftUrl(requestedUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The page could not be loaded.';
      setLoading(false); setConfirmedUrl(restoreUrl); setDraftUrl(restoreUrl || requestedUrl); setCaptureProgress({ stateId: 'pending', url: requestedUrl, phase: 'navigating', errorMessage: message }); setAppError(message);
    }
  };

  const handleResetHistory = async () => {
    const activeSessionId = sessionRef.current;
    if (activeSessionId === null || resettingHistory) return;
    setResettingHistory(true); setAppError(null);
    try {
      await inputQueueRef.current.catch(() => undefined);
      const reset = await transport.resetHistory(activeSessionId);
      // IPC/WebSocket may deliver the same reset first; resetId makes this idempotent.
      eventHandlerRef.current(reset, activeSessionId, true);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : 'Could not reset history.');
    } finally { setResettingHistory(false); }
  };

  const sendInput = useCallback((payload: InputPayload, quiet = false) => {
    const activeSession = sessionRef.current; if (activeSession === null) return;
    inputQueueRef.current = inputQueueRef.current.catch(() => undefined).then(async () => {
      try {
        await transport.sendInput(activeSession, payload);
      } catch (error) {
        if (quiet) return;
        setInputError(error instanceof Error ? error.message : 'Browser input could not be forwarded.');
        if (inputErrorTimer.current !== null) window.clearTimeout(inputErrorTimer.current);
        inputErrorTimer.current = window.setTimeout(() => setInputError(null), 4000);
      }
    });
  }, []);

  const selectState = (stateId: string) => { setSelectedStateId(stateId); setExpandedStateId((current) => current === stateId ? null : stateId); };
  const arenaState = states.find((state) => state.stateId === currentStateId) ?? null;
  const resolvedHovered = useMemo(
    () => hovered === null ? null : resolveHoverTarget(hovered, arenaState),
    [arenaState, hovered],
  );

  // The native page view is composited above this renderer, so highlight boxes
  // have to be drawn inside the page itself rather than layered over it.
  useEffect(() => {
    if (!transport.rendersNatively || transport.highlight === undefined) return;
    if (sessionId === null) return;
    if (selectedStateId !== currentStateId) {
      // The overlay lives inside the native page, outside React's stacking
      // context. Selecting a historical snapshot must explicitly clear the
      // last live-page box or it remains painted after this effect returns.
      void transport.highlight(sessionId, []).catch(() => undefined);
      return;
    }
    const boxes: HighlightBox[] = [];
    if (overlayEnabled) {
      for (const action of (arenaState?.actions ?? []).slice(0, 300)) {
        if (!action.visible) continue;
        boxes.push({ ...action.rect, tone: TYPE_TONES[action.type] });
      }
    }
    if (resolvedHovered !== null) {
      boxes.push({ ...resolvedHovered.rect, label: resolvedHovered.label, tone: TYPE_TONES[resolvedHovered.type], primary: true });
    }
    void transport.highlight(sessionId, boxes).catch(() => undefined);
  }, [arenaState, currentStateId, overlayEnabled, resolvedHovered, selectedStateId, sessionId]);
  const displayUrl = confirmedUrl || arenaState?.url || '';
  return <main className="app-shell">
    <form className="app-header" onSubmit={handleLoad}><div className="brand"><span className="brand-mark" aria-hidden="true">N</span><span><strong>Nexus</strong><small>DOM Extractor</small></span></div><label className="url-field"><span className="globe" aria-hidden="true">◎</span><span className="sr-only">Website URL</span><input type="text" inputMode="url" value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} placeholder="https://www.saucedemo.com/" autoComplete="url" spellCheck={false} /></label><div className="header-actions"><button className="reset-history-button" type="button" onClick={() => void handleResetHistory()} disabled={sessionId === null || loading || resettingHistory} title="Clear both histories and use the current page as the initial state, without reloading"><span aria-hidden="true">↺</span>{resettingHistory ? 'Resetting…' : 'Reset history'}</button><button className="load-button" type="submit" disabled={loading || resettingHistory || draftUrl.trim().length === 0}><span className={loading ? 'button-spinner' : 'refresh-icon'} aria-hidden="true" />{loading ? 'Extracting…' : 'Load & Extract'}</button></div></form>
    {appError !== null && <div className="app-alert" role="alert"><strong>Extraction failed</strong><span>{appError}</span><button type="button" onClick={() => setAppError(null)} aria-label="Dismiss error">×</button></div>}
    <div className="workspace"><DiscoveredPanel states={states} currentStateId={currentStateId} expandedStateId={expandedStateId} selectedStateId={selectedStateId} captureProgress={captureProgress} onSelect={selectState} onHoverAction={(action) => setHovered(action === null || selectedStateId !== currentStateId ? null : targetForAction(action))} onHoverObservable={(observable) => setHovered(observable === null || selectedStateId !== currentStateId ? null : targetForObservable(observable))} onHoverTarget={(target) => setHovered(target === null || selectedStateId !== currentStateId ? null : target)} /><BrowserArena sessionId={sessionId} url={displayUrl} frame={frame} connection={connection} activeState={arenaState} hovered={resolvedHovered} overlayEnabled={overlayEnabled} onOverlayChange={setOverlayEnabled} onInput={sendInput} inputError={inputError} /><ActivityPanel events={activity} states={states} selectedStateId={selectedStateId} onSelectState={(stateId) => { setSelectedStateId(stateId); setExpandedStateId(stateId); }} /></div>
  </main>;
}
