import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  ActionElementId,
  Candidate,
  CollectionElementId,
  
  OrchestratorEvent,
  ObservableElementId,
  StateArtifact,
  Transition,
  TypePrefixedElementId,
  Warning,
} from '../src/index.js';
import {
  isActionElementId,
  isLegacyElementId,
  isTypePrefixedElementId,
  parseElementId,
} from '../src/index.js';

describe('@nexus/schema contract', () => {
  it('accepts complete public contract values', () => {
    const artifact = {
      schemaVersion: 1,
      stateId: 'state',
      url: 'https://example.test/',
      routeTemplate: '/',
      title: 'Example',
      personaId: 'anonymous',
      buildId: 'phase-1',
      capturedAt: '2026-01-01T00:00:00.000Z',
      timings: { total: 0 },
      groups: [],
      actions: [],
      observables: [],
      collections: [],
      warnings: [],
    } satisfies StateArtifact;

    const transition = {
      fromStateId: 'before',
      toStateId: 'after',
      trigger: { actionStableId: 'action', verb: 'click' },
      transitionType: 'navigation',
      mutating: false,
      methods: ['GET'],
      observed: [],
      latencyMs: 10,
    } satisfies Transition;

    const candidate = {
      id: 'e1',
      label: 'Continue',
      type: 'button',
    } satisfies Candidate;

    const presentation = {
      t: 'state.presentation',
      stateId: 'state',
    } satisfies OrchestratorEvent;
    const unknownCollectionSize = {
      code: 'unknown_collection_size',
      detail: 'Only the currently observed collection window is known.',
      ref: 'Activity',
    } satisfies Warning;

    expectTypeOf(artifact).toMatchTypeOf<StateArtifact>();
    expectTypeOf(transition).toMatchTypeOf<Transition>();
    expectTypeOf(candidate).toMatchTypeOf<Candidate>();
    expectTypeOf(presentation).toMatchTypeOf<OrchestratorEvent>();
    expectTypeOf(unknownCollectionSize).toMatchTypeOf<Warning>();
    expect(artifact.schemaVersion).toBe(1);
  });

  it('codifies current IDs while recognizing persisted schemaVersion 1 IDs', () => {
    const actionId = 'pwd1' satisfies ActionElementId;
    const observableId = 'obs2' satisfies ObservableElementId;
    const collectionId = 'col3' satisfies CollectionElementId;
    const ids = [actionId, observableId, collectionId] satisfies TypePrefixedElementId[];

    expect(ids.every(isTypePrefixedElementId)).toBe(true);
    expect(isActionElementId(actionId)).toBe(true);
    expect(isActionElementId(observableId)).toBe(false);
    expect(parseElementId('btn12')).toEqual({ prefix: 'btn', index: 12 });
    expect(parseElementId('btn0')).toBeNull();
    expect(parseElementId('e1')).toBeNull();
    expect(isLegacyElementId('e1')).toBe(true);
    expect(isLegacyElementId('o17')).toBe(true);
    expect(isLegacyElementId('c3')).toBe(true);
    expect(isLegacyElementId('col3')).toBe(false);
  });
});
