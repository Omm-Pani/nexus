import type { DomElement } from '@nexus/schema';

export interface ElementStateChange { title: string; changes: string[]; value?: string }
const text = (value: string) => value.replace(/\s+/gu, ' ').trim();
const properties = ['value', 'checked', 'selected', 'selectedIndex', 'disabled', 'readOnly', 'required', 'open', 'indeterminate'] as const;
const attributes = ['aria-expanded', 'aria-pressed', 'aria-selected', 'aria-checked', 'aria-disabled', 'aria-invalid', 'aria-busy', 'aria-required', 'aria-readonly', 'placeholder', 'aria-label', 'href', 'src', 'alt', 'title'] as const;
const meaningful = (element: DomElement): boolean => !['html', 'body', 'head', 'script', 'style', 'link', 'meta', 'template'].includes(element.tag)
  && (text(element.text) !== '' || /^(input|textarea|select|option|button|a|img|details|summary|video|audio)$/.test(element.tag)
    || !!element.attributes.role || !!element.attributes['aria-label']);

/** User-visible state, rather than framework bookkeeping or CSS churn. */
export function elementStateChange(before: DomElement | undefined, after: DomElement | undefined, label: string, omitInputValue = false): ElementStateChange | null {
  const element = after ?? before;
  if (!element || !meaningful(element)) return null;
  if (!before || !after || before.visible !== after.visible) {
    if (!element.visible && (!before || !after)) return null;
    return { title: `${after?.visible ? 'Show' : 'Hide'} ${label}`, changes: [after?.visible ? 'Visible' : 'Hidden'] };
  }
  const changes: string[] = [];
  let title = `${label} state changed`;
  let value: string | undefined;
  for (const key of properties) {
    if (key === 'value' && omitInputValue) continue;
    const old = before.state[key] ?? (key === 'value' ? before.attributes.value : undefined);
    const next = after.state[key] ?? (key === 'value' ? after.attributes.value : undefined);
    if (old === next) continue;
    changes.push(`${key}: ${String(next ?? '')}`);
    if (key === 'value') { title = `Set ${label}`; value = String(next ?? ''); }
    if (key === 'disabled') title = `${next ? 'Disable' : 'Enable'} ${label}`;
    if (key === 'checked') title = `${next ? 'Check' : 'Uncheck'} ${label}`;
    if (key === 'open') title = `${next ? 'Open' : 'Close'} ${label}`;
  }
  for (const key of attributes) {
    if (before.attributes[key] === after.attributes[key]) continue;
    const next = after.attributes[key];
    changes.push(`${key.replace(/^aria-/, '')}: ${next ?? 'unset'}`);
    if (key === 'aria-expanded') title = `${next === 'true' ? 'Expand' : 'Collapse'} ${label}`;
    if (key === 'aria-invalid') title = `Mark ${label} ${next && next !== 'false' ? 'invalid' : 'valid'}`;
  }
  if (text(before.text) !== text(after.text) && (before.visible || after.visible)) {
    title = `Update ${label} text`; value = text(after.text); changes.push(`Text: ${value}`);
  }
  return changes.length ? { title, changes, ...(value === undefined ? {} : { value }) } : null;
}
