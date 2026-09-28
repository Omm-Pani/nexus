import type {
  NavigationGraph,
  NavigationGraphEdge,
  NavigationGraphNode,
} from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import { projectCausalNavigationGraph } from '../src/navigation-tree.js';

function node(
  id: string,
  kind: NavigationGraphNode['kind'],
  availability: NavigationGraphNode['availability'] = 'current',
): NavigationGraphNode {
  return { id, kind, ref: id.slice(2), availability };
}

function contains(from: string, to: string): NavigationGraphEdge {
  return { from, to, kind: 'contains' };
}

function reveals(from: string, to: string): NavigationGraphEdge {
  return { from, to, kind: 'reveals', gesture: 'click', order: 0 };
}

function refs(graph: NavigationGraph | null): string[] {
  return graph?.nodes.map(({ ref }) => ref) ?? [];
}

describe('causal navigation-tree projection', () => {
  it('removes a dense action inventory while retaining the complete reveal branch', () => {
    const inventoryNodes = Array.from({ length: 40 }, (_, index) =>
      node(`a:item-${index}`, 'action'),
    );
    const graph: NavigationGraph = {
      root: 's:catalogue',
      nodes: [
        node('s:catalogue', 'state'),
        node('g:header', 'group'),
        node('a:menu', 'action'),
        node('a:search', 'action'),
        node('g:menu', 'group', 'conditional'),
        node('a:logout', 'action', 'conditional'),
        node('a:settings', 'action', 'hidden'),
        node('g:inventory', 'group'),
        ...inventoryNodes,
      ],
      edges: [
        contains('s:catalogue', 'g:header'),
        contains('g:header', 'a:menu'),
        contains('g:header', 'a:search'),
        contains('s:catalogue', 'g:menu'),
        contains('g:menu', 'a:logout'),
        contains('g:menu', 'a:settings'),
        contains('s:catalogue', 'g:inventory'),
        ...inventoryNodes.map((item) => contains('g:inventory', item.id)),
        reveals('a:menu', 'g:menu'),
      ],
    };

    const projected = projectCausalNavigationGraph(graph);

    expect(refs(projected)).toEqual([
      'catalogue',
      'header',
      'menu',
      'menu',
      'logout',
      'settings',
    ]);
    expect(projected?.edges).toEqual([
      contains('s:catalogue', 'g:header'),
      contains('g:header', 'a:menu'),
      contains('g:menu', 'a:logout'),
      contains('g:menu', 'a:settings'),
      reveals('a:menu', 'g:menu'),
    ]);
    expect(refs(projected)).not.toContain('inventory');
    expect(refs(projected)).not.toContain('search');
  });

  it('shows only a changed causal branch for a same-URL delta', () => {
    const graph: NavigationGraph = {
      root: 's:dashboard-menu-open',
      nodes: [
        node('s:dashboard-menu-open', 'state'),
        node('g:header', 'group'),
        node('a:menu', 'action'),
        node('g:menu', 'group', 'conditional'),
        node('a:logout', 'action', 'conditional'),
        node('a:profile', 'action'),
        node('g:profile', 'group', 'conditional'),
        node('a:preferences', 'action', 'conditional'),
        node('a:unrelated-delta', 'action'),
      ],
      edges: [
        contains('s:dashboard-menu-open', 'g:header'),
        contains('g:header', 'a:menu'),
        contains('g:header', 'a:profile'),
        contains('g:header', 'a:unrelated-delta'),
        contains('s:dashboard-menu-open', 'g:menu'),
        contains('g:menu', 'a:logout'),
        contains('s:dashboard-menu-open', 'g:profile'),
        contains('g:profile', 'a:preferences'),
        reveals('a:menu', 'g:menu'),
        reveals('a:profile', 'g:profile'),
      ],
    };

    const logoutDelta = projectCausalNavigationGraph(graph, new Set(['logout']));
    expect(refs(logoutDelta)).toEqual([
      'dashboard-menu-open',
      'header',
      'menu',
      'menu',
      'logout',
    ]);
    expect(refs(logoutDelta)).not.toContain('profile');
    expect(refs(logoutDelta)).not.toContain('preferences');

    expect(projectCausalNavigationGraph(graph, new Set(['unrelated-delta']))).toBeNull();
  });

  it('suppresses graphs that have containment but no reveal relationship', () => {
    expect(projectCausalNavigationGraph({
      root: 's:plain',
      nodes: [node('s:plain', 'state'), node('g:main', 'group'), node('a:save', 'action')],
      edges: [contains('s:plain', 'g:main'), contains('g:main', 'a:save')],
    })).toBeNull();
  });
});
