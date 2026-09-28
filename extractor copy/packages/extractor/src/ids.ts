import {
  ACTION_ELEMENT_ID_PREFIXES,
  parseElementId,
  type Action,
  type ActionElementIdPrefix,
  type ElementIdPrefix,
  type TypePrefixedElementId,
} from '@nexus/schema';

import type { RawAction } from './instrument/types.js';

const ACTION_PREFIXES = new Set<string>(ACTION_ELEMENT_ID_PREFIXES);

/**
 * Allocate one-based state-local IDs independently for every semantic prefix.
 * Existing current-format IDs seed their own counters, which makes the helper
 * safe when additional findings are folded into an already-extracted state.
 */
export class StateElementIdAllocator {
  readonly #nextByPrefix = new Map<ElementIdPrefix, number>();

  constructor(existing: readonly string[] = []) {
    for (const id of existing) {
      const parsed = parseElementId(id);
      if (parsed === null) continue;
      this.#nextByPrefix.set(
        parsed.prefix,
        Math.max(this.#nextByPrefix.get(parsed.prefix) ?? 1, parsed.index + 1),
      );
    }
  }

  /** Reserve one ordinal for a legacy element whose old ID carried no subtype. */
  reserve(prefix: ElementIdPrefix): void {
    this.#nextByPrefix.set(prefix, (this.#nextByPrefix.get(prefix) ?? 1) + 1);
  }

  next(prefix: ElementIdPrefix): TypePrefixedElementId {
    const index = this.#nextByPrefix.get(prefix) ?? 1;
    this.#nextByPrefix.set(prefix, index + 1);
    return `${prefix}${index}` as TypePrefixedElementId;
  }
}

function rolePrefix(role: string): ActionElementIdPrefix | undefined {
  switch (role.toLocaleLowerCase('en-US')) {
    case 'checkbox':
    case 'menuitemcheckbox':
      return 'chk';
    case 'radio':
    case 'menuitemradio':
      return 'rad';
    case 'switch':
      return 'tog';
    default:
      return undefined;
  }
}

/** Exact prefix selection while the raw DOM semantics are still available. */
export function rawActionElementIdPrefix(raw: RawAction): ActionElementIdPrefix {
  if (raw.type === 'navigation' || raw.kind === 'navigate') return 'lnk';
  if (raw.kind === 'upload' || raw.inputType === 'file') return 'upl';
  if (raw.kind === 'select' || raw.tag === 'select' || raw.role === 'combobox') return 'sel';
  if (raw.evidence.includes('contenteditable')) return 'txt';

  const semanticToggle = rolePrefix(raw.role);
  if (semanticToggle !== undefined) return semanticToggle;
  if (raw.inputType === 'checkbox') return 'chk';
  if (raw.inputType === 'radio') return 'rad';
  if (raw.state.pressed !== null || raw.type === 'toggle') return 'tog';
  if (raw.inputType === 'password') return 'pwd';
  if (raw.type === 'input' || raw.kind === 'input') return 'inp';
  return 'btn';
}

/**
 * Recover an action's semantic prefix from a current artifact ID, or infer it
 * from the public action fields for a persisted pre-migration artifact.
 */
export function actionElementIdPrefix(action: Action): ActionElementIdPrefix {
  const parsed = parseElementId(action.id);
  if (parsed !== null && ACTION_PREFIXES.has(parsed.prefix)) {
    return parsed.prefix as ActionElementIdPrefix;
  }
  if (action.type === 'navigation' || action.kind === 'navigate') return 'lnk';
  if (action.kind === 'upload') return 'upl';
  if (action.kind === 'select') return 'sel';
  if (action.evidence.includes('contenteditable')) return 'txt';

  const role = action.locators.find(({ kind }) => kind === 'role_name')?.role ?? '';
  const semanticToggle = rolePrefix(role);
  if (semanticToggle !== undefined) return semanticToggle;
  if (action.state.pressed !== undefined || action.type === 'toggle') return 'tog';

  // Old artifacts did not retain input[type]. This conservative fallback only
  // distinguishes password fields when their accessible metadata says so;
  // it never changes the stableId or locator recipe.
  const fieldContext = `${action.label} ${action.placeholder ?? ''} ${action.locators
    .map(({ value }) => value)
    .join(' ')}`;
  if (action.type === 'input' && /(?:^|[^a-z])(?:password|passwd|pwd)(?:[^a-z]|$)/iu.test(fieldContext)) {
    return 'pwd';
  }
  if (action.type === 'input' || action.kind === 'input') return 'inp';
  return 'btn';
}

/** Seed an inventory allocator without renumbering persisted legacy elements. */
export function allocatorForArtifact(
  actions: readonly Action[],
  observableIds: readonly string[],
  collectionIds: readonly string[],
): StateElementIdAllocator {
  const allIds = [
    ...actions.map(({ id }) => id),
    ...observableIds,
    ...collectionIds,
  ];
  const allocator = new StateElementIdAllocator(allIds);
  for (const action of actions) {
    if (parseElementId(action.id) === null) allocator.reserve(actionElementIdPrefix(action));
  }
  for (const id of observableIds) {
    if (parseElementId(id) === null) allocator.reserve('obs');
  }
  for (const id of collectionIds) {
    if (parseElementId(id) === null) allocator.reserve('col');
  }
  return allocator;
}
