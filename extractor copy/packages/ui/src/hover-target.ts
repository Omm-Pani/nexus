import type {
  Action,
  Collection,
  ElementType,
  Observable,
  Rect,
  StateArtifact,
} from '@nexus/schema';

type CollectionRow = NonNullable<Collection['rows']>[number];
type CollectionCell = CollectionRow['cells'][number];

/**
 * A semantic identity for the page object under the pointer.
 *
 * `rect` on HoverTarget is deliberately only a fallback. Presentation-only
 * scans retain execution ids while refreshing geometry, so highlights resolve
 * this key against the latest artifact on every render.
 */
export type HoverSourceKey =
  | { kind: 'action'; stableId: string }
  | { kind: 'observable'; stableId: string }
  | { kind: 'collection-row'; templateId: string; rowKey: string }
  | {
      kind: 'collection-cell';
      templateId: string;
      rowKey: string;
      semanticKey: string;
      occurrence: number;
    };

export interface HoverTarget {
  /** Last known geometry, used when the source is absent from a partial artifact. */
  rect: Rect;
  type: ElementType;
  label: string;
  sourceKey: HoverSourceKey;
}

type HoverGeometryState = Pick<StateArtifact, 'actions' | 'observables' | 'collections'>;

function semanticText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

export function collectionCellSemanticKey(cell: CollectionCell): string {
  return `${semanticText(cell.column)}\u0000${cell.type}\u0000${semanticText(cell.value)}`;
}

export function collectionCellSourceKey(
  templateId: string,
  row: CollectionRow,
  cell: CollectionCell,
): Extract<HoverSourceKey, { kind: 'collection-cell' }> {
  const semanticKey = collectionCellSemanticKey(cell);
  const cellIndex = row.cells.indexOf(cell);
  let occurrence = 0;
  for (let index = 0; index < (cellIndex < 0 ? 0 : cellIndex); index += 1) {
    const candidate = row.cells[index];
    if (candidate !== undefined && collectionCellSemanticKey(candidate) === semanticKey) {
      occurrence += 1;
    }
  }
  return { kind: 'collection-cell', templateId, rowKey: row.rowKey, semanticKey, occurrence };
}

function rectHasArea(rect: Rect): boolean {
  return rect.w > 0 && rect.h > 0;
}

/** Resolve a hover descriptor against the newest presentation geometry. */
export function resolveHoverTarget(
  target: HoverTarget,
  state: HoverGeometryState | null,
): HoverTarget {
  if (state === null) return target;

  const source = target.sourceKey;
  if (source.kind === 'action') {
    const action = state.actions.find(({ stableId }) => stableId === source.stableId);
    return action === undefined
      ? target
      : { ...target, rect: action.rect, type: action.type, label: action.label };
  }
  if (source.kind === 'observable') {
    const observable = state.observables.find(({ stableId }) => stableId === source.stableId);
    return observable === undefined
      ? target
      : { ...target, rect: observable.rect, type: 'observable', label: observable.label };
  }

  const collection = state.collections.find(({ templateId }) => templateId === source.templateId);
  const row = collection?.rows?.find(({ rowKey }) => rowKey === source.rowKey);
  if (row === undefined) return target;

  if (source.kind === 'collection-row') {
    const anchorAction = row.anchorActionId === undefined
      ? undefined
      : state.actions.find(({ id }) => id === row.anchorActionId);
    const rect = rectHasArea(row.rect) ? row.rect : anchorAction?.rect;
    return rect === undefined
      ? target
      : {
          ...target,
          rect,
          type: anchorAction?.type ?? 'container',
          label: row.anchor || target.label,
        };
  }

  const cell = row.cells
    .filter((candidate) => collectionCellSemanticKey(candidate) === source.semanticKey)
    [source.occurrence];
  if (cell === undefined) return target;
  const action = cell.actionId === undefined
    ? undefined
    : state.actions.find(({ id }) => id === cell.actionId);
  if (action !== undefined) {
    return { ...target, rect: action.rect, type: action.type, label: action.label };
  }
  const observable = cell.observableId === undefined
    ? undefined
    : state.observables.find(({ id }) => id === cell.observableId);
  if (observable !== undefined) {
    return {
      ...target,
      rect: observable.rect,
      type: 'observable',
      label: observable.label,
    };
  }
  return {
    ...target,
    rect: cell.rect,
    type: cell.type === 'observable'
      ? 'observable'
      : cell.type === 'text'
        ? 'text'
        : 'container',
    label: cell.value || cell.column || target.label,
  };
}

export function targetForAction(action: Action): HoverTarget {
  return {
    rect: action.rect,
    type: action.type,
    label: action.label,
    sourceKey: { kind: 'action', stableId: action.stableId },
  };
}

export function targetForObservable(observable: Observable): HoverTarget {
  return {
    rect: observable.rect,
    type: 'observable',
    label: observable.label,
    sourceKey: { kind: 'observable', stableId: observable.stableId },
  };
}
