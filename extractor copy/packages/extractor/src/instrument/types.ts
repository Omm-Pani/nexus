import type {
  ActionKind,
  ElementType,
  EvidenceSignal,
  RiskLevel,
} from '@nexus/schema';

export interface RawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawLocatorSeed {
  testId: string | null;
  associatedLabel: string | null;
  placeholder: string | null;
  structural: string;
}

export interface RawAction {
  nodeKey: string;
  order: number;
  depth: number;
  label: string;
  tag: string;
  role: string;
  /** Normalized HTML input type; null for non-input elements. */
  inputType: string | null;
  type: ElementType;
  kind: ActionKind;
  risk: RiskLevel;
  confidence: number;
  evidence: EvidenceSignal[];
  state: {
    disabled: boolean;
    expanded: boolean | null;
    checked: boolean | null;
    selected: boolean | null;
    pressed: boolean | null;
    readonly: boolean | null;
    required: boolean | null;
  };
  value: string | null;
  placeholder: string | null;
  visible: boolean;
  inViewport: boolean;
  hitTestable: boolean;
  occludedBy: string | null;
  regionKey: string;
  shadowPath: string[];
  rect: RawRect;
  locator: RawLocatorSeed;
  controlsId: string | null;
  observedDestination: string | null;
  ancestorIds: string[];
  collectionKey: string | null;
  /** Stable identity of the concrete repeated member that owns this action. */
  collectionMemberKey: string | null;
  anchor: string | null;
  relPath: string | null;
  /**
   * nodeKey of the owning <select> when this action is one of its options.
   * Options are enumerated from the select rather than discovered by the walk.
   */
  optionOfKey: string | null;
}

export interface RawObservable {
  nodeKey: string;
  order: number;
  label: string;
  kind: 'live_region' | 'value_display' | 'validation' | 'status' | 'count';
  valueType: 'currency' | 'number' | 'percent' | 'date' | 'text' | 'count';
  currentValue: string;
  regionKey: string;
  shadowPath: string[];
  rect: RawRect;
  collectionKey: string | null;
  /** Stable identity of the concrete repeated member that owns this value. */
  collectionMemberKey: string | null;
  anchor: string | null;
  relPath: string | null;
}

export interface RawRegion {
  key: string;
  order: number;
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
    | 'form';
  global: boolean;
  conditional: boolean;
  parentKey: string | null;
  controlledBy: string | null;
  shadowPath: string[];
}

export interface RawCollection {
  key: string;
  order: number;
  /** Semantic region owning the repeated container, even when every row is static. */
  parentRegionKey: string;
  shadowPath: string[];
  label: string;
  instancesObserved: number;
  instancesDeclared: number;
  traversal: 'static' | 'paginated' | 'virtualized_scroll';
  scrollContainer: string | null;
  anchorRelPath: string;
  anchorEntropy: number;
  anchorStability: 'high' | 'low';
  anchorType: 'text' | 'attribute' | 'state';
  anchors: string[];
  memberKeys: string[];
  rows: RawCollectionRow[];
}

/**
 * One concrete member of a repeated collection. Collection templates describe
 * what every member normally contains; rows retain the instance geometry and
 * node linkage needed to highlight and operate a particular object.
 */
export interface RawCollectionRow {
  rowKey: string;
  anchor: string;
  rect: RawRect;
  anchorActionNodeKey: string | null;
  cells: RawCollectionCell[];
}

export interface RawCollectionCell {
  column: string;
  type: 'action' | 'observable' | 'text' | 'image';
  value: string;
  rect: RawRect;
  actionNodeKey: string | null;
  observableNodeKey: string | null;
}

export interface RawWarning {
  code:
    | 'truncated_walk'
    | 'shadow_root_unreachable'
    | 'low_stability_anchor'
    | 'quiescence_timeout'
    | 'occluded'
    | 'collection_rejected'
    | 'unknown_collection_size';
  detail: string;
  ref: string | null;
}

export interface RawFrameResult {
  framePath: string;
  url: string;
  title: string;
  documentShape: string;
  actions: RawAction[];
  observables: RawObservable[];
  regions: RawRegion[];
  collections: RawCollection[];
  warnings: RawWarning[];
  stats: {
    nodesVisited: number;
    walkMs: number;
  };
}

export type NexusMaterialCause =
  | 'initial'
  | 'dom'
  | 'shadow'
  | 'value'
  | 'history'
  | 'scroll'
  | 'interaction';

export interface NexusSemanticSurface {
  digest: string;
  /** Quantized action/observable viewport geometry; contains no page text. */
  presentationDigest: string;
  actions: number;
  observables: number;
  regions: number;
}

export interface NexusQuiescence {
  settled: boolean;
  inflight: number;
  msSinceLastMutation: number;
  msSinceLastActivity: number;
  epoch: number;
  causes: NexusMaterialCause[];
}

export interface NexusSettledNotification extends NexusQuiescence {
  surface: NexusSemanticSurface;
}
