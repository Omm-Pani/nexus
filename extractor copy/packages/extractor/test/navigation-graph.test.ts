import type { Action, Group, StateArtifact } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import { buildNavigationGraph, navigationGraphNodeId } from '../src/index.js';

function action(
  id: string,
  stableId: string,
  label: string,
  region: string,
  overrides: Partial<Action> = {},
): Action {
  return {
    id,
    stableId,
    label,
    type: 'button',
    kind: 'open',
    risk: 'safe',
    confidence: 1,
    evidence: [],
    state: { disabled: false },
    visible: true,
    inViewport: true,
    hitTestable: true,
    occludedBy: null,
    region,
    frame: 'main',
    shadowPath: [],
    rect: { x: 0, y: 0, w: 100, h: 32 },
    locators: [],
    ...overrides,
  };
}

function artifact(groups: Group[], actions: Action[]): StateArtifact {
  return {
    schemaVersion: 1,
    stateId: 'inventory-state',
    url: 'https://www.saucedemo.com/inventory.html',
    routeTemplate: '/inventory.html',
    title: 'Swag Labs',
    personaId: 'standard_user',
    buildId: 'test',
    capturedAt: '2026-08-21T00:00:00.000Z',
    timings: {},
    groups,
    actions,
    observables: [],
    collections: [],
    warnings: [],
  };
}

describe('compact navigation graph projection', () => {
  it('represents a SauceDemo-style menu as opener -> conditional menu -> Logout', () => {
    const groups: Group[] = [{
      id: 'g-header',
      label: 'Header',
      kind: 'nav',
      global: true,
      conditional: false,
      actions: ['btn1'],
      observables: [],
    }, {
      id: 'g-menu',
      label: 'Application menu',
      kind: 'menu',
      global: false,
      conditional: true,
      parentGroup: 'g-header',
      parentAction: 'btn1',
      actions: ['lnk1'],
      observables: [],
    }];
    const opener = action('btn1', 'menu-stable', 'Open Menu', 'g-header', {
      state: { disabled: false, expanded: false },
    });
    const logout = action('lnk1', 'logout-stable', 'Logout', 'g-menu', {
      type: 'navigation',
      kind: 'navigate',
      visible: false,
      inViewport: false,
      hitTestable: false,
      parentAction: opener.id,
      discoveredVia: {
        triggerStableId: opener.stableId,
        triggerLabel: opener.label,
        gesture: 'click',
        prerequisites: [],
      },
    });

    const graph = buildNavigationGraph(artifact(groups, [opener, logout]));
    const state = navigationGraphNodeId.state('inventory-state');
    const header = navigationGraphNodeId.group('g-header');
    const menu = navigationGraphNodeId.group('g-menu');
    const open = navigationGraphNodeId.action('btn1');
    const signOut = navigationGraphNodeId.action('lnk1');

    expect(graph.root).toBe(state);
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: state, to: header, kind: 'contains' },
      { from: header, to: open, kind: 'contains' },
      { from: open, to: menu, kind: 'reveals', gesture: 'click', order: 0 },
      { from: menu, to: signOut, kind: 'contains' },
    ]));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({
      from: open,
      to: signOut,
      kind: 'reveals',
    }));
    expect(graph.nodes.find(({ id }) => id === menu)?.availability).toBe('conditional');
    expect(graph.nodes.find(({ id }) => id === signOut)?.availability).toBe('conditional');
  });

  it('preserves an ordered prerequisite chain through nested menu nodes', () => {
    const groups: Group[] = [{
      id: 'g-header',
      label: 'Header',
      kind: 'nav',
      global: true,
      conditional: false,
      actions: ['btn1'],
      observables: [],
    }, {
      id: 'g-account',
      label: 'Account menu',
      kind: 'menu',
      global: false,
      conditional: true,
      parentGroup: 'g-header',
      parentAction: 'btn1',
      actions: ['btn2'],
      observables: [],
    }, {
      id: 'g-session',
      label: 'Session submenu',
      kind: 'menu',
      global: false,
      conditional: true,
      parentGroup: 'g-account',
      parentAction: 'btn2',
      actions: ['lnk1'],
      observables: [],
    }];
    const account = action('btn1', 'account-stable', 'Account', 'g-header');
    const session = action('btn2', 'session-stable', 'Session', 'g-account', {
      visible: false,
      inViewport: false,
      hitTestable: false,
      parentAction: account.id,
      discoveredVia: {
        triggerStableId: account.stableId,
        triggerLabel: account.label,
        gesture: 'click',
        prerequisites: [],
      },
    });
    const logout = action('lnk1', 'logout-stable', 'Logout', 'g-session', {
      type: 'navigation',
      kind: 'navigate',
      visible: false,
      inViewport: false,
      hitTestable: false,
      parentAction: session.id,
      discoveredVia: {
        triggerStableId: session.stableId,
        triggerLabel: session.label,
        gesture: 'hover',
        prerequisites: [{
          triggerStableId: account.stableId,
          triggerLabel: account.label,
          gesture: 'click',
        }],
      },
    });

    const graph = buildNavigationGraph(artifact(groups, [account, session, logout]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      {
        from: navigationGraphNodeId.action(account.id),
        to: navigationGraphNodeId.group('g-account'),
        kind: 'reveals',
        gesture: 'click',
        order: 0,
      },
      {
        from: navigationGraphNodeId.action(session.id),
        to: navigationGraphNodeId.group('g-session'),
        kind: 'reveals',
        gesture: 'hover',
        order: 1,
      },
      {
        from: navigationGraphNodeId.group('g-session'),
        to: navigationGraphNodeId.action(logout.id),
        kind: 'contains',
      },
    ]));
  });
});
