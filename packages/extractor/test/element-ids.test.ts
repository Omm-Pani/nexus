import type { Action } from '@nexus/schema';
import { describe, expect, it } from 'vitest';

import {
  actionElementIdPrefix,
  allocatorForArtifact,
  StateElementIdAllocator,
} from '../src/index.js';

function legacyAction(overrides: Partial<Action> = {}): Action {
  return {
    id: 'e1',
    stableId: 'stable-action',
    label: 'Continue',
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
    region: 'g1',
    frame: 'main',
    shadowPath: [],
    rect: { x: 0, y: 0, w: 100, h: 30 },
    locators: [{
      kind: 'structural',
      value: '#continue',
      frame: 'main',
      shadowPath: [],
    }],
    ...overrides,
  };
}

describe('state element ID allocation', () => {
  it('seeds independent counters from current IDs', () => {
    const allocator = new StateElementIdAllocator(['btn2', 'inp7', 'obs3', 'col1']);
    expect(allocator.next('btn')).toBe('btn3');
    expect(allocator.next('inp')).toBe('inp8');
    expect(allocator.next('pwd')).toBe('pwd1');
    expect(allocator.next('obs')).toBe('obs4');
    expect(allocator.next('col')).toBe('col2');
  });

  it('reserves semantic ordinals for old schemaVersion 1 IDs without rewriting them', () => {
    const password = legacyAction({
      id: 'e1',
      stableId: 'password-stable',
      label: 'Password',
      type: 'input',
      kind: 'input',
      placeholder: 'Password',
      locators: [{
        kind: 'structural',
        value: '#password',
        frame: 'main',
        shadowPath: [],
      }],
    });
    const submit = legacyAction({ id: 'e2', stableId: 'submit-stable' });
    const allocator = allocatorForArtifact([password, submit], ['o1'], ['c1']);

    expect(actionElementIdPrefix(password)).toBe('pwd');
    expect(allocator.next('pwd')).toBe('pwd2');
    expect(allocator.next('btn')).toBe('btn2');
    expect(allocator.next('obs')).toBe('obs2');
    expect(allocator.next('col')).toBe('col2');
    expect(password).toMatchObject({ id: 'e1', stableId: 'password-stable' });
  });
});
