import type {
  Action,
  Collection,
  Group,
  Observable,
  StateArtifact,
} from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import {
  buildComponentTree,
  buildNavigationGraph,
  componentPathForRef,
  componentPathIndex,
} from '../src/index.js';

function action(
  id: string,
  label: string,
  region: string,
  options: Partial<Action> = {},
): Action {
  return {
    id,
    stableId: `stable-${id}`,
    label,
    type: 'button',
    kind: 'unknown',
    risk: 'safe',
    confidence: 1,
    evidence: ['native_tag'],
    state: { disabled: false },
    visible: true,
    inViewport: true,
    hitTestable: true,
    occludedBy: null,
    region,
    frame: 'main',
    shadowPath: [],
    rect: { x: 0, y: 0, w: 10, h: 10 },
    locators: [{ kind: 'structural', value: `#${id}`, frame: 'main', shadowPath: [] }],
    ...options,
  };
}

function group(
  id: string,
  label: string,
  kind: Group['kind'],
  options: Partial<Group> = {},
): Group {
  return {
    id,
    label,
    kind,
    global: false,
    conditional: false,
    actions: [],
    observables: [],
    frame: 'main',
    shadowPath: [],
    ...options,
  };
}

function artifactFixture(): StateArtifact {
  const actions = [
    action('btn1', 'Account menu', 'g-header', { kind: 'open' }),
    action('lnk1', 'Logout', 'g-menu', {
      type: 'navigation',
      parentAction: 'btn1',
      visible: false,
      inViewport: false,
      hitTestable: false,
    }),
    action('lnk2', 'Bike Light', 'g-main', {
      type: 'navigation',
      kind: 'navigate',
      collection: { id: 'col1', itemKey: 'row-bike', anchor: 'Bike Light' },
    }),
    action('btn2', 'Add to cart', 'g-main', {
      risk: 'mutating',
      collection: { id: 'col1', itemKey: 'row-bike', anchor: 'Bike Light' },
    }),
    action('btn3', 'Orphan command', 'missing'),
  ];
  const observables: Observable[] = [{
    id: 'obs1',
    stableId: 'stable-obs1',
    kind: 'value_display',
    label: 'Price',
    valueType: 'currency',
    currentValue: '$9.99',
    region: 'g-main',
    frame: 'main',
    shadowPath: ['#catalog-shell'],
    rect: { x: 0, y: 0, w: 10, h: 10 },
    changedBy: [],
    collection: { id: 'col1', itemKey: 'row-bike', anchor: 'Bike Light' },
  }];
  const groups: Group[] = [
    group('g-page', 'Store', 'region'),
    group('g-header', 'Header', 'region', {
      global: true,
      parentGroup: 'g-page',
      actions: ['btn1'],
    }),
    // A page-local toolbar happens to be nested in global chrome in the DOM.
    group('g-toolbar', 'Product sort', 'toolbar', { parentGroup: 'g-header' }),
    group('g-main', 'Inventory', 'main', {
      parentGroup: 'g-page',
      actions: ['lnk2', 'btn2'],
      observables: ['obs1'],
    }),
    group('g-menu', 'Account choices', 'menu', {
      conditional: true,
      parentGroup: 'g-header',
      parentAction: 'btn1',
      actions: ['lnk1'],
    }),
    group('g-collection', 'Inventory', 'collection', {
      parentGroup: 'g-main',
      actions: ['lnk2', 'btn2'],
      observables: ['obs1'],
    }),
  ];
  const collections: Collection[] = [{
    id: 'col1',
    groupId: 'g-collection',
    label: 'Inventory',
    templateId: 'stable-col1',
    anchorField: { relPath: 'h2', entropy: 1, stability: 'high', type: 'text' },
    instancesObserved: 1,
    instancesDeclared: 1,
    traversal: 'static',
    itemActions: [],
    itemObservables: [],
    anchors: ['Bike Light'],
    frame: 'main',
    shadowPath: ['#catalog-shell'],
    rows: [{
      rowKey: 'row-bike',
      anchor: 'Bike Light',
      rect: { x: 0, y: 0, w: 20, h: 20 },
      anchorActionId: 'lnk2',
      cells: [
        {
          column: 'Action',
          type: 'action',
          value: 'Add to cart',
          rect: { x: 0, y: 0, w: 10, h: 10 },
          actionId: 'btn2',
        },
        {
          column: 'Price',
          type: 'observable',
          value: '$9.99',
          rect: { x: 0, y: 0, w: 10, h: 10 },
          observableId: 'obs1',
        },
      ],
    }],
  }];
  const artifact: StateArtifact = {
    schemaVersion: 1,
    stateId: 'state-one',
    url: 'https://store.test/inventory?sort=az',
    routeTemplate: 'https://store.test/inventory?sort=az',
    title: 'Store',
    personaId: 'user',
    buildId: 'test',
    capturedAt: '2026-08-21T00:00:00.000Z',
    timings: {},
    groups,
    actions,
    observables,
    collections,
    warnings: [],
  };
  actions[0]!.observedDestination = 'https://store.test/account';
  artifact.navigationGraph = buildNavigationGraph(artifact);
  return artifact;
}

function parentIndex(tree: ReturnType<typeof buildComponentTree>): Map<string, string> {
  return new Map(tree.nodes.flatMap((node) => node.children.map((child) => [child, node.id])));
}

describe('canonical component tree', () => {
  it('owns every executable/value/collection exactly once without duplicating legacy groups', () => {
    const artifact = artifactFixture();
    const tree = buildComponentTree(artifact);
    const parent = parentIndex(tree);
    const allChildren = tree.nodes.flatMap(({ children }) => children);

    expect(new Set(allChildren).size).toBe(allChildren.length);
    for (const ref of [
      ...artifact.actions.map(({ id }) => id),
      ...artifact.observables.map(({ id }) => id),
      ...artifact.collections.map(({ id }) => id),
    ]) {
      expect(allChildren.filter((child) => child === ref), ref).toHaveLength(1);
    }
    expect(tree.nodes.some(({ id }) => id === 'g-collection')).toBe(false);

    const item = tree.nodes.find(({ kind, anchor }) => kind === 'item' && anchor === 'Bike Light');
    expect(item).toBeDefined();
    expect(parent.get('lnk2')).toBe(item?.id);
    expect(parent.get('btn2')).toBe(item?.id);
    expect(parent.get('obs1')).toBe(item?.id);
    expect(parent.get(item?.id ?? '')).toBe('col1');
    expect(parent.get('col1')).toBe('g-main');

    // Conditional component ownership is primary containment; reveal remains
    // a non-containment annotation and cannot introduce a second parent.
    expect(parent.get('g-menu')).toBe('btn1');
    expect(parent.get('lnk1')).toBe('g-menu');
    expect(tree.relations).toContainEqual(expect.objectContaining({
      kind: 'navigates',
      from: 'btn1',
      destination: 'https://store.test/account',
    }));

    // Global chrome must not absorb ordinary page-local components merely due
    // to an unfortunate DOM wrapper.
    expect(parent.get('g-toolbar')).toBe(tree.root);

    const other = tree.nodes.filter(({ label }) => label === 'Other');
    expect(other).toHaveLength(1);
    expect(parent.get('btn3')).toBe(other[0]?.id);
  });

  it('provides compact semantic breadcrumbs while retaining action ids as leaf ids', () => {
    const artifact = artifactFixture();
    artifact.componentTree = buildComponentTree(artifact);

    expect(componentPathForRef(artifact, 'lnk1')).toEqual([
      'Header',
      'Account menu',
      'Account choices',
      'Logout',
    ]);
    expect(componentPathForRef(artifact, 'btn2')).toEqual([
      'Inventory',
      'Bike Light',
      'Add to cart',
    ]);
    expect(componentPathIndex(artifact).get('btn2')).toEqual(
      componentPathForRef(artifact, 'btn2'),
    );
    expect(artifact.componentTree.nodes.find(({ id }) => id === 'btn2')?.ref)
      .toEqual({ kind: 'action', id: 'btn2' });
  });

  it('names duplicate row keys uniquely across shadow-scoped collections', () => {
    const artifact = artifactFixture();
    artifact.groups.push(group('g-collection-two', 'Inventory', 'collection', {
      parentGroup: 'g-main',
      frame: 'main',
      shadowPath: ['#second-catalog'],
    }));
    const first = artifact.collections[0] as Collection;
    artifact.collections.push({
      ...first,
      id: 'col2',
      groupId: 'g-collection-two',
      templateId: 'stable-col2',
      shadowPath: ['#second-catalog'],
      rows: (first.rows ?? []).map(({ anchorActionId: _anchorActionId, ...row }) => ({
        ...row,
        cells: row.cells.filter(({ type }) => type === 'text'),
      })),
    });

    const tree = buildComponentTree(artifact);
    const items = tree.nodes.filter(({ kind, anchor }) =>
      kind === 'item' && anchor === 'Bike Light',
    );
    expect(items).toHaveLength(2);
    expect(new Set(items.map(({ stableId }) => stableId)).size).toBe(2);
    expect(items.map(({ scope }) => scope.shadowPath)).toEqual(expect.arrayContaining([
      ['#catalog-shell'],
      ['#second-catalog'],
    ]));
  });

  it('collapses an identical single-child structural wrapper without losing its contents', () => {
    const artifact = artifactFixture();
    const main = artifact.groups.find(({ id }) => id === 'g-main') as Group;
    main.label = 'Inventory container';
    main.actions = [];
    main.observables = [];
    artifact.groups.push(group('g-inventory-region', '  INVENTORY   container ', 'region', {
      parentGroup: main.id,
      actions: ['lnk2', 'btn2', 'btn4'],
      observables: ['obs1'],
    }));
    const collectionGroup = artifact.groups.find(({ id }) => id === 'g-collection') as Group;
    collectionGroup.parentGroup = 'g-inventory-region';
    for (const member of artifact.actions.filter(({ id }) => id === 'lnk2' || id === 'btn2')) {
      member.region = 'g-inventory-region';
    }
    const price = artifact.observables.find(({ id }) => id === 'obs1') as Observable;
    price.region = 'g-inventory-region';
    artifact.actions.push(action('btn4', 'Filter inventory', 'g-inventory-region'));

    const tree = buildComponentTree(artifact);
    const parent = parentIndex(tree);
    const labels = componentPathForRef({ ...artifact, componentTree: tree }, 'btn2');

    expect(tree.nodes.some(({ id }) => id === 'g-inventory-region')).toBe(false);
    expect(tree.nodes.filter(({ label }) => label.trim().toLocaleLowerCase() === 'inventory container'))
      .toHaveLength(1);
    expect(parent.get('col1')).toBe('g-main');
    expect(parent.get('btn4')).toBe('g-main');
    expect(labels).toEqual([
      'Inventory container',
      'Inventory',
      'Bike Light',
      'Add to cart',
    ]);
  });
});
