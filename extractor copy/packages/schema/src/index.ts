export type ElementType =
  | 'navigation'
  | 'button'
  | 'input'
  | 'toggle'
  | 'text'
  | 'container'
  | 'observable';

/**
 * Public, state-local element identifiers exposed to decision engines.
 *
 * The prefix is deliberately semantic: it lets a constrained consumer infer
 * the available verbs without receiving a second type column. The numeric
 * suffix is one-based and is allocated independently per prefix in document
 * order for each state artifact.
 */
export const ACTION_ELEMENT_ID_PREFIXES = [
  'btn',
  'lnk',
  'inp',
  'pwd',
  'sel',
  'chk',
  'rad',
  'tog',
  'txt',
  'upl',
] as const;

export const ELEMENT_ID_PREFIXES = [
  ...ACTION_ELEMENT_ID_PREFIXES,
  'obs',
  'col',
] as const;

export type ActionElementIdPrefix = typeof ACTION_ELEMENT_ID_PREFIXES[number];
export type ElementIdPrefix = typeof ELEMENT_ID_PREFIXES[number];
export type ActionElementId = `${ActionElementIdPrefix}${number}`;
export type ObservableElementId = `obs${number}`;
export type CollectionElementId = `col${number}`;
export type TypePrefixedElementId =
  | ActionElementId
  | ObservableElementId
  | CollectionElementId;

/** IDs emitted by schemaVersion 1 artifacts before type-prefixed IDs landed. */
export type LegacyElementId = `e${number}` | `o${number}` | `c${number}`;

export interface ParsedElementId {
  prefix: ElementIdPrefix;
  index: number;
}

const ACTION_ELEMENT_ID_PREFIX_SET = new Set<string>(ACTION_ELEMENT_ID_PREFIXES);
const ELEMENT_ID_PREFIX_SET = new Set<string>(ELEMENT_ID_PREFIXES);
const TYPE_PREFIXED_ELEMENT_ID = /^([a-z]+)([1-9]\d*)$/u;
const LEGACY_ELEMENT_ID = /^(?:e|o|c)[1-9]\d*$/u;

/** Parse only the current public ID format; legacy `e1`/`o1`/`c1` returns null. */
export function parseElementId(value: string): ParsedElementId | null {
  const match = TYPE_PREFIXED_ELEMENT_ID.exec(value);
  if (match === null) return null;
  const prefix = match[1];
  const index = Number(match[2]);
  if (prefix === undefined || !ELEMENT_ID_PREFIX_SET.has(prefix) || !Number.isSafeInteger(index)) {
    return null;
  }
  return { prefix: prefix as ElementIdPrefix, index };
}

export function isTypePrefixedElementId(value: string): value is TypePrefixedElementId {
  return parseElementId(value) !== null;
}

export function isActionElementId(value: string): value is ActionElementId {
  const parsed = parseElementId(value);
  return parsed !== null && ACTION_ELEMENT_ID_PREFIX_SET.has(parsed.prefix);
}

/** Allows schemaVersion 1 readers to distinguish old persisted local IDs. */
export function isLegacyElementId(value: string): value is LegacyElementId {
  return LEGACY_ELEMENT_ID.test(value);
}

export type ActionKind =
  | 'navigate'
  | 'input'
  | 'select'
  | 'toggle'
  | 'open'
  | 'close'
  | 'expand'
  | 'collapse'
  | 'switch_tab'
  | 'submit'
  | 'upload'
  | 'unknown';

export type RiskLevel =
  | 'safe'
  | 'reversible'
  | 'mutating'
  | 'destructive'
  | 'unknown';

export type EvidenceSignal =
  | 'native_tag'
  | 'ax_role'
  | 'react_props'
  | 'listener_registry'
  | 'aria_role'
  | 'contenteditable'
  | 'inline_handler'
  | 'aria_controls'
  | 'cursor_pointer'
  | 'hover_css'
  | 'focusable';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Locator {
  kind: 'testid' | 'role_name' | 'label' | 'placeholder' | 'text' | 'structural';
  value: string;
  role?: string;
  name?: string;
  frame: string;
  shadowPath: string[];
}

export interface Action {
  /** Current artifacts use ActionElementId; string retains schemaVersion 1 readability. */
  id: string;
  stableId: string;
  label: string;
  type: ElementType;
  kind: ActionKind;
  risk: RiskLevel;
  confidence: number;
  evidence: EvidenceSignal[];
  state: {
    disabled: boolean;
    expanded?: boolean;
    checked?: boolean;
    selected?: boolean;
    pressed?: boolean;
    readonly?: boolean;
    required?: boolean;
  };
  value?: string;
  placeholder?: string;
  visible: boolean;
  inViewport: boolean;
  hitTestable: boolean;
  occludedBy: string | null;
  region: string;
  frame: string;
  shadowPath: string[];
  rect: Rect;
  locators: Locator[];
  parentAction?: string;
  observedDestination?: string;
  /** Historical reveal metadata retained for existing artifact readers. */
  discoveredVia?: Reveal;
  /**
   * Concrete repeated-object ownership. Optional for schemaVersion 1 readers;
   * current extractors populate it whenever this action belongs to a
   * Collection row. The action remains present exactly once in `actions`.
   */
  collection?: CollectionMembership;
}

/** Gesture labels used by descriptive reveal relationships. */
export type ObservedGesture = 'click' | 'hover' | 'focus' | 'arrow_down' | 'fill';

/**
 * How a control or value that is absent from the baseline document was made
 * observable. Recorded so a workflow can be replayed from the baseline state.
 */
export interface Reveal {
  /** stableId of the action whose gesture revealed the element. */
  triggerStableId: string;
  gesture: ObservedGesture;
  /** Human-readable trigger label, retained for report rendering. */
  triggerLabel: string;
  /**
   * Gestures that must be applied first, in order, before the trigger itself
   * is reachable. Empty when the trigger is present in the baseline document.
   * A submenu item carries the parent menu's gesture here, which is what makes
   * the finding replayable from a fresh page.
   */
  prerequisites: ObservedGestureStep[];
}

export interface ObservedGestureStep {
  triggerStableId: string;
  triggerLabel: string;
  gesture: ObservedGesture;
}

export interface Observable {
  /** Current artifacts use ObservableElementId; old persisted artifacts may use `oN`. */
  id: string;
  stableId: string;
  kind: 'live_region' | 'value_display' | 'validation' | 'status' | 'count';
  label: string;
  valueType: 'currency' | 'number' | 'percent' | 'date' | 'text' | 'count';
  currentValue: string;
  region: string;
  anchor?: string;
  frame: string;
  /** Retained shadow-host chain; absent on older schemaVersion 1 artifacts. */
  shadowPath?: string[];
  rect: Rect;
  changedBy: string[];
  /**
   * Present when the value only appears after a gesture (validation text,
   * success banners, values rendered into a portal).
   */
  discoveredVia?: Reveal;
  /**
   * Populated by differential capture: the value this observable held before
   * the first gesture that changed it. Absent for statically detected values.
   */
  baselineValue?: string;
  /** Concrete repeated-object ownership, when this value belongs to a row. */
  collection?: CollectionMembership;
}

export interface CollectionMembership {
  /** Existing local Collection.id. */
  id: string;
  /** Stable collection-member key retained by the extractor. */
  itemKey: string;
  /** Human-readable row/object anchor. */
  anchor: string;
}

export interface Group {
  id: string;
  label: string;
  kind:
    | 'region'
    | 'nav'
    | 'main'
    | 'toolbar'
    | 'dialog'
    | 'menu'
    | 'table'
    | 'list'
    | 'tabset'
    | 'form'
    | 'collection';
  global: boolean;
  conditional: boolean;
  parentAction?: string;
  parentGroup?: string;
  actions: string[];
  observables: string[];
  /** Explicit browsing-context scope; absent on persisted legacy artifacts. */
  frame?: string;
  /** Explicit shadow-host scope; absent on persisted legacy artifacts. */
  shadowPath?: string[];
}

export interface Collection {
  /** Current artifacts use CollectionElementId; old persisted artifacts may use `cN`. */
  id: string;
  /** Group containing this collection's concrete actions and observables. */
  groupId?: string;
  label: string;
  templateId: string;
  anchorField: {
    relPath: string;
    entropy: number;
    stability: 'high' | 'low';
    type: 'text' | 'attribute' | 'state';
  };
  instancesObserved: number;
  instancesDeclared: number;
  traversal: 'static' | 'paginated' | 'virtualized_scroll';
  scrollContainer?: string;
  itemActions: Array<{
    label: string;
    kind: ActionKind;
    risk: RiskLevel;
    relPath: string;
  }>;
  itemObservables: Array<{
    label: string;
    valueType: string;
    relPath: string;
  }>;
  anchors: string[];
  /**
   * Concrete repeated objects for table rendering and instance highlighting.
   * Kept optional so persisted schemaVersion 1 artifacts remain readable.
   */
  rows?: Array<{
    rowKey: string;
    anchor: string;
    rect: Rect;
    anchorActionId?: string;
    cells: Array<{
      column: string;
      type: 'action' | 'observable' | 'text' | 'image';
      value: string;
      rect: Rect;
      actionId?: string;
      observableId?: string;
    }>;
  }>;
  /** Explicit browsing-context scope; absent on persisted legacy artifacts. */
  frame?: string;
  /** Explicit shadow-host scope; absent on persisted legacy artifacts. */
  shadowPath?: string[];
}

/**
 * Canonical, reference-only component hierarchy for one captured page state.
 *
 * Actions keep their existing `btnN`/`lnkN`/... ids as control-node ids. This
 * avoids introducing a second identifier vocabulary for an execution model.
 * Every action, observable, and collection is contained exactly once. Reveal
 * and navigation relationships live in `relations`, never as second parents.
 */
export interface ComponentTree {
  root: string;
  nodes: ComponentTreeNode[];
  relations: ComponentTreeRelation[];
}

export type ComponentTreeNodeKind =
  | 'page'
  | 'landmark'
  | 'component'
  | 'collection'
  | 'item'
  | 'control'
  | 'observable';

export interface ComponentTreeScope {
  frame: string;
  shadowPath: string[];
}

export interface ComponentTreeNode {
  /** Existing ref id for controls/observables/collections/groups where possible. */
  id: string;
  /** Cross-capture identity; does not replace the local executable id. */
  stableId: string;
  kind: ComponentTreeNodeKind;
  label: string;
  ref?: {
    kind: 'state' | 'group' | 'collection' | 'collection_item' | 'action' | 'observable';
    id: string;
  };
  scope: ComponentTreeScope;
  availability: 'current' | 'conditional' | 'hidden';
  /** The sole containment relation. A node id may occur in only one children array. */
  children: string[];
  /** Row anchor on item nodes. */
  anchor?: string;
  /** Compact collection cardinality/traversal metadata on collection nodes. */
  instances?: {
    observed: number;
    declared: number;
    traversal: 'static' | 'paginated' | 'virtualized_scroll';
  };
}

export interface ComponentTreeRelation {
  from: string;
  kind: 'reveals' | 'navigates';
  /** Canonical node target for an in-state reveal. */
  to?: string;
  /** URL for a page/navigation edge. */
  destination?: string;
  gesture?: ObservedGesture;
  order?: number;
}

/**
 * A compact, reference-only interaction graph for the current page state.
 *
 * Labels, locators, rectangles, and control state deliberately remain on the
 * referenced StateArtifact records. This graph only normalizes containment and
 * reveal relationships so a planner does not have to reconstruct them from
 * parentGroup, parentAction, and discoveredVia independently.
 */
export interface NavigationGraph {
  /** Graph-local id of the current state node. */
  root: string;
  nodes: NavigationGraphNode[];
  edges: NavigationGraphEdge[];
}

export interface NavigationGraphNode {
  /** Graph-local, type-prefixed id (`s:`, `g:`, or `a:`). */
  id: string;
  kind: 'state' | 'group' | 'action';
  /** Existing stateId, Group.id, or Action.id in this artifact. */
  ref: string;
  availability: 'current' | 'conditional' | 'hidden';
}

export interface NavigationGraphEdge {
  from: string;
  to: string;
  kind: 'contains' | 'reveals';
  /** Gesture applied to `from` when this is a reveal edge. */
  gesture?: ObservedGesture;
  /** Zero-based position in the replay chain that produced the target. */
  order?: number;
}

export interface Warning {
  code:
    | 'truncated_walk'
    | 'shadow_root_unreachable'
    | 'low_stability_anchor'
    | 'ax_unavailable'
    | 'quiescence_timeout'
    | 'frame_inaccessible'
    | 'occluded'
    | 'collection_rejected'
    | 'unknown_collection_size';
  detail: string;
  ref?: string;
}

/** One actual DOM element, including hidden, structural and template content. */
export interface DomElement {
  id: string;
  documentId: string;
  parentId: string | null;
  frame: string;
  shadowPath: string[];
  depth: number;
  boundary: 'light' | 'shadow-open' | 'shadow-closed' | 'template';
  tag: string;
  namespace: string;
  selector: string;
  attributes: Record<string, string>;
  text: string;
  state: Record<string, string | number | boolean | null>;
  visible: boolean;
  rect: Rect;
  eventTypes: string[];
}

export interface DomSnapshot {
  documentId: string;
  frame: string;
  url: string;
  sequence: number;
  elements: DomElement[];
}

export interface DomObservation {
  /** Browser event responsible for synchronous effects, when known. */
  causeId?: string;
  documentId: string;
  sequence: number;
  timestamp: string;
  url: string;
  kind: 'interaction' | 'mutation' | 'property' | 'navigation' | 'gap';
  type: string;
  targetId: string | null;
  detail: Record<string, string | number | boolean | null>;
  added?: DomElement[];
  removed?: DomElement[];
}

export interface ObservationBatch {
  fromStateId: string | null;
  firstSequence: number;
  lastSequence: number;
  observations: DomObservation[];
}

export interface StateArtifact {
  schemaVersion: 1;
  dom?: DomSnapshot[];
  stateId: string;
  url: string;
  routeTemplate: string;
  title: string;
  personaId: string;
  buildId: string;
  capturedAt: string;
  timings: Record<string, number>;
  groups: Group[];
  actions: Action[];
  observables: Observable[];
  collections: Collection[];
  warnings: Warning[];
  /** Optional so persisted schemaVersion 1 artifacts remain readable. */
  navigationGraph?: NavigationGraph;
  /** Optional canonical hierarchy; persisted schemaVersion 1 remains readable. */
  componentTree?: ComponentTree;
}

export interface Transition {
  fromStateId: string;
  toStateId: string;
  trigger: {
    actionStableId: string;
    anchor?: string;
    verb: string;
  };
  transitionType:
    | 'navigation'
    | 'overlay_open'
    | 'overlay_close'
    | 'in_place_mutation'
    | 'wizard_advance';
  mutating: boolean;
  methods: string[];
  observed: Array<{
    observableStableId: string;
    from: string;
    to: string;
  }>;
  latencyMs: number;
}

export interface Candidate {
  id: string;
  label: string;
  type: ElementType;
  anchor?: string;
}

export type ExtractionPhase =
  | 'navigating'
  | 'injecting'
  | 'settling'
  | 'walking'
  | 'classifying'
  | 'grouping'
  | 'observing'
  | 'writing';

export interface ExtractionCounts {
  groups: number;
  actions: number;
  observables: number;
  collections: number;
  warnings: number;
}

export type OrchestratorEvent =
  | { t: 'extraction.started'; stateId: string; url: string }
  | { t: 'extraction.phase'; stateId: string; phase: ExtractionPhase }
  | {
      t: 'extraction.group';
      stateId: string;
      group: Group;
      actions: Action[];
      observables: Observable[];
    }
  | {
      t: 'extraction.completed';
      stateId: string;
      counts: ExtractionCounts;
      timings: Record<string, number>;
    }
  | { t: 'extraction.error'; stateId: string; message: string }
  | { t: 'extraction.warning'; stateId: string; warning: Warning }
  | {
      t: 'state.discovered';
      stateId: string;
      /** Exact destination URL. Optional only for persisted/legacy publishers. */
      url?: string;
      parentStateId: string;
      trigger: string;
      label: string;
    }
  /** Geometry changed without changing the executable semantic state. */
  | { t: 'state.presentation'; stateId: string }
  | { t: 'dom.observed'; batch: ObservationBatch }
  | { t: 'history.reset'; resetId: string; artifact: StateArtifact; throughSequence: number; timestamp: string }
  | { t: 'state.transition'; fromStateId: string | null; toStateId: string; firstSequence: number; lastSequence: number; trigger: string; timestamp?: string }
  | { t: 'frame'; data: string };
