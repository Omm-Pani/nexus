import type {
  Action,
  NavigationGraph,
  NavigationGraphEdge,
  NavigationGraphNode,
  ObservedGesture,
  StateArtifact,
} from '@nexus/schema';

function stateNodeId(stateId: string): string {
  return `s:${stateId}`;
}

function groupNodeId(groupId: string): string {
  return `g:${groupId}`;
}

function actionNodeId(actionId: string): string {
  return `a:${actionId}`;
}

function actionAvailability(
  artifact: StateArtifact,
  action: Action,
): NavigationGraphNode['availability'] {
  if (action.visible) return 'current';
  const group = artifact.groups.find(({ id }) => id === action.region);
  return action.discoveredVia !== undefined
    || action.parentAction !== undefined
    || group?.conditional === true
    ? 'conditional'
    : 'hidden';
}

/**
 * Project the artifact's existing hierarchy and reveal metadata into a small,
 * deterministic navigation graph. No DOM selectors or repeated labels are
 * copied into it; every non-state node dereferences an existing local id.
 */
export function buildNavigationGraph(artifact: StateArtifact): NavigationGraph {
  const root = stateNodeId(artifact.stateId);
  const nodes: NavigationGraphNode[] = [{
    id: root,
    kind: 'state',
    ref: artifact.stateId,
    availability: 'current',
  }];
  nodes.push(...artifact.groups.map((group): NavigationGraphNode => ({
    id: groupNodeId(group.id),
    kind: 'group',
    ref: group.id,
    availability: group.conditional ? 'conditional' : 'current',
  })));
  nodes.push(...artifact.actions.map((action): NavigationGraphNode => ({
    id: actionNodeId(action.id),
    kind: 'action',
    ref: action.id,
    availability: actionAvailability(artifact, action),
  })));

  const groupById = new Map(artifact.groups.map((group) => [group.id, group]));
  const actionById = new Map(artifact.actions.map((action) => [action.id, action]));
  const actionByStableId = new Map(
    artifact.actions.map((action) => [action.stableId, action]),
  );
  const edges: NavigationGraphEdge[] = [];
  const edgeIndex = new Map<string, number>();
  const addEdge = (edge: NavigationGraphEdge): void => {
    if (edge.from === edge.to) return;
    const key = `${edge.kind}|${edge.from}|${edge.to}`;
    const existingIndex = edgeIndex.get(key);
    if (existingIndex === undefined) {
      edgeIndex.set(key, edges.length);
      edges.push(edge);
      return;
    }
    const existing = edges[existingIndex] as NavigationGraphEdge;
    // Recorded gesture/order is more precise than the parentAction click
    // fallback. Keep the earliest replay position when several descendants
    // confirm the same reveal edge.
    edges[existingIndex] = {
      ...existing,
      ...(edge.gesture === undefined
        ? {}
        : {
            gesture: edge.order !== undefined || existing.gesture === undefined
              ? edge.gesture
              : existing.gesture,
          }),
      ...(edge.order === undefined && existing.order === undefined
        ? {}
        : { order: Math.min(existing.order ?? edge.order ?? 0, edge.order ?? existing.order ?? 0) }),
    };
  };

  // First establish the tree. A group appears under its semantic parent; an
  // action appears exactly once under its owning group (or the page root if a
  // legacy artifact contains a dangling region id).
  for (const group of artifact.groups) {
    addEdge({
      from: group.parentGroup !== undefined && groupById.has(group.parentGroup)
        ? groupNodeId(group.parentGroup)
        : root,
      to: groupNodeId(group.id),
      kind: 'contains',
    });
  }
  for (const action of artifact.actions) {
    addEdge({
      from: groupById.has(action.region) ? groupNodeId(action.region) : root,
      to: actionNodeId(action.id),
      kind: 'contains',
    });
  }

  const revealTargetFor = (target: Action, source: Action): string => {
    const targetGroup = groupById.get(target.region);
    return targetGroup?.parentAction === source.id
      ? groupNodeId(targetGroup.id)
      : actionNodeId(target.id);
  };

  // A discovered action carries the complete ordered replay chain. Convert
  // every adjacent pair into a reveal edge; if the target belongs to a
  // conditional group controlled by the source, point at that group so the
  // graph reads: opener -> menu -> Logout.
  for (const target of artifact.actions) {
    const reveal = target.discoveredVia;
    if (reveal === undefined) continue;
    const chain: Array<{ action: Action; gesture: ObservedGesture }> = [];
    for (const step of reveal.prerequisites) {
      const action = actionByStableId.get(step.triggerStableId);
      if (action !== undefined) chain.push({ action, gesture: step.gesture });
    }
    const trigger = actionByStableId.get(reveal.triggerStableId);
    if (trigger !== undefined) chain.push({ action: trigger, gesture: reveal.gesture });

    for (let index = 0; index < chain.length; index += 1) {
      const current = chain[index] as { action: Action; gesture: ObservedGesture };
      const next = chain[index + 1]?.action ?? target;
      addEdge({
        from: actionNodeId(current.action.id),
        to: revealTargetFor(next, current.action),
        kind: 'reveals',
        gesture: current.gesture,
        order: index,
      });
    }
  }

  // parentAction is also populated for native/dormant controls and persisted
  // artifacts that predate discoveredVia. Add a conservative click edge only
  // when recorded metadata did not already provide the relationship.
  for (const group of artifact.groups) {
    const parent = group.parentAction === undefined
      ? undefined
      : actionById.get(group.parentAction);
    if (parent === undefined) continue;
    addEdge({
      from: actionNodeId(parent.id),
      to: groupNodeId(group.id),
      kind: 'reveals',
      gesture: 'click',
    });
  }
  for (const action of artifact.actions) {
    const parent = action.parentAction === undefined
      ? undefined
      : actionById.get(action.parentAction);
    if (parent === undefined) continue;
    const group = groupById.get(action.region);
    if (group?.parentAction === parent.id) continue;
    addEdge({
      from: actionNodeId(parent.id),
      to: actionNodeId(action.id),
      kind: 'reveals',
      gesture: 'click',
    });
  }

  return { root, nodes, edges };
}

export const navigationGraphNodeId = {
  state: stateNodeId,
  group: groupNodeId,
  action: actionNodeId,
};
