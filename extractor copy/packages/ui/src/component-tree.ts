import type {
  ComponentTree,
  ComponentTreeNode,
  ComponentTreeRelation,
} from '@nexus/schema';

export interface ComponentTreeProjection {
  root: string;
  nodes: ComponentTreeNode[];
  relations: ComponentTreeRelation[];
}

function copyNode(node: ComponentTreeNode, children: string[]): ComponentTreeNode {
  return {
    ...node,
    scope: { frame: node.scope.frame, shadowPath: [...node.scope.shadowPath] },
    children,
  };
}

/**
 * Defensively turn an artifact hierarchy into one renderable, single-parent
 * tree. The extractor owns the canonical ordering; this boundary only removes
 * duplicate/cyclic references and keeps malformed legacy orphans inspectable.
 */
export function normalizeComponentTree(
  tree: ComponentTree,
): ComponentTreeProjection | null {
  const source = new Map<string, ComponentTreeNode>();
  for (const node of tree.nodes) {
    if (!source.has(node.id)) source.set(node.id, node);
  }
  const root = source.get(tree.root);
  if (root === undefined) return null;

  const claimed = new Set<string>();
  const projected = new Map<string, ComponentTreeNode>();
  const order: string[] = [];
  const visit = (id: string, path: ReadonlySet<string>): void => {
    const node = source.get(id);
    if (node === undefined || claimed.has(id) || path.has(id)) return;
    claimed.add(id);
    order.push(id);
    const nextPath = new Set(path);
    nextPath.add(id);
    const children: string[] = [];
    for (const childId of node.children) {
      if (
        childId === id
        || !source.has(childId)
        || claimed.has(childId)
        || nextPath.has(childId)
      ) continue;
      children.push(childId);
      visit(childId, nextPath);
    }
    projected.set(id, copyNode(node, children));
  };

  visit(tree.root, new Set());
  const rootChildren = [...(projected.get(tree.root)?.children ?? [])];
  for (const node of source.values()) {
    if (claimed.has(node.id)) continue;
    rootChildren.push(node.id);
    visit(node.id, new Set([tree.root]));
  }
  projected.set(tree.root, copyNode(root, rootChildren));

  const nodeIds = new Set(projected.keys());
  return {
    root: tree.root,
    nodes: order.flatMap((id) => {
      const node = projected.get(id);
      return node === undefined ? [] : [node];
    }),
    relations: tree.relations.filter((relation) =>
      nodeIds.has(relation.from)
      && (relation.to === undefined || nodeIds.has(relation.to)),
    ),
  };
}

/**
 * Keep changed leaves and their semantic ancestors for a compact same-URL
 * state delta. Undefined means the full current state; an empty set means no
 * component changed.
 */
export function projectComponentTree(
  tree: ComponentTree,
  focusRefs?: ReadonlySet<string>,
): ComponentTreeProjection | null {
  const normalized = normalizeComponentTree(tree);
  if (normalized === null || focusRefs === undefined) return normalized;

  const nodes = new Map(normalized.nodes.map((node) => [node.id, node]));
  const parent = new Map<string, string>();
  for (const node of normalized.nodes) {
    for (const child of node.children) parent.set(child, node.id);
  }
  const included = new Set<string>([normalized.root]);
  const includeAncestors = (start: string): void => {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      included.add(cursor);
      cursor = parent.get(cursor);
    }
  };
  for (const node of normalized.nodes) {
    if (focusRefs.has(node.id) || (node.ref !== undefined && focusRefs.has(node.ref.id))) {
      includeAncestors(node.id);
    }
  }

  // A causal opener may sit outside the target's containment path. Retain it
  // once as context, along with its own ancestors, without cloning the target.
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of normalized.relations) {
      if (relation.to === undefined || !included.has(relation.to) || included.has(relation.from)) {
        continue;
      }
      includeAncestors(relation.from);
      changed = true;
    }
  }

  const hasFocusedNode = [...included].some((id) => id !== normalized.root);
  if (!hasFocusedNode) return null;
  return {
    root: normalized.root,
    nodes: normalized.nodes
      .filter(({ id }) => included.has(id))
      .map((node) => copyNode(
        node,
        node.children.filter((child) => included.has(child)),
      )),
    relations: normalized.relations.filter((relation) =>
      included.has(relation.from)
      && (relation.to === undefined || included.has(relation.to)),
    ),
  };
}

/** Depth-first ids as the renderer will encounter them; useful for invariants. */
export function componentTreeRenderOrder(tree: ComponentTreeProjection): string[] {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id) || !nodes.has(id)) return;
    visited.add(id);
    result.push(id);
    for (const child of nodes.get(id)?.children ?? []) visit(child);
  };
  visit(tree.root);
  return result;
}
