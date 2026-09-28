import type {
  Action,
  Collection,
  ComponentTree,
  ComponentTreeNode,
  ComponentTreeRelation,
  Group,
  Observable,
  StateArtifact,
} from '@nexus/schema';

import { stableHash } from '../identity/index.js';

type Scope = ComponentTreeNode['scope'];

const LANDMARK_KINDS = new Set<Group['kind']>(['region', 'nav', 'main']);

function copyScope(scope: Scope): Scope {
  return { frame: scope.frame, shadowPath: [...scope.shadowPath] };
}

function actionAvailability(
  action: Action,
  groups: ReadonlyMap<string, Group>,
): ComponentTreeNode['availability'] {
  if (action.visible) return 'current';
  if (
    action.discoveredVia !== undefined
    || action.parentAction !== undefined
    || groups.get(action.region)?.conditional === true
  ) return 'conditional';
  return 'hidden';
}

function observableAvailability(observable: Observable): ComponentTreeNode['availability'] {
  return observable.discoveredVia === undefined ? 'current' : 'conditional';
}

function relationKey(relation: ComponentTreeRelation): string {
  return [
    relation.kind,
    relation.from,
    relation.to ?? '',
    relation.destination ?? '',
    relation.gesture ?? '',
    relation.order ?? '',
  ].join('|');
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.frame === right.frame
    && left.shadowPath.length === right.shadowPath.length
    && left.shadowPath.every((value, index) => value === right.shadowPath[index]);
}

function normalizedComponentLabel(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

/**
 * Remove a source-DOM wrapper that would otherwise present the same named
 * component twice. This is deliberately narrow: the parent must contain only
 * one structural child, and both nodes must describe the same scoped,
 * available component. Leaf refs and ordering stay untouched, while graph
 * relations are redirected to the retained parent.
 */
function collapseRedundantStructuralWrappers(tree: ComponentTree): ComponentTree {
  const nodes = new Map(tree.nodes.map((node) => [node.id, {
    ...node,
    scope: copyScope(node.scope),
    children: [...node.children],
  }]));
  const removed = new Set<string>();
  const aliases = new Map<string, string>();
  const structural = (node: ComponentTreeNode): boolean =>
    node.kind === 'landmark' || node.kind === 'component';

  let changed = true;
  while (changed) {
    changed = false;
    for (const parent of tree.nodes) {
      if (removed.has(parent.id)) continue;
      const projectedParent = nodes.get(parent.id);
      if (projectedParent === undefined || !structural(projectedParent)) continue;
      projectedParent.children = projectedParent.children.filter((id) => !removed.has(id));
      if (projectedParent.children.length !== 1) continue;
      const childId = projectedParent.children[0];
      if (childId === undefined) continue;
      const child = nodes.get(childId);
      const parentLabel = normalizedComponentLabel(projectedParent.label);
      if (
        child === undefined
        || removed.has(child.id)
        || !structural(child)
        || child.kind !== projectedParent.kind
        || parentLabel === ''
        || parentLabel !== normalizedComponentLabel(child.label)
        || child.availability !== projectedParent.availability
        || !sameScope(child.scope, projectedParent.scope)
      ) continue;

      projectedParent.children = [...child.children];
      aliases.set(child.id, projectedParent.id);
      removed.add(child.id);
      changed = true;
    }
  }

  const retainedId = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current) as string;
    }
    return current;
  };
  const relations = tree.relations.flatMap((relation) => {
    const from = retainedId(relation.from);
    const to = relation.to === undefined ? undefined : retainedId(relation.to);
    if (to !== undefined && from === to) return [];
    return [{
      ...relation,
      from,
      ...(to === undefined ? {} : { to }),
    }];
  });

  return {
    root: retainedId(tree.root),
    nodes: tree.nodes.flatMap((node) => {
      if (removed.has(node.id)) return [];
      const projected = nodes.get(node.id);
      return projected === undefined ? [] : [projected];
    }),
    relations: [...new Map(
      relations.map((relation) => [relationKey(relation), relation]),
    ).values()],
  };
}

/**
 * Build the single-parent semantic hierarchy used by planners and inspectors.
 * Legacy Group membership arrays are intentionally treated as input only:
 * repeated members are claimed by Collection items before ordinary groups.
 */
export function buildComponentTree(artifact: StateArtifact): ComponentTree {
  const root = `page:${artifact.stateId}`;
  const groups = new Map(artifact.groups.map((group) => [group.id, group]));
  const actions = new Map(artifact.actions.map((action) => [action.id, action]));
  const collections = new Map(artifact.collections.map((collection) => [collection.id, collection]));
  const nodes = new Map<string, ComponentTreeNode>();
  const nodeOrder: string[] = [];
  const parentByChild = new Map<string, string>();
  const defaultScope: Scope = { frame: 'main', shadowPath: [] };

  const addNode = (node: ComponentTreeNode): void => {
    if (nodes.has(node.id)) return;
    nodes.set(node.id, node);
    nodeOrder.push(node.id);
  };
  const attach = (parent: string, child: string): void => {
    if (parent === child || parentByChild.has(child)) return;
    let cursor: string | undefined = parent;
    const seen = new Set<string>();
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === child) return;
      seen.add(cursor);
      cursor = parentByChild.get(cursor);
    }
    parentByChild.set(child, parent);
  };

  addNode({
    id: root,
    stableId: artifact.stateId,
    kind: 'page',
    label: artifact.title || artifact.url || 'Page',
    ref: { kind: 'state', id: artifact.stateId },
    scope: copyScope(defaultScope),
    availability: 'current',
    children: [],
  });

  const directScopes = new Map<string, Scope[]>();
  const addDirectScope = (groupId: string, scope: Scope): void => {
    const values = directScopes.get(groupId) ?? [];
    values.push(scope);
    directScopes.set(groupId, values);
  };
  for (const action of artifact.actions) {
    addDirectScope(action.region, { frame: action.frame, shadowPath: [...action.shadowPath] });
  }
  for (const observable of artifact.observables) {
    addDirectScope(observable.region, {
      frame: observable.frame,
      shadowPath: [...(observable.shadowPath ?? [])],
    });
  }
  for (const collection of artifact.collections) {
    if (collection.groupId !== undefined) {
      addDirectScope(collection.groupId, {
        frame: collection.frame ?? 'main',
        shadowPath: [...(collection.shadowPath ?? [])],
      });
    }
  }

  const groupScopeMemo = new Map<string, Scope>();
  const groupScope = (groupId: string, resolving = new Set<string>()): Scope => {
    const known = groupScopeMemo.get(groupId);
    if (known !== undefined) return known;
    if (resolving.has(groupId)) return defaultScope;
    const group = groups.get(groupId);
    if (group === undefined) return defaultScope;
    if (group.frame !== undefined || group.shadowPath !== undefined) {
      const explicit = {
        frame: group.frame ?? 'main',
        shadowPath: [...(group.shadowPath ?? [])],
      };
      groupScopeMemo.set(groupId, explicit);
      return explicit;
    }
    resolving.add(groupId);
    const direct = directScopes.get(groupId)?.[0];
    const child = artifact.groups.find(({ parentGroup }) => parentGroup === groupId);
    const inferred = direct
      ?? (child === undefined ? undefined : groupScope(child.id, resolving))
      ?? (group.parentGroup === undefined ? undefined : groupScope(group.parentGroup, resolving))
      ?? defaultScope;
    resolving.delete(groupId);
    groupScopeMemo.set(groupId, inferred);
    return inferred;
  };

  const comparableLabel = (value: string): string => value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
  const omittedGroupIds = new Set(artifact.groups.filter((group) =>
    group.kind === 'collection'
    || (
      group.kind === 'region'
      && group.parentGroup === undefined
      && groupScope(group.id).frame === 'main'
      && groupScope(group.id).shadowPath.length === 0
      && comparableLabel(group.label) !== ''
      && comparableLabel(group.label) === comparableLabel(artifact.title)
    ),
  ).map(({ id }) => id));

  // Synthetic legacy collection groups duplicate a Collection. A main-frame
  // document group named exactly like the page duplicates the page node. Both
  // remain in artifact.groups for old readers but are absent here.
  const canonicalGroups = artifact.groups.filter(({ id }) => !omittedGroupIds.has(id));
  const groupControllerId = (group: Group): string | undefined => {
    if (group.parentAction !== undefined && actions.has(group.parentAction)) {
      return group.parentAction;
    }
    const childControllers = new Set(artifact.actions
      .filter((action) => action.region === group.id && action.parentAction !== undefined)
      .map((action) => action.parentAction as string)
      .filter((id) => actions.has(id)));
    return childControllers.size === 1 ? [...childControllers][0] : undefined;
  };
  const canonicalGroupParent = (group: Group): string => {
    let parentId = group.parentGroup;
    const seen = new Set([group.id]);
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = groups.get(parentId);
      if (parent === undefined) return root;
      if (!omittedGroupIds.has(parent.id)) {
        // DOM nesting is not always visual/application ownership. A page-local
        // toolbar or body container can sit inside a site-header wrapper in the
        // source DOM. Keep global chrome separate unless a conditional surface
        // was causally opened by an action in that chrome.
        if (!group.global && parent.global) {
          const controllerId = groupControllerId(group);
          const controller = controllerId === undefined ? undefined : actions.get(controllerId);
          const controlledByGlobalAction = group.conditional
            && controller !== undefined
            && controller.region === parent.id;
          if (controlledByGlobalAction) return parent.id;
          let ancestorId = parent.parentGroup;
          while (ancestorId !== undefined && !seen.has(ancestorId)) {
            seen.add(ancestorId);
            const ancestor = groups.get(ancestorId);
            if (ancestor === undefined) break;
            if (!ancestor.global && ancestor.kind === 'main') return ancestor.id;
            ancestorId = ancestor.parentGroup;
          }
          return root;
        }
        return parent.id;
      }
      parentId = parent.parentGroup;
    }
    return root;
  };
  const groupStableIds = new Map<string, string>();
  const stableGroupId = (group: Group, resolving = new Set<string>()): string => {
    const known = groupStableIds.get(group.id);
    if (known !== undefined) return known;
    if (resolving.has(group.id)) return stableHash('component-group-cycle-v1', group.id);
    resolving.add(group.id);
    const parentId = canonicalGroupParent(group);
    const parentStable = parentId === root
      ? artifact.stateId
      : stableGroupId(groups.get(parentId) as Group, resolving);
    const scope = groupScope(group.id);
    const siblings = canonicalGroups.filter((candidate) =>
      canonicalGroupParent(candidate) === parentId
      && candidate.kind === group.kind
      && candidate.label === group.label
      && groupScope(candidate.id).frame === scope.frame
      && groupScope(candidate.id).shadowPath.join('>') === scope.shadowPath.join('>'),
    );
    const occurrence = Math.max(0, siblings.findIndex(({ id }) => id === group.id));
    const result = stableHash(
      'component-group-v1',
      parentStable,
      scope.frame,
      scope.shadowPath.join('>'),
      group.kind,
      group.label,
      occurrence,
    );
    resolving.delete(group.id);
    groupStableIds.set(group.id, result);
    return result;
  };

  for (const group of canonicalGroups) {
    const scope = groupScope(group.id);
    addNode({
      id: group.id,
      stableId: stableGroupId(group),
      kind: LANDMARK_KINDS.has(group.kind) ? 'landmark' : 'component',
      label: group.label,
      ref: { kind: 'group', id: group.id },
      scope: copyScope(scope),
      availability: group.conditional ? 'conditional' : 'current',
      children: [],
    });
    const controllerId = groupControllerId(group);
    const controller = controllerId === undefined ? undefined : actions.get(controllerId);
    const controlledComponent = controller !== undefined
      && controller.region !== group.id;
    attach(controlledComponent ? controller.id : canonicalGroupParent(group), group.id);
  }

  const collectionParent = (collection: Collection): string => {
    if (collection.groupId === undefined) return root;
    const presentationGroup = groups.get(collection.groupId);
    if (presentationGroup === undefined) return root;
    return presentationGroup.kind === 'collection'
      ? presentationGroup.parentGroup !== undefined
        && nodes.has(presentationGroup.parentGroup)
        ? presentationGroup.parentGroup
        : root
      : nodes.has(presentationGroup.id) ? presentationGroup.id : root;
  };
  const scopeForCollection = (collection: Collection): Scope => {
    if (collection.frame !== undefined || collection.shadowPath !== undefined) {
      return {
        frame: collection.frame ?? 'main',
        shadowPath: [...(collection.shadowPath ?? [])],
      };
    }
    return collection.groupId === undefined
      ? defaultScope
      : groupScope(collection.groupId);
  };

  const itemByCollectionAndKey = new Map<string, string>();
  const itemByCollectionAndAnchor = new Map<string, string[]>();
  const rowActionOwner = new Map<string, string>();
  const rowObservableOwner = new Map<string, string>();
  const fallbackItemByCollection = new Map<string, string>();
  const itemStableOccurrences = new Map<string, number>();

  const addItem = (
    collection: Collection,
    itemKey: string,
    anchor: string,
    position: number,
  ): string => {
    const id = `item:${collection.id}:${position + 1}`;
    const scope = scopeForCollection(collection);
    const stableKey = `${collection.templateId}|${itemKey || anchor}`;
    const stableOccurrence = itemStableOccurrences.get(stableKey) ?? 0;
    itemStableOccurrences.set(stableKey, stableOccurrence + 1);
    addNode({
      id,
      stableId: stableHash(
        'component-item-v1',
        collection.templateId,
        itemKey || anchor,
        stableOccurrence,
      ),
      kind: 'item',
      label: anchor || `Item ${position + 1}`,
      ref: { kind: 'collection_item', id: itemKey || `${collection.id}:${position + 1}` },
      scope: copyScope(scope),
      availability: 'current',
      children: [],
      ...(anchor === '' ? {} : { anchor }),
    });
    attach(collection.id, id);
    if (itemKey !== '') itemByCollectionAndKey.set(`${collection.id}|${itemKey}`, id);
    const anchorKey = `${collection.id}|${anchor}`;
    const anchorItems = itemByCollectionAndAnchor.get(anchorKey) ?? [];
    anchorItems.push(id);
    itemByCollectionAndAnchor.set(anchorKey, anchorItems);
    return id;
  };

  for (const collection of artifact.collections) {
    const scope = scopeForCollection(collection);
    const presentationGroup = collection.groupId === undefined
      ? undefined
      : groups.get(collection.groupId);
    addNode({
      id: collection.id,
      stableId: collection.templateId,
      kind: 'collection',
      label: collection.label,
      ref: { kind: 'collection', id: collection.id },
      scope: copyScope(scope),
      availability: presentationGroup?.conditional === true ? 'conditional' : 'current',
      children: [],
      instances: {
        observed: collection.instancesObserved,
        declared: collection.instancesDeclared,
        traversal: collection.traversal,
      },
    });
    attach(collectionParent(collection), collection.id);

    const rows = collection.rows ?? [];
    if (rows.length > 0) {
      rows.forEach((row, index) => {
        const item = addItem(collection, row.rowKey, row.anchor, index);
        if (row.anchorActionId !== undefined) rowActionOwner.set(row.anchorActionId, item);
        for (const cell of row.cells) {
          if (cell.actionId !== undefined) rowActionOwner.set(cell.actionId, item);
          if (cell.observableId !== undefined) rowObservableOwner.set(cell.observableId, item);
        }
      });
    } else {
      collection.anchors.forEach((anchor, index) => {
        addItem(collection, '', anchor, index);
      });
    }
  }

  const fallbackCollectionItem = (collection: Collection): string => {
    const known = fallbackItemByCollection.get(collection.id);
    if (known !== undefined) return known;
    const id = addItem(
      collection,
      `unassigned:${collection.templateId}`,
      'Other items',
      collection.rows?.length ?? collection.anchors.length,
    );
    fallbackItemByCollection.set(collection.id, id);
    return id;
  };

  const itemForMembership = (
    owner: Action | Observable,
    rowOwner: ReadonlyMap<string, string>,
  ): string | undefined => {
    const explicitRow = rowOwner.get(owner.id);
    if (explicitRow !== undefined) return explicitRow;
    if (owner.collection === undefined) return undefined;
    const byKey = itemByCollectionAndKey.get(
      `${owner.collection.id}|${owner.collection.itemKey}`,
    );
    if (byKey !== undefined) return byKey;
    const byAnchor = itemByCollectionAndAnchor.get(
      `${owner.collection.id}|${owner.collection.anchor}`,
    );
    if (byAnchor?.length === 1) return byAnchor[0];
    const collection = collections.get(owner.collection.id);
    return collection === undefined ? undefined : fallbackCollectionItem(collection);
  };

  const legacyCollectionOwner = (
    id: string,
    type: 'action' | 'observable',
  ): string | undefined => {
    for (const collection of artifact.collections) {
      const group = collection.groupId === undefined ? undefined : groups.get(collection.groupId);
      const owns = type === 'action'
        ? group?.actions.includes(id) === true
        : group?.observables.includes(id) === true;
      if (owns) return fallbackCollectionItem(collection);
    }
    return undefined;
  };

  const other = `component:other:${artifact.stateId}`;
  const ensureOther = (): string => {
    if (!nodes.has(other)) {
      addNode({
        id: other,
        stableId: stableHash('component-other-v1', artifact.stateId),
        kind: 'component',
        label: 'Other',
        scope: copyScope(defaultScope),
        availability: 'current',
        children: [],
      });
      attach(root, other);
    }
    return other;
  };

  for (const action of artifact.actions) {
    addNode({
      id: action.id,
      stableId: action.stableId,
      kind: 'control',
      label: action.label,
      ref: { kind: 'action', id: action.id },
      scope: { frame: action.frame, shadowPath: [...action.shadowPath] },
      availability: actionAvailability(action, groups),
      children: [],
    });
  }

  const parentActionDoesNotCycle = (action: Action): boolean => {
    let cursor = action.parentAction;
    const seen = new Set([action.id]);
    while (cursor !== undefined) {
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      cursor = actions.get(cursor)?.parentAction;
    }
    return true;
  };
  for (const action of artifact.actions) {
    const collectionItem = itemForMembership(action, rowActionOwner)
      ?? legacyCollectionOwner(action.id, 'action');
    const semanticGroup = nodes.has(action.region) ? action.region : undefined;
    const regionGroup = groups.get(action.region);
    const regionController = regionGroup === undefined
      ? undefined
      : groupControllerId(regionGroup);
    const controlledRegionOwnsChild = regionGroup !== undefined
      && action.parentAction !== undefined
      && regionController === action.parentAction
      && nodes.has(regionGroup.id);
    const owner = controlledRegionOwnsChild
      ? regionGroup.id
      : action.parentAction !== undefined
      && actions.has(action.parentAction)
      && parentActionDoesNotCycle(action)
      ? action.parentAction
      : collectionItem ?? semanticGroup ?? ensureOther();
    attach(owner, action.id);
  }

  for (const observable of artifact.observables) {
    addNode({
      id: observable.id,
      stableId: observable.stableId,
      kind: 'observable',
      label: observable.label,
      ref: { kind: 'observable', id: observable.id },
      scope: {
        frame: observable.frame,
        shadowPath: [...(observable.shadowPath ?? [])],
      },
      availability: observableAvailability(observable),
      children: [],
    });
    const collectionItem = itemForMembership(observable, rowObservableOwner)
      ?? legacyCollectionOwner(observable.id, 'observable');
    attach(
      collectionItem ?? (nodes.has(observable.region) ? observable.region : ensureOther()),
      observable.id,
    );
  }

  // Populate children from the unique parent index. Iteration order follows
  // the artifact's stable semantic/document order.
  for (const child of nodeOrder) {
    if (child === root) continue;
    const parent = parentByChild.get(child) ?? ensureOther();
    const parentNode = nodes.get(parent);
    if (parentNode !== undefined && !parentNode.children.includes(child)) {
      parentNode.children.push(child);
    }
  }

  const graphNodeToTreeNode = (graphNodeId: string): string | undefined => {
    if (graphNodeId.startsWith('a:')) {
      const id = graphNodeId.slice(2);
      return nodes.has(id) ? id : undefined;
    }
    if (graphNodeId.startsWith('g:')) {
      const id = graphNodeId.slice(2);
      if (nodes.has(id)) return id;
      return artifact.collections.find(({ groupId }) => groupId === id)?.id;
    }
    if (graphNodeId.startsWith('s:')) return root;
    return undefined;
  };
  const relations: ComponentTreeRelation[] = [];
  for (const edge of artifact.navigationGraph?.edges ?? []) {
    if (edge.kind !== 'reveals') continue;
    const from = graphNodeToTreeNode(edge.from);
    const to = graphNodeToTreeNode(edge.to);
    if (from === undefined || to === undefined) continue;
    relations.push({
      from,
      to,
      kind: 'reveals',
      ...(edge.gesture === undefined ? {} : { gesture: edge.gesture }),
      ...(edge.order === undefined ? {} : { order: edge.order }),
    });
  }
  for (const action of artifact.actions) {
    if (action.observedDestination === undefined) continue;
    relations.push({
      from: action.id,
      kind: 'navigates',
      destination: action.observedDestination,
    });
  }
  const uniqueRelations = [...new Map(
    relations.map((relation) => [relationKey(relation), relation]),
  ).values()];

  return collapseRedundantStructuralWrappers({
    root,
    nodes: nodeOrder.map((id) => nodes.get(id) as ComponentTreeNode),
    relations: uniqueRelations,
  });
}

/** Return semantic ancestor labels through the referenced leaf. */
export function componentPathForRef(
  artifact: StateArtifact,
  refId: string,
): string[] {
  const tree = artifact.componentTree ?? buildComponentTree(artifact);
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  if (!nodes.has(refId)) return [];
  const parent = new Map<string, string>();
  for (const node of tree.nodes) {
    for (const child of node.children) {
      if (!parent.has(child)) parent.set(child, node.id);
    }
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = refId;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const node: ComponentTreeNode | undefined = nodes.get(cursor);
    if (node === undefined) break;
    if (node.kind !== 'page' && node.label !== 'Other' && node.label !== 'Other items') {
      result.unshift(node.label);
    }
    cursor = parent.get(cursor);
  }
  return result.filter((label, index) =>
    index === 0 || label.toLocaleLowerCase() !== result[index - 1]?.toLocaleLowerCase(),
  );
}

/** Build a pure local-ref -> semantic breadcrumb lookup for prompt projection. */
export function componentPathIndex(artifact: StateArtifact): Map<string, string[]> {
  const tree = artifact.componentTree ?? buildComponentTree(artifact);
  const projected = artifact.componentTree === undefined
    ? { ...artifact, componentTree: tree }
    : artifact;
  return new Map(
    tree.nodes
      .filter(({ ref }) => ref?.kind === 'action' || ref?.kind === 'observable')
      .map((node) => [node.id, componentPathForRef(projected, node.id)]),
  );
}
