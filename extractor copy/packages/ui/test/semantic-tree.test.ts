import type { Action, Group } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import { buildActionForest, semanticRootGroups } from '../src/semantic-tree.js';

function action(id: string, label: string, parentAction?: string): Action {
  return {
    id,
    stableId: `stable-${id}`,
    type: 'input',
    kind: 'select',
    label,
    risk: 'reversible',
    confidence: 1,
    evidence: ['native_tag'],
    state: { disabled: false },
    frame: 'main',
    shadowPath: [],
    locator: { framePath: [], recipes: [] },
    rect: { x: 0, y: 0, w: 100, h: 30 },
    visible: parentAction === undefined,
    inViewport: parentAction === undefined,
    hitTestable: parentAction === undefined,
    occludedBy: null,
    region: 'g-sort',
    changedBy: [],
    ...(parentAction === undefined ? {} : { parentAction }),
  };
}

function group(id: string, label: string, kind: Group['kind'], parentGroup?: string): Group {
  return {
    id,
    label,
    kind,
    global: false,
    conditional: false,
    actions: [],
    observables: [],
    ...(parentGroup === undefined ? {} : { parentGroup }),
  };
}

describe('semantic element tree', () => {
  it('nests native choices under their owning sort control without duplicating them', () => {
    const entries = [
      action('sel1', 'Sort products'),
      action('sel2', 'Name (A to Z)', 'sel1'),
      action('sel3', 'Name (Z to A)', 'sel1'),
      action('sel4', 'Price (low to high)', 'sel1'),
    ];
    const forest = buildActionForest(entries.map(({ id }) => id), new Map(entries.map((item) => [item.id, item])));

    expect(forest).toHaveLength(1);
    expect(forest[0]?.action.label).toBe('Sort products');
    expect(forest[0]?.children.map(({ action: child }) => child.label)).toEqual([
      'Name (A to Z)',
      'Name (Z to A)',
      'Price (low to high)',
    ]);
  });

  it('lifts only the duplicate document-title wrapper and retains semantic landmarks', () => {
    const groups = [
      group('g-page', 'Swag Labs', 'region'),
      group('g-header', 'Header', 'region', 'g-page'),
      group('g-main', 'Products', 'main', 'g-page'),
      group('g-inventory', 'Inventory list', 'region', 'g-main'),
    ];

    expect(semanticRootGroups(groups, 'Swag Labs', new Set()).map(({ group: item }) => item.id)).toEqual([
      'g-header',
      'g-main',
    ]);
    expect(semanticRootGroups(groups, 'A different page', new Set()).map(({ group: item }) => item.id)).toEqual(['g-page']);
  });

  it('keeps root-owned overlays or loose controls as a sibling without swallowing landmarks', () => {
    const page = {
      ...group('g-page', 'SaaS workspace', 'region'),
      actions: ['btn-cookie'],
    };
    const groups = [
      page,
      group('g-header', 'Header', 'region', 'g-page'),
      group('g-main', 'Dashboard', 'main', 'g-page'),
    ];

    const roots = semanticRootGroups(groups, 'SaaS workspace', new Set(['g-page']));
    expect(roots.map(({ group: item }) => [item.id, item.label])).toEqual([
      ['g-header', 'Header'],
      ['g-main', 'Dashboard'],
      ['g-page::other', 'Other page elements'],
    ]);
    expect(roots[2]).toMatchObject({ sourceGroupId: 'g-page', includeChildren: false });
    expect(roots[2]?.group.actions).toEqual(['btn-cookie']);
  });
});
