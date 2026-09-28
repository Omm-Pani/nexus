import { describe, expect, it } from 'vitest';

import type { ComponentTree, ComponentTreeNode } from '@nexus/schema';

import {
  componentTreeRenderOrder,
  normalizeComponentTree,
  projectComponentTree,
} from '../src/component-tree.js';

function node(
  id: string,
  kind: ComponentTreeNode['kind'],
  children: string[] = [],
): ComponentTreeNode {
  return {
    id,
    stableId: `stable-${id}`,
    kind,
    label: id,
    scope: { frame: 'main', shadowPath: [] },
    availability: 'current',
    children,
  };
}

describe('canonical component-tree presentation', () => {
  it('renders a leaf exactly once when malformed containment repeats it', () => {
    const tree: ComponentTree = {
      root: 'page',
      nodes: [
        node('page', 'page', ['header', 'menu']),
        node('header', 'landmark', ['open-menu', 'logout']),
        node('menu', 'component', ['logout', 'menu']),
        { ...node('logout', 'control'), ref: { kind: 'action', id: 'lnk3' } },
        node('open-menu', 'control'),
        // Duplicate node records are ignored at the renderer boundary too.
        node('logout', 'control'),
      ],
      relations: [{ from: 'open-menu', to: 'logout', kind: 'reveals', gesture: 'click' }],
    };

    const normalized = normalizeComponentTree(tree);
    expect(normalized).not.toBeNull();
    const order = componentTreeRenderOrder(normalized!);
    expect(order.filter((id) => id === 'logout')).toEqual(['logout']);
    expect(new Set(order).size).toBe(order.length);
    expect(normalized?.nodes.find(({ id }) => id === 'menu')?.children).toEqual([]);
  });

  it('projects a changed collection control through one ancestor path', () => {
    const tree: ComponentTree = {
      root: 'page',
      nodes: [
        node('page', 'page', ['main']),
        node('main', 'landmark', ['col1']),
        { ...node('col1', 'collection', ['item:1']), ref: { kind: 'collection', id: 'col1' } },
        node('item:1', 'item', ['btn9']),
        { ...node('btn9', 'control'), ref: { kind: 'action', id: 'btn9' } },
      ],
      relations: [],
    };

    const projected = projectComponentTree(tree, new Set(['btn9']));
    expect(projected).not.toBeNull();
    expect(componentTreeRenderOrder(projected!)).toEqual([
      'page',
      'main',
      'col1',
      'item:1',
      'btn9',
    ]);
    expect(componentTreeRenderOrder(projected!).filter((id) => id === 'btn9')).toHaveLength(1);
  });

  it('retains an out-of-branch reveal opener as causal context without cloning the target', () => {
    const tree: ComponentTree = {
      root: 'page',
      nodes: [
        node('page', 'page', ['header', 'dialog']),
        node('header', 'landmark', ['open']),
        node('open', 'control'),
        node('dialog', 'component', ['confirm']),
        node('confirm', 'control'),
      ],
      relations: [{ from: 'open', to: 'dialog', kind: 'reveals', gesture: 'click' }],
    };

    const projected = projectComponentTree(tree, new Set(['confirm']));
    expect(projected).not.toBeNull();
    const order = componentTreeRenderOrder(projected!);
    expect(order).toEqual(['page', 'header', 'open', 'dialog', 'confirm']);
    expect(new Set(order).size).toBe(order.length);
  });
});
