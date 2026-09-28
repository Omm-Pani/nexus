import type { Action, Collection } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import {
  collectionCellColumn,
  collectionColumns,
  compactCollectionTable,
  isOperationalCollectionCell,
  visibleCollectionCells,
  type PresentedCollectionCell,
  type PresentedCollectionRow,
} from '../src/collection-table.js';

const rect = { x: 0, y: 0, w: 100, h: 20 };

function action(id: string, type: Action['type'], label: string): Action {
  return {
    id,
    stableId: `stable-${id}`,
    type,
    kind: type === 'navigation' ? 'navigate' : 'unknown',
    label,
    risk: 'reversible',
    confidence: 1,
    evidence: ['native_tag'],
    state: { disabled: false },
    frame: 'main',
    shadowPath: [],
    locators: [],
    rect,
    visible: true,
    inViewport: true,
    hitTestable: true,
    occludedBy: null,
    region: 'g-inventory',
  };
}

function cell(
  column: string,
  type: PresentedCollectionCell['type'],
  value: string,
  actionId?: string,
): PresentedCollectionCell {
  return { column, type, value, rect, ...(actionId === undefined ? {} : { actionId }) };
}

describe('collection table projection', () => {
  it('suppresses duplicate anchors, static prose, and decorative media', () => {
    const product = 'Sauce Labs Backpack';
    const actions = new Map([
      ['lnk1', action('lnk1', 'navigation', product)],
      ['lnk2', action('lnk2', 'navigation', product)],
      ['btn1', action('btn1', 'button', 'Add to cart')],
    ]);
    const row: PresentedCollectionRow = {
      rowKey: 'inventory:0',
      anchor: product,
      anchorActionId: 'lnk1',
      rect,
      cells: [
        cell('Title link', 'action', product, 'lnk1'),
        cell('Link', 'action', product, 'lnk2'),
        cell('Description', 'text', `Description for ${product}`),
        cell('Price', 'observable', '$29.99'),
        cell('Action', 'action', 'Add to cart', 'btn1'),
        cell('Image', 'image', product),
      ],
    };

    expect(visibleCollectionCells(row, actions).map(({ column }) => column)).toEqual([
      'Price',
      'Action',
    ]);
    expect(collectionColumns([row], actions)).toEqual(['Price', 'Action']);
  });

  it('turns legacy generic cell names into useful headers', () => {
    const actions = new Map<string, Action>();
    const row = {
      rowKey: 'row:0',
      anchor: 'Example',
      rect,
      cells: [],
    } satisfies NonNullable<Collection['rows']>[number];

    expect(collectionCellColumn(row, cell('Object', 'text', 'Detail'), actions)).toBe('Detail');
    expect(collectionCellColumn(row, cell('Item', 'action', 'Open'), actions)).toBe('Action');
  });

  it('prioritizes mutable and interactive fields while retaining concise business cells', () => {
    const actions = new Map<string, Action>();
    const row: PresentedCollectionRow = {
      rowKey: 'row:0',
      anchor: 'Example',
      rect,
      cells: [
        cell('Stock', 'text', 'Available'),
        cell('Action', 'action', 'Add'),
        cell('Price', 'observable', '$10.00'),
        cell('Image', 'image', 'Example'),
        cell('Rating', 'text', '4.8'),
        cell('Description', 'text', 'Example description'),
      ],
    };

    expect(collectionColumns([row], actions)).toEqual([
      'Price',
      'Stock',
      'Rating',
      'Action',
    ]);
  });

  it('keeps SaaS table fields but rejects narrative text by default', () => {
    expect(isOperationalCollectionCell(cell('Email', 'text', 'person@example.test'))).toBe(true);
    expect(isOperationalCollectionCell(cell('Role', 'text', 'Administrator'))).toBe(true);
    expect(isOperationalCollectionCell(cell('Status', 'text', 'Active'))).toBe(true);
    expect(isOperationalCollectionCell(cell('About', 'text', 'Long profile prose'))).toBe(false);
    expect(isOperationalCollectionCell(cell('Notes', 'text', 'Internal prose'))).toBe(false);
    expect(isOperationalCollectionCell(cell('Product card Description', 'observable', 'Changing promotional copy'))).toBe(false);
    expect(isOperationalCollectionCell(cell('Content status', 'observable', 'Published'))).toBe(true);
    expect(isOperationalCollectionCell(cell('Description', 'action', 'Edit description', 'btn1'))).toBe(true);
    expect(isOperationalCollectionCell(cell('Avatar', 'image', 'Person'))).toBe(false);
  });

  it('fits the common object-value-action table without hiding its columns', () => {
    expect(compactCollectionTable(['Price', 'Action'])).toBe(true);
    expect(compactCollectionTable(['Status', 'Role', 'Email'])).toBe(false);
  });
});
