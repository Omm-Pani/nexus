import type { Action, Collection, Observable, StateArtifact } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import {
  collectionCellSourceKey,
  resolveHoverTarget,
  targetForAction,
  targetForObservable,
  type HoverTarget,
} from '../src/hover-target.js';

function action(id: string, stableId: string, x: number): Action {
  return {
    id,
    stableId,
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
    region: 'g1',
    frame: 'main',
    shadowPath: [],
    rect: { x, y: 2, w: 100, h: 20 },
    locators: [],
  };
}

function observable(id: string, stableId: string, x: number): Observable {
  return {
    id,
    stableId,
    kind: 'status',
    label: 'Availability',
    valueType: 'text',
    currentValue: 'Ready',
    region: 'g1',
    frame: 'main',
    rect: { x, y: 3, w: 80, h: 18 },
    changedBy: [],
  };
}

function artifact(
  actions: Action[],
  observables: Observable[],
  collections: Collection[] = [],
): Pick<StateArtifact, 'actions' | 'observables' | 'collections'> {
  return { actions, observables, collections };
}

describe('hover target presentation resolution', () => {
  it('tracks actions and observables by stable id across local-id renumbering', () => {
    const oldAction = action('e1', 'action-stable', 1);
    const oldObservable = observable('o1', 'observable-stable', 2);
    const nextAction = action('e99', 'action-stable', 101);
    const nextObservable = observable('o99', 'observable-stable', 202);
    const next = artifact([nextAction], [nextObservable]);

    expect(resolveHoverTarget(targetForAction(oldAction), next).rect).toEqual(nextAction.rect);
    expect(resolveHoverTarget(targetForObservable(oldObservable), next).rect).toEqual(
      nextObservable.rect,
    );
  });

  it('tracks collection rows and duplicate static cells by semantic occurrence', () => {
    const retained: Collection = {
      id: 'c1',
      label: 'Inventory',
      templateId: 'inventory-template',
      anchorField: { relPath: 'h3', entropy: 1, stability: 'high', type: 'text' },
      instancesObserved: 1,
      instancesDeclared: 1,
      traversal: 'static',
      itemActions: [],
      itemObservables: [],
      anchors: ['Acme'],
      rows: [{
        rowKey: 'row-acme',
        anchor: 'Acme',
        rect: { x: 1, y: 2, w: 200, h: 40 },
        cells: [
          { column: 'Logo', type: 'image', value: 'Acme', rect: { x: 2, y: 3, w: 20, h: 20 } },
          { column: 'Logo', type: 'image', value: 'Acme', rect: { x: 4, y: 5, w: 20, h: 20 } },
        ],
      }],
    };
    const refreshed = structuredClone(retained);
    refreshed.rows![0]!.rect = { x: 101, y: 102, w: 200, h: 40 };
    refreshed.rows![0]!.cells[0]!.rect = { x: 202, y: 203, w: 20, h: 20 };
    refreshed.rows![0]!.cells[1]!.rect = { x: 304, y: 305, w: 20, h: 20 };

    const row = retained.rows![0]!;
    const rowTarget: HoverTarget = {
      rect: row.rect,
      type: 'container',
      label: row.anchor,
      sourceKey: {
        kind: 'collection-row',
        templateId: retained.templateId,
        rowKey: row.rowKey,
      },
    };
    const secondCell = row.cells[1]!;
    const cellTarget: HoverTarget = {
      rect: secondCell.rect,
      type: 'container',
      label: secondCell.value,
      sourceKey: collectionCellSourceKey(retained.templateId, row, secondCell),
    };
    const next = artifact([], [], [refreshed]);

    expect(resolveHoverTarget(rowTarget, next).rect).toEqual(refreshed.rows![0]!.rect);
    expect(resolveHoverTarget(cellTarget, next).rect).toEqual(
      refreshed.rows![0]!.cells[1]!.rect,
    );
  });

  it('retains the linked action semantics when a collection-cell key is resolved', () => {
    const linkedAction = action('e-current', 'linked-action', 404);
    linkedAction.label = 'Open customer';
    linkedAction.type = 'button';
    const collection: Collection = {
      id: 'c1',
      label: 'Customers',
      templateId: 'customers-template',
      anchorField: { relPath: 'h3', entropy: 1, stability: 'high', type: 'text' },
      instancesObserved: 1,
      instancesDeclared: 1,
      traversal: 'static',
      itemActions: [],
      itemObservables: [],
      anchors: ['Acme'],
      rows: [{
        rowKey: 'row-acme',
        anchor: 'Acme',
        rect: { x: 1, y: 2, w: 200, h: 40 },
        cells: [{
          column: 'Action',
          type: 'action',
          value: 'Open',
          rect: { x: 2, y: 3, w: 20, h: 20 },
          actionId: linkedAction.id,
        }],
      }],
    };
    const row = collection.rows![0]!;
    const cell = row.cells[0]!;
    const target: HoverTarget = {
      rect: cell.rect,
      type: 'container',
      label: cell.value,
      sourceKey: collectionCellSourceKey(collection.templateId, row, cell),
    };

    expect(resolveHoverTarget(target, artifact([linkedAction], [], [collection]))).toMatchObject({
      rect: linkedAction.rect,
      type: 'button',
      label: 'Open customer',
    });
  });

  it('keeps the last known rectangle when a partial artifact omits the source', () => {
    const target = targetForAction(action('e1', 'missing-action', 17));
    expect(resolveHoverTarget(target, artifact([], []))).toBe(target);
  });
});
