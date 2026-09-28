import type { Action, Collection } from '@nexus/schema';

export type PresentedCollectionRow = NonNullable<Collection['rows']>[number];
export type PresentedCollectionCell = PresentedCollectionRow['cells'][number];

export function normalizedCollectionText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const LIKELY_MUTABLE_COLUMN = /(?:^|\s)(?:access|active|amount|assignee|balance|count|created|date|email|health|inventory|last active|owner|permission|phone|plan|price|progress|quantity|rating|region|role|state|status|stock|team|tier|total|updated|usage|version)(?:\s|$)/iu;
const NARRATIVE_COLUMN = /(?:^|\s)(?:about|bio|caption|content|desc|description|details?|excerpt|notes?|summary|subtitle)(?:\s|$)/iu;

function isNarrativeCollectionColumn(column: string): boolean {
  // Qualified implementation names such as "Product card description" are
  // still presentation prose. Do retain compound operational names such as
  // "Content status", where a live/business field is explicitly present.
  return NARRATIVE_COLUMN.test(column) && !LIKELY_MUTABLE_COLUMN.test(column);
}

/**
 * Collection tables are an operational view, not a visual transcription of
 * every card descendant. Static prose and decorative media make the important
 * controls/state harder to scan, especially in a narrow inspector.
 */
export function isOperationalCollectionCell(cell: PresentedCollectionCell): boolean {
  if (cell.type === 'image') return false;
  const column = normalizedCollectionText(cell.column);
  // A live-region classifier can legitimately mark changing card copy as an
  // observable. Its type does not make Description/Bio useful operational
  // state. Controls stay visible even when a legacy artifact gave one a
  // narrative-looking column name because interactivity takes precedence.
  if (cell.type !== 'action' && isNarrativeCollectionColumn(column)) return false;
  if (cell.type !== 'text') return true;
  // Long free-form text is overwhelmingly a card description, note, or bio.
  // Concise cells from real data tables (email, role, status, etc.) remain.
  return cell.value.trim().length <= 160;
}

export function collectionCellColumn(
  row: PresentedCollectionRow,
  cell: PresentedCollectionCell,
  actions: ReadonlyMap<string, Action>,
): string {
  if (!/^(?:item|object|anchor)$/iu.test(cell.column.trim())) return cell.column || 'Detail';
  const action = cell.actionId === undefined ? undefined : actions.get(cell.actionId);
  if (action !== undefined && (cell.actionId === row.anchorActionId || action.type === 'navigation')) return 'Link';
  return cell.type === 'action' ? 'Action' : 'Detail';
}

/**
 * The Object cell already represents the concrete row anchor. Repeating the
 * same navigation target as another cell produces multiple product-name
 * columns. The operational projection also omits static prose/decorative
 * media while retaining controls, observables, and concise business fields.
 */
export function visibleCollectionCells(
  row: PresentedCollectionRow,
  actions: ReadonlyMap<string, Action>,
): PresentedCollectionCell[] {
  const anchor = normalizedCollectionText(row.anchor);
  return row.cells.filter((cell) => {
    if (!isOperationalCollectionCell(cell)) return false;
    if (
      cell.actionId === undefined
      || anchor === ''
      || normalizedCollectionText(cell.value) !== anchor
    ) {
      return true;
    }
    const action = actions.get(cell.actionId);
    return cell.actionId !== row.anchorActionId && action?.type !== 'navigation';
  });
}

export function collectionColumns(
  rows: PresentedCollectionRow[],
  actions: ReadonlyMap<string, Action>,
): string[] {
  const cells = rows.flatMap((row) => visibleCollectionCells(row, actions).map((cell) => ({
    cell,
    column: collectionCellColumn(row, cell, actions),
  }))).filter(({ column }) => column !== '');
  const sourceOrder = [...new Set(cells.map(({ column }) => column))];
  const priority = (column: string): number => {
    const matching = cells.filter((candidate) => candidate.column === column);
    if (matching.some(({ cell }) => cell.type === 'observable')) return 0;
    if (LIKELY_MUTABLE_COLUMN.test(normalizedCollectionText(column))) return 1;
    if (matching.some(({ cell }) => cell.type === 'action')) return 2;
    return 3;
  };
  return sourceOrder
    .map((column, index) => ({ column, index, priority: priority(column) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ column }) => column);
}

/** Keep the common Object + Value + Action shape fully visible in narrow panels. */
export function compactCollectionTable(columns: readonly string[]): boolean {
  return columns.length <= 2;
}
