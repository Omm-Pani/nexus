import type { StateArtifact } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import { mergePresentationGeometry } from '../src/index.js';

function artifact(): StateArtifact {
  return {
    schemaVersion: 1,
    stateId: 'same-state',
    url: 'https://example.test/items',
    routeTemplate: 'https://example.test/items',
    title: 'Items',
    personaId: 'default',
    buildId: 'retained-build',
    capturedAt: '2026-08-20T00:00:00.000Z',
    timings: { total: 10 },
    groups: [{
      id: 'g-retained',
      label: 'Items',
      kind: 'main',
      global: false,
      conditional: false,
      actions: ['e-retained'],
      observables: ['o-retained'],
    }],
    actions: [{
      id: 'e-retained',
      stableId: 'stable-action',
      label: 'Open Acme',
      type: 'navigation',
      kind: 'navigate',
      risk: 'safe',
      confidence: 1,
      evidence: ['native_tag'],
      state: { disabled: false },
      visible: true,
      inViewport: true,
      hitTestable: true,
      occludedBy: null,
      region: 'g-retained',
      frame: 'main',
      shadowPath: [],
      rect: { x: 1, y: 2, w: 100, h: 20 },
      locators: [{
        kind: 'testid',
        value: 'retained-locator',
        frame: 'main',
        shadowPath: [],
      }],
    }],
    observables: [{
      id: 'o-retained',
      stableId: 'stable-observable',
      kind: 'status',
      label: 'Availability',
      valueType: 'text',
      currentValue: 'Ready',
      region: 'g-retained',
      frame: 'main',
      rect: { x: 2, y: 3, w: 80, h: 18 },
      changedBy: [],
    }],
    collections: [{
      id: 'c-retained',
      groupId: 'g-retained',
      label: 'Items',
      templateId: 'items-template',
      anchorField: { relPath: 'h3', entropy: 1, stability: 'high', type: 'text' },
      instancesObserved: 2,
      instancesDeclared: 2,
      traversal: 'static',
      itemActions: [{ label: 'Open item', kind: 'navigate', risk: 'safe', relPath: 'a' }],
      itemObservables: [],
      anchors: ['Acme', 'Beta'],
      rows: [
        {
          rowKey: 'retained-row-acme',
          anchor: 'Acme',
          anchorActionId: 'e-retained',
          rect: { x: 3, y: 4, w: 200, h: 40 },
          cells: [
            {
              column: 'Status',
              type: 'observable',
              value: 'Ready',
              observableId: 'o-retained',
              rect: { x: 4, y: 5, w: 60, h: 20 },
            },
            {
              column: 'Tag',
              type: 'text',
              value: 'Same',
              rect: { x: 5, y: 6, w: 50, h: 20 },
            },
            {
              column: 'Tag',
              type: 'text',
              value: 'Same',
              rect: { x: 6, y: 7, w: 50, h: 20 },
            },
          ],
        },
        {
          rowKey: 'retained-row-beta',
          anchor: 'Beta',
          rect: { x: 7, y: 8, w: 200, h: 40 },
          cells: [],
        },
      ],
    }],
    warnings: [],
  };
}

describe('presentation geometry merge', () => {
  it('imports only semantic-occurrence rectangles into retained execution identities', () => {
    const retained = artifact();
    const scanned = structuredClone(retained);
    scanned.buildId = 'fresh-build';
    scanned.capturedAt = '2026-08-20T00:01:00.000Z';
    scanned.groups[0]!.id = 'g99';
    scanned.groups[0]!.actions = ['e99'];
    scanned.groups[0]!.observables = ['o99'];
    scanned.actions[0]!.id = 'e99';
    scanned.actions[0]!.region = 'g99';
    scanned.actions[0]!.rect = { x: 101, y: 102, w: 103, h: 104 };
    scanned.actions[0]!.locators = [{
      kind: 'structural', value: '#fresh-selector', frame: 'main', shadowPath: [],
    }];
    scanned.observables[0]!.id = 'o99';
    scanned.observables[0]!.region = 'g99';
    scanned.observables[0]!.rect = { x: 202, y: 203, w: 204, h: 205 };
    const scannedCollection = scanned.collections[0]!;
    scannedCollection.id = 'c99';
    scannedCollection.groupId = 'g99';
    // Reorder unique rows and retain duplicate semantic cells to prove that
    // matching does not depend on rowKey, array position, or local cell ids.
    scannedCollection.rows = [scannedCollection.rows![1]!, scannedCollection.rows![0]!];
    const scannedAcme = scannedCollection.rows[1]!;
    scannedAcme.rowKey = 'fresh-row-key';
    scannedAcme.anchorActionId = 'e99';
    scannedAcme.rect = { x: 303, y: 304, w: 305, h: 306 };
    scannedAcme.cells[0]!.observableId = 'o99';
    scannedAcme.cells[0]!.rect = { x: 404, y: 405, w: 406, h: 407 };
    scannedAcme.cells[1]!.rect = { x: 501, y: 502, w: 503, h: 504 };
    scannedAcme.cells[2]!.rect = { x: 601, y: 602, w: 603, h: 604 };

    const result = mergePresentationGeometry(retained, scanned);
    const action = result.artifact.actions[0]!;
    const observable = result.artifact.observables[0]!;
    const row = result.artifact.collections[0]!.rows![0]!;

    expect(result.changed).toBe(true);
    expect(result.updatedRects).toBe(6);
    expect(action).toMatchObject({
      id: 'e-retained',
      region: 'g-retained',
      rect: scanned.actions[0]!.rect,
      locators: [{ value: 'retained-locator' }],
    });
    expect(observable).toMatchObject({
      id: 'o-retained',
      region: 'g-retained',
      rect: scanned.observables[0]!.rect,
    });
    expect(result.artifact).toMatchObject({
      buildId: 'retained-build',
      capturedAt: '2026-08-20T00:00:00.000Z',
      groups: [{ id: 'g-retained', actions: ['e-retained'], observables: ['o-retained'] }],
    });
    expect(row).toMatchObject({
      rowKey: 'retained-row-acme',
      anchorActionId: 'e-retained',
      rect: scannedAcme.rect,
      cells: [
        { observableId: 'o-retained', rect: scannedAcme.cells[0]!.rect },
        { rect: scannedAcme.cells[1]!.rect },
        { rect: scannedAcme.cells[2]!.rect },
      ],
    });
  });

  it('returns the retained object when no rectangle changed', () => {
    const retained = artifact();
    const scanned = structuredClone(retained);
    scanned.actions[0]!.id = 'renumbered';
    scanned.actions[0]!.locators = [];

    const result = mergePresentationGeometry(retained, scanned);
    expect(result).toMatchObject({ changed: false, updatedRects: 0 });
    expect(result.artifact).toBe(retained);
  });

  it('filters sub-pixel rendering jitter', () => {
    const retained = artifact();
    const scanned = structuredClone(retained);
    const rect = scanned.actions[0]!.rect;
    scanned.actions[0]!.rect = {
      x: rect.x + 0.2,
      y: rect.y - 0.2,
      w: rect.w + 0.2,
      h: rect.h - 0.2,
    };

    const result = mergePresentationGeometry(retained, scanned);
    expect(result).toMatchObject({ changed: false, updatedRects: 0 });
    expect(result.artifact).toBe(retained);
  });
});
