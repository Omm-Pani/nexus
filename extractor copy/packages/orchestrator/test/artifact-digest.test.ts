import type { StateArtifact } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import { semanticArtifactDigest as desktopDigest } from '../../desktop/src/session.js';
import { artifactSemanticDigest as orchestratorDigest } from '../src/session-manager.js';

function artifact(): StateArtifact {
  return {
    schemaVersion: 1,
    stateId: 'state-a',
    url: 'https://example.test/customers',
    routeTemplate: 'https://example.test/customers',
    title: 'Customers',
    personaId: 'default',
    buildId: 'build-a',
    capturedAt: '2026-08-20T12:00:00.000Z',
    timings: { total: 12 },
    groups: [
      {
        id: 'g-main',
        label: 'Customers',
        kind: 'main',
        global: false,
        conditional: false,
        actions: ['e-parent', 'e-row'],
        observables: ['o-count'],
      },
      {
        id: 'g-collection',
        label: 'Customer list',
        kind: 'collection',
        global: false,
        conditional: false,
        parentGroup: 'g-main',
        parentAction: 'e-parent',
        actions: ['e-row'],
        observables: ['o-count'],
      },
    ],
    actions: [
      {
        id: 'e-parent',
        stableId: 'stable-parent',
        label: 'Customers menu',
        type: 'navigation',
        kind: 'navigate',
        risk: 'safe',
        confidence: 1,
        evidence: ['native_tag'],
        state: { disabled: false, expanded: true },
        visible: true,
        inViewport: true,
        hitTestable: true,
        occludedBy: null,
        region: 'g-main',
        frame: 'main/iframe:nth(1)',
        shadowPath: ['app-shell:nth(1)'],
        rect: { x: 10, y: 20, w: 100, h: 30 },
        locators: [{ kind: 'structural', value: 'nav > a:nth(1)', frame: 'main/iframe:nth(1)', shadowPath: [] }],
      },
      {
        id: 'e-row',
        stableId: 'stable-row',
        label: 'Acme',
        type: 'navigation',
        kind: 'navigate',
        risk: 'safe',
        confidence: 0.99,
        evidence: ['ax_role', 'native_tag'],
        state: { disabled: false },
        value: 'customer-1',
        visible: true,
        inViewport: true,
        hitTestable: true,
        occludedBy: null,
        region: 'g-collection',
        frame: 'main/iframe:nth(1)',
        shadowPath: ['app-shell:nth(1)'],
        rect: { x: 30, y: 70, w: 220, h: 48 },
        locators: [{ kind: 'structural', value: 'li:nth(1) > a', frame: 'main/iframe:nth(1)', shadowPath: [] }],
        parentAction: 'e-parent',
        observedDestination: 'https://example.test/customers/1',
      },
    ],
    observables: [{
      id: 'o-count',
      stableId: 'stable-count',
      kind: 'count',
      label: 'Customer count',
      valueType: 'count',
      currentValue: '1',
      region: 'g-collection',
      anchor: 'Acme',
      frame: 'main/iframe:nth(1)',
      rect: { x: 210, y: 80, w: 20, h: 20 },
      changedBy: ['stable-row'],
    }],
    collections: [{
      id: 'c1',
      groupId: 'g-collection',
      label: 'Customer list',
      templateId: 'customer-list-v1',
      anchorField: { relPath: ':scope > a', entropy: 1, stability: 'high', type: 'text' },
      instancesObserved: 1,
      instancesDeclared: 1,
      traversal: 'static',
      scrollContainer: 'main > ul:nth(1)',
      itemActions: [{ label: 'Customer link', kind: 'navigate', risk: 'safe', relPath: ':scope > a' }],
      itemObservables: [{ label: 'Customer count', valueType: 'count', relPath: ':scope > output' }],
      anchors: ['Acme'],
      rows: [{
        rowKey: 'main > ul:nth(1) > li:nth(1)',
        anchor: 'Acme',
        rect: { x: 20, y: 60, w: 240, h: 60 },
        anchorActionId: 'e-row',
        cells: [
          { column: 'Link', type: 'action', value: 'Acme', rect: { x: 30, y: 70, w: 180, h: 30 }, actionId: 'e-row' },
          { column: 'Count', type: 'observable', value: '1', rect: { x: 210, y: 80, w: 20, h: 20 }, observableId: 'o-count' },
          { column: 'Logo', type: 'image', value: 'Acme logo', rect: { x: 22, y: 65, w: 32, h: 32 } },
        ],
      }],
    }],
    warnings: [{
      code: 'truncated_walk',
      detail: 'Traversal stopped at 1000 nodes and depth 20.',
      ref: 'main/iframe:nth(1)',
    }],
  };
}

function renumberAndMove(source: StateArtifact): StateArtifact {
  const next = structuredClone(source);
  const [main, collection] = next.groups;
  if (main === undefined || collection === undefined) throw new Error('Missing groups');
  main.id = 'g90';
  main.actions = ['e90', 'e91'];
  main.observables = ['o90'];
  collection.id = 'g91';
  collection.parentGroup = 'g90';
  collection.parentAction = 'e90';
  collection.actions = ['e91'];
  collection.observables = ['o90'];
  next.groups.reverse();

  const parent = next.actions.find(({ stableId }) => stableId === 'stable-parent');
  const rowAction = next.actions.find(({ stableId }) => stableId === 'stable-row');
  if (parent === undefined || rowAction === undefined) throw new Error('Missing actions');
  parent.id = 'e90';
  parent.region = 'g90';
  parent.frame = 'main/iframe:nth(9)';
  parent.shadowPath = ['app-shell:nth(8)'];
  parent.rect = { x: 410, y: 320, w: 100, h: 30 };
  parent.locators = [{ kind: 'structural', value: 'nav > a:nth(9)', frame: 'main/iframe:nth(9)', shadowPath: [] }];
  rowAction.id = 'e91';
  rowAction.region = 'g91';
  rowAction.parentAction = 'e90';
  rowAction.frame = 'main/iframe:nth(9)';
  rowAction.shadowPath = ['app-shell:nth(8)'];
  rowAction.rect = { x: 430, y: 370, w: 220, h: 48 };
  rowAction.locators = [{ kind: 'structural', value: 'li:nth(9) > a', frame: 'main/iframe:nth(9)', shadowPath: [] }];
  next.actions.reverse();

  const observable = next.observables[0];
  if (observable === undefined) throw new Error('Missing observable');
  observable.id = 'o90';
  observable.region = 'g91';
  observable.frame = 'main/iframe:nth(9)';
  observable.rect = { x: 610, y: 380, w: 20, h: 20 };

  const repeated = next.collections[0];
  const repeatedRow = repeated?.rows?.[0];
  if (repeated === undefined || repeatedRow === undefined) throw new Error('Missing collection');
  repeated.id = 'c90';
  repeated.groupId = 'g91';
  repeated.anchorField.relPath = ':scope:nth(9) > a';
  repeated.scrollContainer = 'main > ul:nth(9)';
  repeated.itemActions[0]!.relPath = ':scope:nth(9) > a';
  repeated.itemObservables[0]!.relPath = ':scope:nth(9) > output';
  repeatedRow.rowKey = 'main > ul:nth(9) > li:nth(9)';
  repeatedRow.rect = { x: 420, y: 360, w: 240, h: 60 };
  repeatedRow.anchorActionId = 'e91';
  repeatedRow.cells[0]!.rect.x += 400;
  repeatedRow.cells[0]!.actionId = 'e91';
  repeatedRow.cells[1]!.rect.x += 400;
  repeatedRow.cells[1]!.observableId = 'o90';
  repeatedRow.cells[2]!.rect.x += 400;
  next.warnings[0]!.ref = 'main/iframe:nth(9)';
  return next;
}

const digests = [desktopDigest, orchestratorDigest] as const;

describe('semantic artifact digest parity', () => {
  it('ignores local renumbering, frame/selector numbering, and shifted geometry', () => {
    const baseline = artifact();
    const before = JSON.stringify(baseline);
    const presentationOnly = renumberAndMove(baseline);

    for (const digest of digests) expect(digest(presentationOnly)).toBe(digest(baseline));
    expect(desktopDigest(baseline)).toBe(orchestratorDigest(baseline));
    expect(desktopDigest(presentationOnly)).toBe(orchestratorDigest(presentationOnly));
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it.each([
    ['disabled state', (value: StateArtifact) => { value.actions[0]!.state.disabled = true; }],
    ['action value', (value: StateArtifact) => { value.actions[1]!.value = 'customer-2'; }],
    ['collection anchor', (value: StateArtifact) => { value.collections[0]!.anchors[0] = 'Globex'; }],
    ['row anchor', (value: StateArtifact) => { value.collections[0]!.rows![0]!.anchor = 'Globex'; }],
    ['cell value', (value: StateArtifact) => { value.collections[0]!.rows![0]!.cells[2]!.value = 'Globex logo'; }],
  ])('detects semantic %s changes', (_name, mutate) => {
    const baseline = artifact();
    const changed = structuredClone(baseline);
    mutate(changed);
    for (const digest of digests) expect(digest(changed)).not.toBe(digest(baseline));
    expect(desktopDigest(changed)).toBe(orchestratorDigest(changed));
  });
});
