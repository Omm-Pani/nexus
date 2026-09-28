import { createHash } from 'node:crypto';

/**
 * Produce the canonical address used as the page part of a state identity.
 *
 * This is deliberately an address, not a route template. Two records at
 * `/users/1` and `/users/2` are different pages from the operator's point of
 * view, and two origins must never be able to produce the same state id. Query
 * ordering, repeated values, and fragments are retained exactly as the URL
 * parser serializes them. An application may treat parameter order as
 * meaningful, and the page-history UI uses the same exact-address contract.
 */
export function normalizeRoute(input: string): string {
  try {
    const url = new URL(input);
    const pathname = url.pathname || '/';
    return `${url.origin}${pathname}${url.search}${url.hash}`;
  } catch {
    return input;
  }
}

export function stableHash(...parts: Array<string | number | boolean>): string {
  return createHash('sha256')
    .update(parts.map(String).join('\n'))
    .digest('hex');
}

function normalizeOverlayLabel(label: string): string {
  return label
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/gu, ' ');
}

export function fingerprintState(input: {
  routeTemplate: string;
  overlayStack: string[];
  primaryRegionShape: string;
  actionVocabulary: string[];
  /** Stable labels of active semantic regions (form/main/tab/dialog/menu). */
  viewContext?: string[];
  personaId: string;
}): string {
  const structuralRoleNames = new Set([
    'alertdialog', 'complementary', 'dialog', 'form', 'grid', 'listbox', 'menu',
    'menubar', 'navigation', 'tablist', 'table', 'tree', 'treegrid',
  ]);
  const structuralTagNames = new Set(['dialog', 'form', 'menu', 'nav', 'table']);
  const structuralRoles = new Map<string, number>();
  for (const token of input.primaryRegionShape.split('|')) {
    const separator = token.lastIndexOf(':');
    const tag = (separator === -1 ? token : token.slice(0, separator)).split(':').at(-1)?.trim().toLocaleLowerCase() ?? '';
    const role = (separator === -1 ? '' : token.slice(separator + 1)).trim().toLocaleLowerCase();
    const semantic = structuralRoleNames.has(role) ? role : structuralTagNames.has(tag) ? tag : '';
    if (semantic !== '') structuralRoles.set(semantic, (structuralRoles.get(semantic) ?? 0) + 1);
  }
  const coarseStructure = [...structuralRoles]
    .map(([key, count]) => `${key}:${count === 1 ? 'one' : 'many'}`)
    .sort()
    .join('|');
  return stableHash(
    'state-v2',
    input.routeTemplate,
    input.overlayStack.map(normalizeOverlayLabel).join('|'),
    coarseStructure,
    (input.viewContext ?? []).map(normalizeOverlayLabel).sort().join('|'),
    input.personaId,
  );
}
