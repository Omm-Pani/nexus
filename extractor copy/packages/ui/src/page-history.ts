/** Minimal state shape needed to group extraction history into page tabs. */
export interface UrlState {
  stateId: string;
  url: string;
}

export interface ExactUrlPage<T extends UrlState> {
  key: string;
  url: string;
  states: T[];
}

/**
 * Preserve the browser's absolute serialized URL as the page identity.
 *
 * URL parsing is used only to obtain the platform serialization. Query
 * parameters are never sorted or removed: applications are allowed to treat
 * their order (and repeated values) as meaningful navigation state.
 */
export function exactPageKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Keep every captured state for the exact same address under one page tab. */
export function groupStatesByExactUrl<T extends UrlState>(
  states: readonly T[],
): ExactUrlPage<T>[] {
  const pages: ExactUrlPage<T>[] = [];
  const byUrl = new Map<string, ExactUrlPage<T>>();
  for (const state of states) {
    const key = exactPageKey(state.url);
    let page = byUrl.get(key);
    if (page === undefined) {
      page = { key, url: key, states: [] };
      byUrl.set(key, page);
      pages.push(page);
    }
    page.states.push(state);
  }
  return pages;
}

/** The live page owns the current state; inspecting history must not change it. */
export function pageContainsCurrentState(
  stateIds: readonly string[],
  currentStateId: string | null,
): boolean {
  return currentStateId !== null && stateIds.includes(currentStateId);
}
