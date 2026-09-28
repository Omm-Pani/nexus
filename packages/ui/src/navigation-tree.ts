import type {
  NavigationGraph,
  NavigationGraphEdge,
  NavigationGraphNode,
} from '@nexus/schema';

function edgeKey(edge: NavigationGraphEdge): string {
  return `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
}

/**
 * Reduce the artifact graph to the small part that explains hidden controls.
 *
 * The extractor graph deliberately contains the complete page hierarchy so it
 * is useful to planners. Rendering that graph verbatim repeats every action a
 * second time above the regular element catalogue. The UI only needs to show:
 *
 * - each causal reveal edge and its two endpoints;
 * - the containment path from the page root to each reveal trigger; and
 * - conditional/hidden descendants of a reveal endpoint, plus the minimum
 *   containment nodes needed to reach them.
 *
 * A reveal target is attached below its trigger, so its ordinary containment
 * edge is intentionally omitted. For a same-URL delta, `focusActionRefs`
 * limits the result to reveal branches that explain a changed action.
 * Returning `null` for a graph without relevant reveal edges also prevents a
 * plain inventory tree from duplicating GroupTree.
 */
export function projectCausalNavigationGraph(
  graph: NavigationGraph,
  focusActionRefs?: ReadonlySet<string>,
): NavigationGraph | null {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodeById.has(graph.root)) return null;

  let revealEdges = graph.edges.filter((edge) =>
    edge.kind === 'reveals'
    && nodeById.has(edge.from)
    && nodeById.has(edge.to),
  );
  if (revealEdges.length === 0) return null;

  const containsBySource = new Map<string, NavigationGraphEdge[]>();
  const containsByTarget = new Map<string, NavigationGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' || !nodeById.has(edge.from) || !nodeById.has(edge.to)) {
      continue;
    }
    const outgoing = containsBySource.get(edge.from) ?? [];
    outgoing.push(edge);
    containsBySource.set(edge.from, outgoing);
    const incoming = containsByTarget.get(edge.to) ?? [];
    incoming.push(edge);
    containsByTarget.set(edge.to, incoming);
  }

  if (focusActionRefs !== undefined) {
    const focusedNodeIds = new Set(graph.nodes.flatMap((node) =>
      node.kind === 'action' && focusActionRefs.has(node.ref) ? [node.id] : [],
    ));
    const descendantMemo = new Map<string, boolean>();
    const containsFocusedAction = (nodeId: string, path: ReadonlySet<string>): boolean => {
      if (focusedNodeIds.has(nodeId)) return true;
      const cached = descendantMemo.get(nodeId);
      if (cached !== undefined) return cached;
      if (path.has(nodeId)) return false;
      const nextPath = new Set(path);
      nextPath.add(nodeId);
      const result = (containsBySource.get(nodeId) ?? [])
        .some((edge) => containsFocusedAction(edge.to, nextPath));
      descendantMemo.set(nodeId, result);
      return result;
    };
    revealEdges = revealEdges.filter((edge) =>
      focusedNodeIds.has(edge.from)
      || containsFocusedAction(edge.to, new Set()),
    );
    if (revealEdges.length === 0) return null;
  }

  const revealTargets = new Set(revealEdges.map((edge) => edge.to));
  const keptNodeIds = new Set<string>([graph.root]);
  const keptEdgeKeys = new Set<string>();
  const keepEdge = (edge: NavigationGraphEdge): void => {
    keptNodeIds.add(edge.from);
    keptNodeIds.add(edge.to);
    keptEdgeKeys.add(edgeKey(edge));
  };

  for (const edge of revealEdges) keepEdge(edge);

  // Connect every trigger to the page, stopping when it is already connected
  // by an earlier reveal edge. A well-formed extractor graph has one
  // containment parent, but walking all parents keeps this helper robust for
  // older or hand-authored artifacts.
  const addContainmentAncestors = (nodeId: string, path: ReadonlySet<string>): void => {
    if (nodeId === graph.root || revealTargets.has(nodeId) || path.has(nodeId)) return;
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    for (const edge of containsByTarget.get(nodeId) ?? []) {
      keepEdge(edge);
      addContainmentAncestors(edge.from, nextPath);
    }
  };
  for (const edge of revealEdges) addContainmentAncestors(edge.from, new Set());

  // Retain a path below a reveal target only when it reaches a conditional or
  // hidden node. Current siblings are the normal inventory and remain solely
  // in GroupTree.
  const addConditionalDescendants = (
    nodeId: string,
    path: ReadonlySet<string>,
  ): boolean => {
    if (path.has(nodeId)) return false;
    const nextPath = new Set(path);
    nextPath.add(nodeId);
    let relevant = nodeById.get(nodeId)?.availability !== 'current';
    for (const edge of containsBySource.get(nodeId) ?? []) {
      const childRelevant = addConditionalDescendants(edge.to, nextPath);
      if (!childRelevant) continue;
      keepEdge(edge);
      relevant = true;
    }
    return relevant;
  };
  for (const target of revealTargets) addConditionalDescendants(target, new Set());

  return {
    root: graph.root,
    nodes: graph.nodes.filter((node): node is NavigationGraphNode => keptNodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => keptEdgeKeys.has(edgeKey(edge))),
  };
}
