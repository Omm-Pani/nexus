import type { Action, Group } from '@nexus/schema';

export interface ActionTreeNode {
  action: Action;
  children: ActionTreeNode[];
}

export interface SemanticRootGroup {
  group: Group;
  /** The source id used to attach collections before presentation cloning. */
  sourceGroupId: string;
  includeChildren: boolean;
}

/**
 * Preserve executable DOM relationships inside a semantic region.
 *
 * Select choices, submenu controls, and other owned actions carry
 * `parentAction`.  Rendering the group's flat id list discarded that
 * relationship and made native options look like independent controls.  This
 * projection is deliberately presentation-only: ids and execution bindings
 * remain unchanged.
 */
export function buildActionForest(
  actionIds: readonly string[],
  actions: ReadonlyMap<string, Action>,
): ActionTreeNode[] {
  const ordered = [...new Set(actionIds)].filter((id) => actions.has(id));
  const included = new Set(ordered);
  const childrenByParent = new Map<string, string[]>();
  const childIds = new Set<string>();

  for (const id of ordered) {
    const parent = actions.get(id)?.parentAction;
    if (parent === undefined || parent === id || !included.has(parent)) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(id);
    childrenByParent.set(parent, children);
    childIds.add(id);
  }

  const rendered = new Set<string>();
  const build = (id: string, path: ReadonlySet<string>): ActionTreeNode | null => {
    const action = actions.get(id);
    if (action === undefined || path.has(id)) return null;
    const nextPath = new Set(path);
    nextPath.add(id);
    rendered.add(id);
    return {
      action,
      children: (childrenByParent.get(id) ?? []).flatMap((childId) => {
        const child = build(childId, nextPath);
        return child === null ? [] : [child];
      }),
    };
  };

  const roots = ordered.filter((id) => !childIds.has(id)).flatMap((id) => {
    const node = build(id, new Set());
    return node === null ? [] : [node];
  });

  // Malformed legacy artifacts can contain parent cycles. Keep their actions
  // inspectable once instead of dropping the entire component.
  for (const id of ordered) {
    if (rendered.has(id)) continue;
    const node = build(id, new Set());
    if (node !== null) roots.push(node);
  }
  return roots;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/**
 * Lift the synthetic document-title wrapper while keeping real landmarks.
 * Header/Main/Footer remain explicit siblings; only the redundant group that
 * repeats the page card title is omitted.
 */
export function semanticRootGroups(
  groups: readonly Group[],
  pageTitle: string,
  collectionParentIds: ReadonlySet<string>,
): SemanticRootGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const childrenByParent = new Map<string, Group[]>();
  for (const group of groups) {
    if (group.parentGroup === undefined || !byId.has(group.parentGroup)) continue;
    const children = childrenByParent.get(group.parentGroup) ?? [];
    children.push(group);
    childrenByParent.set(group.parentGroup, children);
  }
  const roots = groups.filter((group) => group.parentGroup === undefined || !byId.has(group.parentGroup));
  return roots.flatMap((group): SemanticRootGroup[] => {
    const children = childrenByParent.get(group.id) ?? [];
    const documentRoot = group.kind === 'region'
      && children.length > 0
      && (
        normalized(group.label) === normalized(pageTitle)
        || /^(?:page|document)$/iu.test(group.label.trim())
      );
    if (!documentRoot) {
      return [{ group, sourceGroupId: group.id, includeChildren: true }];
    }

    const projected = children.map((child) => ({
      group: child,
      sourceGroupId: child.id,
      includeChildren: true,
    }));
    if (
      group.actions.length > 0
      || group.observables.length > 0
      || collectionParentIds.has(group.id)
    ) {
      const residual = { ...group, id: `${group.id}::other`, label: 'Other page elements' };
      delete residual.parentGroup;
      projected.push({
        group: residual,
        sourceGroupId: group.id,
        includeChildren: false,
      });
    }
    return projected;
  });
}
