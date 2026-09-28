import type { Collection, Rect, StateArtifact } from '@nexus/schema';

type CollectionRow = NonNullable<Collection['rows']>[number];
type CollectionCell = CollectionRow['cells'][number];

export interface PresentationGeometryMerge {
  /** Retained artifact with only matched rectangle values refreshed. */
  artifact: StateArtifact;
  changed: boolean;
  updatedRects: number;
}

// DOMRect values commonly move by a tiny fraction of a CSS pixel as Chromium
// recomputes transforms and font metrics. Treat that as rendering jitter so a
// polling page cannot create an endless presentation-write/event loop.
const RECT_EPSILON_CSS_PX = 2;

function sameRect(left: Rect, right: Rect): boolean {
  return Math.abs(left.x - right.x) <= RECT_EPSILON_CSS_PX
    && Math.abs(left.y - right.y) <= RECT_EPSILON_CSS_PX
    && Math.abs(left.w - right.w) <= RECT_EPSILON_CSS_PX
    && Math.abs(left.h - right.h) <= RECT_EPSILON_CSS_PX;
}

function copyRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function semanticText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Index semantic occurrences without trusting capture-local ids or DOM paths.
 * Duplicate values remain addressable by their occurrence among equal keys.
 */
function occurrenceBuckets<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const bucket = buckets.get(key) ?? [];
    bucket.push(value);
    buckets.set(key, bucket);
  }
  return buckets;
}

/** Ignore ambiguous duplicate identifiers rather than applying geometry to the wrong object. */
function uniqueIndex<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T> {
  const indexed = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const value of values) {
    const key = keyFor(value);
    if (indexed.has(key)) {
      indexed.delete(key);
      ambiguous.add(key);
    } else if (!ambiguous.has(key)) {
      indexed.set(key, value);
    }
  }
  return indexed;
}

function rowKey(row: CollectionRow): string {
  return semanticText(row.anchor);
}

function cellKey(cell: CollectionCell): string {
  return `${semanticText(cell.column)}\u0000${cell.type}\u0000${semanticText(cell.value)}`;
}

/**
 * Refresh viewport geometry while preserving the retained element identities.
 *
 * A fresh scan is allowed to renumber local ids and synthesize different
 * locators even when its semantic digest is equal. Consequently this function
 * copies rectangles into the retained artifact instead of copying fresh
 * actions, rows, or cells wholesale.
 */
export function mergePresentationGeometry(
  retained: StateArtifact,
  scanned: StateArtifact,
): PresentationGeometryMerge {
  let updatedRects = 0;
  const refreshRect = (retainedRect: Rect, scannedRect: Rect | undefined): Rect => {
    if (scannedRect === undefined || sameRect(retainedRect, scannedRect)) return retainedRect;
    updatedRects += 1;
    return copyRect(scannedRect);
  };

  const scannedActions = uniqueIndex(scanned.actions, ({ stableId }) => stableId);
  const actions = retained.actions.map((action) => {
    const rect = refreshRect(action.rect, scannedActions.get(action.stableId)?.rect);
    return rect === action.rect ? action : { ...action, rect };
  });

  const scannedObservables = uniqueIndex(scanned.observables, ({ stableId }) => stableId);
  const observables = retained.observables.map((observable) => {
    const rect = refreshRect(
      observable.rect,
      scannedObservables.get(observable.stableId)?.rect,
    );
    return rect === observable.rect ? observable : { ...observable, rect };
  });

  const scannedCollections = uniqueIndex(scanned.collections, ({ templateId }) => templateId);
  const collections = retained.collections.map((collection) => {
    const scannedCollection = scannedCollections.get(collection.templateId);
    if (collection.rows === undefined || scannedCollection?.rows === undefined) return collection;
    const scannedRows = occurrenceBuckets(scannedCollection.rows, rowKey);
    const rowOccurrences = new Map<string, number>();
    let rowsChanged = false;
    const rows = collection.rows.map((row) => {
      const key = rowKey(row);
      const occurrence = rowOccurrences.get(key) ?? 0;
      rowOccurrences.set(key, occurrence + 1);
      const scannedRow = scannedRows.get(key)?.[occurrence];
      if (scannedRow === undefined) return row;

      const rect = refreshRect(row.rect, scannedRow.rect);
      const scannedCells = occurrenceBuckets(scannedRow.cells, cellKey);
      const cellOccurrences = new Map<string, number>();
      let cellsChanged = false;
      const cells = row.cells.map((cell) => {
        const key = cellKey(cell);
        const cellOccurrence = cellOccurrences.get(key) ?? 0;
        cellOccurrences.set(key, cellOccurrence + 1);
        const scannedCell = scannedCells.get(key)?.[cellOccurrence];
        const cellRect = refreshRect(cell.rect, scannedCell?.rect);
        if (cellRect === cell.rect) return cell;
        cellsChanged = true;
        return { ...cell, rect: cellRect };
      });
      if (rect === row.rect && !cellsChanged) return row;
      rowsChanged = true;
      return { ...row, rect, ...(cellsChanged ? { cells } : {}) };
    });
    return rowsChanged ? { ...collection, rows } : collection;
  });

  const scannedDom = new Map(scanned.dom?.flatMap((frame) => frame.elements).map((element) => [element.id, element]));
  const dom = retained.dom?.map((frame) => ({ ...frame, elements: frame.elements.map((element) => ({
    ...element, rect: refreshRect(element.rect, scannedDom.get(element.id)?.rect),
  })) }));

  if (updatedRects === 0) return { artifact: retained, changed: false, updatedRects: 0 };
  return {
    artifact: { ...retained, actions, observables, collections, ...(dom === undefined ? {} : { dom }) },
    changed: true,
    updatedRects,
  };
}
