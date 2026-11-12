/*
 * This function is deliberately self-contained. Playwright serializes it and
 * executes it in an isolated world before application code. Do not close over
 * module values from this file.
 */
export function nexusBootstrap(): void {
  type Listener = EventListenerOrEventListenerObject;
  type MaterialCause =
    | 'initial'
    | 'dom'
    | 'shadow'
    | 'value'
    | 'history'
    | 'scroll'
    | 'interaction';
  type SemanticSurface = {
    digest: string;
    presentationDigest: string;
    actions: number;
    observables: number;
    regions: number;
  };
  type NexusRuntime = {
    version: number;
    listenerTypes(target: EventTarget): string[];
    shadowRoot(host: Element): ShadowRoot | null;
    registerShadowRoot(root: ShadowRoot): void;
    quiescent(): {
      settled: boolean;
      inflight: number;
      msSinceLastMutation: number;
      msSinceLastActivity: number;
      epoch: number;
      causes: MaterialCause[];
    };
    waitForQuiescence(timeoutMs?: number): Promise<boolean>;
    semanticSurfaceDigest(): SemanticSurface;
    deepElementCount(): number;
    highlight(items: Array<{
      x: number; y: number; w: number; h: number;
      label?: string; tone?: string; primary?: boolean; selector?: string; shadowPath?: string[];
    }>): void;
    clearHighlight(): void;
    extract(options: { framePath: string; maxNodes?: number; maxDepth?: number }): unknown;
  };

  const scope = window as typeof window & {
    __nexus?: NexusRuntime;
    /** Receives a JSON-encoded material-settled notification. */
    __nexusSettled?: (state: string) => void;
  };

  if (scope.__nexus?.version === 1) return;

  const OVERLAY_ATTRIBUTE = 'data-nexus-overlay';

  const listeners = new WeakMap<EventTarget, Map<string, Set<Listener>>>();
  const shadowRoots = new WeakMap<Element, ShadowRoot>();
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const originalAttachShadow = Element.prototype.attachShadow;
  const originalPushState = History.prototype.pushState;
  const originalReplaceState = History.prototype.replaceState;
  const originalFetch = window.fetch;
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;
  const quietAfterMs = 150;
  const ignoredNetwork = [
    /(?:^|[\/_-])(?:events?|sse|stream|socket|notifications?)(?:[\/_?&-]|$)/iu,
  ];
  let inflight = 0;
  let lastMutation = performance.now();
  let lastActivity = lastMutation;
  let materialEpoch = 1;
  let materialDirty = true;
  let lastNotifiedEpoch = 0;
  const materialCauses = new Set<MaterialCause>(['initial']);
  let settleTimer: number | null = null;
  const settleWaiters = new Set<(settled: boolean) => void>();
  let mutations: MutationObserver | null = null;

  const preserveSource = <T extends Function>(wrapper: T, original: Function): T => {
    try {
      Object.defineProperty(wrapper, 'toString', {
        configurable: true,
        value: original.toString.bind(original),
      });
    } catch {
      // Some hardened pages make function properties non-configurable.
    }
    return wrapper;
  };

  const normalizedText = (value: string | null | undefined, limit = 180): string =>
    (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);

  const quiescent = () => {
    const now = performance.now();
    const msSinceLastMutation = Math.max(0, now - lastMutation);
    const msSinceLastActivity = Math.max(0, now - lastActivity);
    return {
      settled: inflight === 0 && msSinceLastActivity > quietAfterMs,
      inflight,
      msSinceLastMutation,
      msSinceLastActivity,
      epoch: materialEpoch,
      causes: materialDirty ? Array.from(materialCauses).sort() : [],
    };
  };

  const emitSettled = () => {
    settleTimer = null;
    const state = quiescent();
    if (!state.settled) {
      // Network completion schedules the next check. While requests remain in
      // flight, repeatedly waking every 151ms only burns CPU on polling-heavy
      // applications. The strict quiet boundary still needs one short re-arm.
      if (inflight === 0) scheduleSettleCheck();
      return;
    }
    for (const resolve of settleWaiters) resolve(true);
    settleWaiters.clear();

    // Quiescence and material change are deliberately separate. waiters care
    // that requests/DOM activity became quiet, but automatic capture should be
    // notified only once for a new semantic epoch. In particular, a completed
    // fetch/XHR with no resulting page change must stop here.
    if (!materialDirty || materialEpoch <= lastNotifiedEpoch) return;
    const causes = Array.from(materialCauses).sort();
    const notification = {
      ...state,
      epoch: materialEpoch,
      causes,
      surface: semanticSurfaceDigest(),
    };
    lastNotifiedEpoch = materialEpoch;
    materialDirty = false;
    materialCauses.clear();
    try {
      window.dispatchEvent(new CustomEvent('nexus:settled', { detail: notification }));
      // A CDP Runtime binding can only carry a single string argument, while
      // Playwright's exposeBinding carries structured values. Sending JSON
      // satisfies both, so one bootstrap serves both drivers.
      void scope.__nexusSettled?.(JSON.stringify(notification));
    } catch {
      // Instrumentation notifications are advisory and must not affect the app.
    }
  };

  const scheduleSettleCheck = () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    const remaining = Math.max(
      0,
      quietAfterMs - Math.max(0, performance.now() - lastActivity) + 1,
    );
    settleTimer = window.setTimeout(emitSettled, remaining);
  };

  const belongsToInspector = (node: Node): boolean => {
    let cursor: Node | null = node;
    while (cursor !== null) {
      if (cursor instanceof Element && cursor.hasAttribute(OVERLAY_ATTRIBUTE)) return true;
      cursor = cursor.parentNode ?? (cursor instanceof ShadowRoot ? cursor.host : null);
    }
    return false;
  };

  const mutationBelongsToInspector = (record: MutationRecord): boolean => {
    if (belongsToInspector(record.target)) return true;
    if (record.type !== 'childList') return false;
    const changed = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
    return changed.length > 0 && changed.every((node) => belongsToInspector(node));
  };

  const markMutation = (
    signal?: Event | MutationRecord[],
    explicitCause?: MaterialCause,
  ): void => {
    if (
      Array.isArray(signal)
      && signal.length > 0
      && signal.every(mutationBelongsToInspector)
    ) return;
    if (
      signal instanceof Event
      && signal.target instanceof Node
      && belongsToInspector(signal.target)
    ) return;

    let cause = explicitCause;
    if (cause === undefined && Array.isArray(signal)) {
      cause = signal.some(({ target }) => target.getRootNode() instanceof ShadowRoot)
        ? 'shadow'
        : 'dom';
    } else if (cause === undefined && signal instanceof Event) {
      cause = signal.type === 'scroll'
        ? 'scroll'
        : signal.type === 'input' || signal.type === 'change'
          ? 'value'
          : 'interaction';
    }
    cause ??= 'dom';

    const now = performance.now();
    lastMutation = now;
    lastActivity = now;
    if (!materialDirty) {
      materialEpoch += 1;
      materialDirty = true;
    }
    materialCauses.add(cause);
    scheduleSettleCheck();
  };

  const beginNetwork = () => {
    inflight += 1;
    lastActivity = performance.now();
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = null;
  };

  const endNetwork = () => {
    inflight = Math.max(0, inflight - 1);
    lastActivity = performance.now();
    if (inflight === 0) scheduleSettleCheck();
  };

  const addWrapper = preserveSource(function addEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener !== null) {
      let byType = listeners.get(this);
      if (byType === undefined) {
        byType = new Map();
        listeners.set(this, byType);
      }
      let registered = byType.get(type);
      if (registered === undefined) {
        registered = new Set();
        byType.set(type, registered);
      }
      registered.add(listener);
    }
    return originalAdd.call(this, type, listener, options);
  }, originalAdd);

  const removeWrapper = preserveSource(function removeEventListener(
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (listener !== null) {
      const byType = listeners.get(this);
      const registered = byType?.get(type);
      registered?.delete(listener);
      if (registered?.size === 0) byType?.delete(type);
    }
    return originalRemove.call(this, type, listener, options);
  }, originalRemove);

  const attachShadowWrapper = preserveSource(function attachShadow(
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const root = originalAttachShadow.call(this, init);
    shadowRoots.set(this, root);
    if (!this.hasAttribute(OVERLAY_ATTRIBUTE)) {
      mutations?.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (const type of ['input', 'change', 'scroll', 'pointerup', 'mouseup']) {
        originalAdd.call(root, type, markMutation, { capture: true, passive: true });
      }
      markMutation(undefined, 'shadow');
    }
    return root;
  }, originalAttachShadow);

  const pushStateWrapper = preserveSource(function pushState(
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPushState.call(this, data, unused, url);
    markMutation(undefined, 'history');
  }, originalPushState);

  const replaceStateWrapper = preserveSource(function replaceState(
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplaceState.call(this, data, unused, url);
    markMutation(undefined, 'history');
  }, originalReplaceState);

  const fetchWrapper = preserveSource(function fetch(
    this: typeof window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const ignored = ignoredNetwork.some((pattern) => pattern.test(url));
    if (!ignored) beginNetwork();
    let result: Promise<Response>;
    try {
      result = originalFetch.call(this, input, init);
    } catch (error) {
      if (!ignored) endNetwork();
      throw error;
    }
    if (!ignored) void result.then(endNetwork, endNetwork);
    return result;
  }, originalFetch);

  const xhrOpenWrapper = preserveSource(function open(
    this: XMLHttpRequest & { __nexusUrl?: string },
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    this.__nexusUrl = String(url);
    return originalXhrOpen.call(this, method, String(url), async, username, password);
  }, originalXhrOpen);

  const xhrSendWrapper = preserveSource(function send(
    this: XMLHttpRequest & { __nexusUrl?: string },
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const ignored = ignoredNetwork.some((pattern) => pattern.test(this.__nexusUrl ?? ''));
    if (!ignored) {
      beginNetwork();
      originalAdd.call(this, 'loadend', endNetwork, { once: true });
    }
    try {
      return originalXhrSend.call(this, body);
    } catch (error) {
      if (!ignored) endNetwork();
      throw error;
    }
  }, originalXhrSend);

  EventTarget.prototype.addEventListener = addWrapper;
  EventTarget.prototype.removeEventListener = removeWrapper;
  Element.prototype.attachShadow = attachShadowWrapper;
  History.prototype.pushState = pushStateWrapper;
  History.prototype.replaceState = replaceStateWrapper;
  window.fetch = fetchWrapper;
  XMLHttpRequest.prototype.open = xhrOpenWrapper as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = xhrSendWrapper;

  mutations = new MutationObserver((records) => markMutation(records));
  mutations.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });

  // A MutationObserver attached to Document does not cross a shadow boundary.
  // Observe every open root that was already present when instrumentation was
  // installed, and every open/closed root retained by the attachShadow wrapper.
  // The recursive pass also covers open roots nested several levels deep.
  const observeExistingShadowRoots = (root: Document | ShadowRoot): void => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      const shadow = element.shadowRoot ?? shadowRoots.get(element);
      if (shadow === undefined || shadow === null) continue;
      if (element.hasAttribute(OVERLAY_ATTRIBUTE)) continue;
      mutations?.observe(shadow, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (const type of ['input', 'change', 'scroll', 'pointerup', 'mouseup']) {
        originalAdd.call(shadow, type, markMutation, { capture: true, passive: true });
      }
      observeExistingShadowRoots(shadow);
    }
  };
  observeExistingShadowRoots(document);

  // Value/property-only native interaction does not necessarily mutate DOM:
  // typing changes HTMLInputElement.value, checking changes .checked, and
  // scrolling only changes layout coordinates. Capture-phase advisory signals
  // keep the desktop scanner fresh without preventing or rewriting any event.
  for (const type of ['input', 'change', 'scroll', 'pointerup', 'mouseup']) {
    originalAdd.call(document, type, markMutation, { capture: true, passive: true });
  }
  const markPresentationMutation = (event: Event): void => {
    markMutation(event, 'scroll');
  };
  // Document-level capture observes element scrollers, while the root
  // viewport's scroll event is dispatched on Window in Chromium.
  originalAdd.call(window, 'scroll', markPresentationMutation, { passive: true });
  originalAdd.call(window, 'resize', markPresentationMutation, { passive: true });
  if (window.visualViewport !== null) {
    originalAdd.call(window.visualViewport, 'resize', markPresentationMutation, { passive: true });
    originalAdd.call(window.visualViewport, 'scroll', markPresentationMutation, { passive: true });
  }
  scheduleSettleCheck();

  const cssEscape = (value: string): string => {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
  };

  const dehashClass = (value: string): string =>
    value.replace(/([-_])([a-z0-9]{5,})$/iu, (full, separator: string, suffix: string) => {
      // Do not erase ordinary semantic BEM/utility words such as
      // site-header or main-content. CSS-module hashes normally expose at
      // least one entropy signal (digits, mixed case, or a long hex token).
      // A lowercase alphabetic token with no such signal is retained; a
      // missed opaque class is safer than destroying the landmark vocabulary.
      const hasDigit = /\d/u.test(suffix);
      const mixedCase = /[a-z]/u.test(suffix) && /[A-Z]/u.test(suffix);
      const longHex = suffix.length >= 8 && /^[a-f0-9]+$/iu.test(suffix);
      return hasDigit || mixedCase || longHex ? `${separator}*` : full;
    });

  const humanize = (value: string): string =>
    (() => {
      const normalized = normalizedText(
      value
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .replace(/[-_]+/gu, ' ')
        .replace(/\b(?:btn|ctl)\b/giu, '')
        .replace(/\bdelegated\b/giu, ''),
      );
      return normalized === ''
        ? ''
        : `${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}`;
    })();

  const uniqueTestSelector = (element: Element): string | null => {
    for (const attribute of ['data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `[${attribute}="${value.replace(/"/gu, '\\"')}"]`;
      // Test attributes are usually unique controls, but repeated row roots
      // frequently share values such as data-test="inventory-item".  Returning
      // that selector directly gave every object the same nodeKey/rowKey and
      // later maps silently overwrote all but one row.  Only take the compact
      // form when it is actually unique in its document/shadow scope.
      try {
        const root = element.getRootNode() as Document | ShadowRoot;
        if (root.querySelectorAll(selector).length === 1) return selector;
      } catch {
        // A hostile custom root may reject selector evaluation.
      }
    }
    return null;
  };

  const uniqueIdSelector = (element: Element): string | null => {
    if (element.id === '') return null;
    const selector = `#${cssEscape(element.id)}`;
    try {
      const root = element.getRootNode() as Document | ShadowRoot;
      return root.querySelectorAll(selector).length === 1 ? selector : null;
    } catch {
      return null;
    }
  };

  const structuralSelector = (element: Element, stop?: Element): string => {
    const idSelector = uniqueIdSelector(element);
    if (idSelector !== null) return idSelector;
    const testSelector = uniqueTestSelector(element);
    if (testSelector !== null) return testSelector;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== stop) {
      const ancestorId = uniqueIdSelector(current);
      if (ancestorId !== null) {
        parts.unshift(ancestorId);
        break;
      }
      const ancestorTest = uniqueTestSelector(current);
      if (ancestorTest !== null) {
        parts.unshift(ancestorTest);
        break;
      }
      let part = current.localName;
      const stableClasses = Array.from(current.classList)
        .map(dehashClass)
        .filter((name) => !name.includes('*'))
        .slice(0, 2);
      if (stableClasses.length > 0) {
        part += stableClasses.map((name) => `.${cssEscape(name)}`).join('');
      }
      const parentElement: Element | null = current.parentElement;
      if (parentElement !== null) {
        const currentTag = current.localName;
        const sameTag = Array.from(parentElement.children).filter(
          (sibling: Element) => sibling.localName === currentTag,
        );
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parentElement;
    }
    return parts.join(' > ') || element.localName;
  };

  const implicitRole = (element: Element): string => {
    const tag = element.localName;
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (tag === 'table') return 'table';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'input') {
      const type = (element.getAttribute('type') ?? 'text').trim().toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      if (type !== 'hidden') return 'textbox';
    }
    return '';
  };

  const associatedLabel = (element: Element): string => {
    if ('labels' in element) {
      const labelled = element as HTMLInputElement;
      const value = normalizedText(
        Array.from(labelled.labels ?? [], (label) => label.textContent ?? '').join(' '),
      );
      if (value !== '') return value;
    }
    const parentLabel = element.closest('label');
    return normalizedText(parentLabel?.textContent);
  };

  const labelledByText = (element: Element): string => {
    const ids = element.getAttribute('aria-labelledby');
    if (!ids) return '';
    const root = element.getRootNode() as Document | ShadowRoot;
    return normalizedText(
      ids
        .split(/\s+/u)
        .map((id) => root.querySelector(`#${cssEscape(id)}`)?.textContent ?? '')
        .join(' '),
    );
  };

  const accessibleName = (element: Element): string => {
    const semanticRole = element.getAttribute('role') ?? implicitRole(element);
    const choiceControl = element.localName === 'select'
      || semanticRole === 'combobox'
      || semanticRole === 'listbox';
    const inputType = element.localName === 'input'
      ? (element.getAttribute('type') ?? 'text').trim().toLowerCase()
      : '';
    const inputButtonName = element.localName === 'input'
      && ['button', 'submit', 'reset'].includes(inputType)
      ? normalizedText((element as HTMLInputElement).value)
        || (inputType === 'submit' ? 'Submit' : inputType === 'reset' ? 'Reset' : null)
      : null;
    const descendantVisualName = normalizedText(element.textContent) === ''
      ? Array.from(element.querySelectorAll(
          'img[alt], [role="img"][aria-label], svg[aria-label], svg > title',
        )).map((visual) => normalizedText(
          visual.getAttribute('alt')
          || visual.getAttribute('aria-label')
          || visual.textContent,
        )).find((value) => value !== '') ?? null
      : null;
    const identity = element.id || element.getAttribute('data-testid')
      || element.getAttribute('data-test') || element.getAttribute('data-cy')
      || (choiceControl ? element.getAttribute('name') : null);
    const renderedText = normalizedText(element.textContent);
    const countOnlyText = /^(?:\d+(?:[.,]\d+)?\+?)$/u.test(renderedText);
    const actionIdentityName = identity && countOnlyText && element.children.length > 0
      ? normalizedText(
          humanize(identity).replace(
            /\s+(?:link|anchor|button|control)$/iu,
            '',
          ),
        )
      : null;
    // A select's textContent is the concatenation of every <option>.  It is
    // its choice catalogue, not the control's accessible name.  Treating it
    // as the name produced labels such as "Name (A to Z)Name (Z to A)..."
    // and made the choices look like a free-standing menu.  Stable control
    // identities are a much better last-resort semantic label.
    const choiceControlIdentityName = choiceControl && identity
      ? normalizedText(
          humanize(identity).replace(
            /\s+(?:container|selector|select|combobox|control|field|input)$/iu,
            '',
          ),
        )
      : null;
    const candidates = [
      element.getAttribute('aria-label'),
      labelledByText(element),
      associatedLabel(element),
      element.getAttribute('alt'),
      descendantVisualName,
      inputButtonName,
      element.getAttribute('title'),
      element.getAttribute('placeholder'),
      element.closest('figure')?.querySelector('figcaption')?.textContent,
      choiceControlIdentityName,
      // Icon controls often contain only a changing badge count. That count
      // is useful state, but it is not the control's purpose. Prefer a stable
      // semantic test/id identity for the action name in that narrow case;
      // the descendant badge is still extracted independently as an
      // observable value.
      actionIdentityName,
      choiceControl && element.querySelector('option, [role="option"]') !== null
        ? null
        : renderedText,
      element.getAttribute('name'),
    ];
    for (const candidate of candidates) {
      const value = normalizedText(candidate);
      if (value !== '') return value;
    }
    if (identity) return humanize(identity);
    if (choiceControl) return humanize(semanticRole || 'select');
    const href = element.getAttribute('href');
    if (href) return normalizedText(href);
    return `${humanize(element.localName)} ${structuralSelector(element)}`.slice(0, 180);
  };

  const parseBoolean = (value: string | null): boolean | null => {
    if (value === null) return null;
    return value.toLowerCase() === 'true';
  };

  const valueType = (
    value: string,
    label: string,
  ): 'currency' | 'number' | 'percent' | 'date' | 'text' | 'count' => {
    if (/^(?:[$€£₹]|USD\s*)[-+]?\d[\d,]*(?:\.\d+)?$/u.test(value)) return 'currency';
    if (/^[-+]?\d+(?:\.\d+)?\s*%$/u.test(value)) return 'percent';
    if (/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/u.test(value)) return 'date';
    if (/\b(?:count|quantity|badge)\b/iu.test(label) || /^\d+$/u.test(value)) {
      return 'count';
    }
    if (/^[-+]?\d+(?:\.\d+)?$/u.test(value)) return 'number';
    return 'text';
  };

  const observableLabel = (element: Element, currentValue: string): string => {
    const explicit = normalizedText(element.getAttribute('aria-label'))
      || labelledByText(element);
    if (explicit !== '') return explicit;
    const idOrClass = element.id || Array.from(element.classList)[0] || '';
    if (idOrClass !== '') {
      const derived = humanize(idOrClass);
      if (derived !== '') return derived;
    }
    const withoutValue = normalizedText(
      currentValue
        .replace(/(?:[$€£₹]|USD\s*)[-+]?\d[\d,]*(?:\.\d+)?/gu, '')
        .replace(/\b\d+(?:\.\d+)?\b/gu, ''),
    ).replace(/[:\s]+$/u, '');
    return withoutValue || 'Value';
  };

  const riskFor = (label: string, kind: string): 'safe' | 'reversible' | 'mutating' | 'destructive' | 'unknown' => {
    const lower = label.toLocaleLowerCase();
    if (/(?:delete|remove|revoke|refund|terminate|erase|reset\s+(?:app|state)|हटाएँ|حذف)/iu.test(lower)) {
      return 'destructive';
    }
    if (kind === 'navigate' || /(?:download|validate|verify|check|help)/iu.test(lower)) return 'safe';
    if (
      ['input', 'select', 'toggle', 'open', 'close', 'expand', 'collapse', 'switch_tab'].includes(kind)
      || /(?:increment|decrement|calculate|reset\s+count|filter|sort)/iu.test(lower)
    ) return 'reversible';
    if (/(?:save|create|add|submit|purchase|buy|checkout|edit|logout|log out|अपलोड|إنشاء)/iu.test(lower)) {
      return 'mutating';
    }
    return 'unknown';
  };

  const classifyAction = (
    element: Element,
    role: string,
    label: string,
  ): {
    type: 'navigation' | 'button' | 'input' | 'toggle';
    kind: 'navigate' | 'input' | 'select' | 'toggle' | 'open' | 'close' | 'expand' | 'collapse' | 'switch_tab' | 'submit' | 'upload' | 'unknown';
    risk: 'safe' | 'reversible' | 'mutating' | 'destructive' | 'unknown';
  } => {
    const tag = element.localName;
    const inputType = (element.getAttribute('type') ?? '').trim().toLowerCase();
    const lower = label.toLocaleLowerCase();
    let type: 'navigation' | 'button' | 'input' | 'toggle' = 'button';
    let kind: 'navigate' | 'input' | 'select' | 'toggle' | 'open' | 'close' | 'expand' | 'collapse' | 'switch_tab' | 'submit' | 'upload' | 'unknown' = 'unknown';
    if ((tag === 'a' && element.hasAttribute('href')) || role === 'link') {
      type = 'navigation';
      kind = 'navigate';
    } else if (tag === 'select') {
      type = 'input';
      kind = 'select';
    } else if (role === 'combobox') {
      if (tag === 'input' || tag === 'textarea' || element.hasAttribute('contenteditable')) {
        type = 'input';
        kind = 'input';
      } else {
        type = 'button';
        kind = 'open';
      }
    } else if (role === 'option') {
      // Custom options are operated by clicking the concrete option. Native
      // <option> values are separately enumerated from their <select> owner.
      type = 'button';
      kind = 'unknown';
    } else if (['checkbox', 'radio', 'switch'].includes(role) || ['checkbox', 'radio'].includes(inputType)) {
      type = 'toggle';
      kind = 'toggle';
    } else if (tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(inputType)) {
      type = 'button';
      kind = ['submit', 'image'].includes(inputType) ? 'submit' : 'unknown';
    } else if (tag === 'textarea' || tag === 'input' || element.hasAttribute('contenteditable') || role === 'textbox') {
      type = 'input';
      kind = inputType === 'file' ? 'upload' : 'input';
    } else if (role === 'tab') {
      type = 'button';
      kind = 'switch_tab';
    } else if (tag === 'summary') {
      type = 'button';
      kind = element.closest('details')?.hasAttribute('open') === true ? 'collapse' : 'expand';
    } else if (element.hasAttribute('popovertarget') || element.hasAttribute('commandfor')) {
      type = 'button';
      const command = (
        element.getAttribute('popovertargetaction')
        ?? element.getAttribute('command')
        ?? 'toggle'
      ).toLocaleLowerCase();
      kind = command.includes('hide') || command.includes('close') ? 'close' : 'open';
    } else if (element.getAttribute('aria-expanded') !== null) {
      type = 'button';
      kind = element.getAttribute('aria-expanded') === 'true' ? 'collapse' : 'expand';
    } else if (
      (element as HTMLButtonElement).type === 'submit'
      && element.closest('form, [role="form"]') !== null
    ) {
      type = 'button';
      kind = 'submit';
    } else if (
      /^open\s+inventory\s+row\b/iu.test(lower)
      || /^(?:(?:open|show|toggle)\s+)?(?:(?:hamburger|main|navigation|account|profile|user)\s+)?menu$/iu.test(lower)
      || /^(?:more\s+)?options$/iu.test(lower)
      || element.hasAttribute('aria-haspopup')
      || element.hasAttribute('aria-controls')
    ) {
      type = 'button';
      kind = 'open';
    } else if (/^(?:close|dismiss|cancel)\b/iu.test(lower)) {
      type = 'button';
      kind = 'close';
    }
    return { type, kind, risk: role === 'option' ? 'reversible' : riskFor(label, kind) };
  };

  let overlayHost: HTMLElement | null = null;
  let overlayRoot: ShadowRoot | null = null;
  let overlayAnimation: number | null = null;
  type HighlightItem = {
    x: number; y: number; w: number; h: number;
    label?: string; tone?: string; primary?: boolean;
    selector?: string; shadowPath?: string[];
  };
  let highlights: Array<{ item: HighlightItem; element: Element | null; box: HTMLElement; label: HTMLElement | null }> = [];

  const resolveHighlight = (item: HighlightItem): Element | null => {
    if (!item.selector) return null;
    try {
      let root: Document | ShadowRoot = document;
      for (const selector of item.shadowPath ?? []) {
        const host: Element | null = root.querySelector(selector);
        const shadow: ShadowRoot | null = host === null ? null : shadowRoots.get(host) ?? host.shadowRoot;
        if (shadow === null) return null;
        root = shadow;
      }
      return root.querySelector(item.selector);
    } catch { return null; }
  };

  // Read live rectangles every frame, including scroll, resizing and animated
  // layout changes. Bind to the actual node so a removed/replaced control never
  // leaves a box on another element that happens to inherit its old selector.
  const positionHighlights = (): void => {
    for (const { element, box, label } of highlights) {
      const style = element?.isConnected ? getComputedStyle(element) : null;
      const rect = element?.isConnected ? element.getBoundingClientRect() : null;
      const visible = rect !== null && rect.width > 0 && rect.height > 0
        && style?.visibility !== 'hidden' && style?.visibility !== 'collapse';
      box.hidden = !visible;
      if (label !== null) label.hidden = !visible;
      if (!visible || rect === null) continue;
      box.style.left = `${rect.x}px`; box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`; box.style.height = `${rect.height}px`;
      if (label !== null) {
        label.style.left = `${rect.x}px`; label.style.top = `${Math.max(0, rect.y - 16)}px`;
      }
    }
    overlayAnimation = highlights.length ? requestAnimationFrame(positionHighlights) : null;
  };

  const clearHighlight = (): void => {
    if (overlayAnimation !== null) cancelAnimationFrame(overlayAnimation);
    overlayAnimation = null;
    highlights = [];
    if (overlayRoot !== null) overlayRoot.replaceChildren();
  };

  const highlight = (items: HighlightItem[]): void => {
    clearHighlight();
    if (items.length === 0) return;
    if (overlayHost === null || !overlayHost.isConnected) {
      overlayHost = document.createElement('div');
      overlayHost.setAttribute(OVERLAY_ATTRIBUTE, '');
      overlayHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      overlayRoot = overlayHost.attachShadow({ mode: 'open' });
      (document.body ?? document.documentElement)?.appendChild(overlayHost);
    }
    if (overlayRoot === null) return;
    const css = document.createElement('style');
    css.textContent = ':host{all:initial} [hidden]{display:none!important}'
      + 'i{position:fixed;box-sizing:border-box;border:1px solid var(--tone,#2563eb);'
      + 'background:color-mix(in srgb,var(--tone,#2563eb) 8%,transparent);border-radius:2px;display:block}'
      + 'i.p{border-width:2px;background:color-mix(in srgb,var(--tone,#2563eb) 18%,transparent)}'
      + 'b{position:fixed;font:600 10px/1.4 ui-sans-serif,system-ui,sans-serif;color:#fff;'
      + 'background:var(--tone,#2563eb);padding:1px 5px;border-radius:3px;white-space:nowrap}';
    overlayRoot.append(css);
    for (const item of items.slice(0, 400)) {
      const box = document.createElement('i');
      if (item.primary) box.className = 'p';
      box.style.setProperty('--tone', item.tone ?? '#2563eb');
      const label = item.label ? document.createElement('b') : null;
      overlayRoot.append(box);
      if (label !== null) {
        label.textContent = (item.label ?? '').slice(0, 80);
        label.style.setProperty('--tone', item.tone ?? '#2563eb');
        overlayRoot.append(label);
      }
      highlights.push({ item, element: resolveHighlight(item), box, label });
    }
    positionHighlights();
  };

  /**
   * Stable-keyed snapshot of every value-bearing element in the document.
   *
   * snapshotText() keys entries by a running text index, so inserting a single
   * node shifts every later key and a diff reports the whole page as changed.
   * Differential capture needs keys that survive insertion, so this keys by the
   * same structural selector the locators use.
   */
  const shadowInclusiveRoots = (): Array<Document | ShadowRoot> => {
    const roots: Array<Document | ShadowRoot> = [];
    const visitRoot = (root: Document | ShadowRoot): void => {
      roots.push(root);
      for (const element of Array.from(root.querySelectorAll('*'))) {
        if (element.hasAttribute(OVERLAY_ATTRIBUTE)) continue;
        const shadow = element.shadowRoot ?? shadowRoots.get(element);
        if (shadow !== undefined && shadow !== null) visitRoot(shadow);
      }
    };
    visitRoot(document);
    return roots;
  };

  /**
   * A deliberately small projection of the page's decision surface.
   *
   * Mutation epochs tell the host that something happened. This digest tells
   * it whether that change altered anything an automation agent can presently
   * see or operate. It traverses retained closed roots as well as open roots,
   * but avoids the full extractor's grouping, locator synthesis, collection
   * inference and occlusion diagnostics. The returned value contains no page
   * text or field values.
   */
  const semanticSurfaceDigest = (): SemanticSurface => {
    let actions = 0;
    let observables = 0;
    let regions = 0;
    let hashA = 0x811c9dc5;
    let hashB = 0x9e3779b9;
    let presentationHashA = 0x811c9dc5;
    let presentationHashB = 0x9e3779b9;

    const hash = (value: unknown): void => {
      const text = String(value ?? '');
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
        hashB = Math.imul(hashB ^ (code + index), 0x85ebca6b) >>> 0;
      }
      hashA = Math.imul(hashA ^ 0xff, 0x01000193) >>> 0;
      hashB = Math.imul(hashB ^ 0x7f, 0xc2b2ae35) >>> 0;
    };

    const hashPresentation = (value: unknown): void => {
      const text = String(value ?? '');
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        presentationHashA = Math.imul(presentationHashA ^ code, 0x01000193) >>> 0;
        presentationHashB = Math.imul(
          presentationHashB ^ (code + index),
          0x85ebca6b,
        ) >>> 0;
      }
      presentationHashA = Math.imul(presentationHashA ^ 0xff, 0x01000193) >>> 0;
      presentationHashB = Math.imul(presentationHashB ^ 0x7f, 0xc2b2ae35) >>> 0;
    };

    // Two CSS pixels are fine-grained enough for hover targeting while
    // filtering sub-pixel layout/font jitter before it reaches the extractor.
    const presentationCoordinate = (value: number): number =>
      Number.isFinite(value) ? Math.round(value / 2) : 0;

    const digestText = (value: string): string => value;
    const exactUrl = (value: string): string => {
      try { return new URL(value, location.href).href; } catch { return value; }
    };

    const interactiveRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox',
      'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'slider', 'spinbutton', 'treeitem', 'gridcell',
    ]);
    const regionRoles = new Set([
      'navigation', 'main', 'toolbar', 'dialog', 'alertdialog', 'menu',
      'menubar', 'table', 'grid', 'list', 'tablist', 'form',
    ]);
    const regionTags = new Set([
      'nav', 'main', 'form', 'table', 'ul', 'ol', 'section', 'aside',
      'header', 'footer',
    ]);
    const activationEvents = /^(?:auxclick|click|contextmenu|dblclick|keydown|keypress|keyup|mousedown|mouseup|pointerdown|pointerup|touchend|touchstart|beforeinput|change|input)$/iu;
    const observableName = /(?:badge|count|price|total|amount|quantity|error|validation|invalid)/iu;
    const numericValue = /^(?:(?:[$€£₹]|USD\s*)[-+]?\d[\d,]*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?\s*%|(?:Quantity|Count)\s+\d+)$/iu;
    const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
    const rectCache = new WeakMap<Element, DOMRect>();
    const renderedCache = new WeakMap<Element, boolean>();

    const styleFor = (element: Element): CSSStyleDeclaration => {
      let style = styleCache.get(element);
      if (style === undefined) {
        style = getComputedStyle(element);
        styleCache.set(element, style);
      }
      return style;
    };
    const rectFor = (element: Element): DOMRect => {
      let rect = rectCache.get(element);
      if (rect === undefined) {
        rect = element.getBoundingClientRect();
        rectCache.set(element, rect);
      }
      return rect;
    };
    const surfaceParent = (element: Element): Element | null => {
      if (element.assignedSlot !== null) return element.assignedSlot;
      if (element.parentElement !== null) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };
    const rendered = (element: Element): boolean => {
      const cached = renderedCache.get(element);
      if (cached !== undefined) return cached;
      const style = styleFor(element);
      const rect = rectFor(element);
      const opacity = Number.parseFloat(style.opacity || '1');
      const own = !element.hasAttribute('hidden')
        && !element.hasAttribute('inert')
        && element.getAttribute('aria-hidden')?.toLocaleLowerCase() !== 'true'
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && (!Number.isFinite(opacity) || opacity > 0)
        && rect.width > 0
        && rect.height > 0;
      // Set before walking upward so unusual composed trees cannot recurse.
      renderedCache.set(element, own);
      if (!own) return false;
      const parent = surfaceParent(element);
      const result = parent === null || rendered(parent);
      renderedCache.set(element, result);
      return result;
    };

    const hasFrameworkHandler = (element: Element): boolean => {
      try {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (!key.startsWith('__reactProps$')) continue;
          const props = (element as unknown as Record<string, unknown>)[key];
          if (props === null || typeof props !== 'object') continue;
          if (Object.entries(props).some(([name, value]) =>
            typeof value === 'function' && /^on/u.test(name) && activationEvents.test(name.slice(2)))) {
            return true;
          }
        }
      } catch {
        // Hardened framework nodes can reject property inspection.
      }
      return false;
    };

    const nativeAction = (element: Element): boolean =>
      ['button', 'select', 'textarea', 'summary'].includes(element.localName)
      || (element.localName === 'a' && element.hasAttribute('href'))
      || (
        element.localName === 'input'
        && (element.getAttribute('type') ?? '').toLocaleLowerCase() !== 'hidden'
      );

    const actionValue = (element: Element, label: string): string => {
      if (element.localName === 'select') {
        const select = element as HTMLSelectElement;
        return digestText(Array.from(select.selectedOptions, (option) => option.textContent ?? '').join(' '));
      }
      if (element.localName === 'input' || element.localName === 'textarea') {
        const input = element as HTMLInputElement;
        const type = (input.getAttribute('type') ?? 'text').toLocaleLowerCase();
        if (type === 'checkbox' || type === 'radio') return String(input.checked);
        return digestText(String(input.value ?? ''));
      }
      if (element.hasAttribute('contenteditable')) return digestText(element.textContent ?? '');
      return '';
    };

    try {
      hash('surface-v1');
      hash(exactUrl(location.href));
      hash(digestText(document.title));
      const roots = shadowInclusiveRoots();
      roots.forEach((root, rootIndex) => {
        let semanticIndex = 0;
        for (const element of Array.from(root.querySelectorAll('*'))) {
          if (belongsToInspector(element)) continue;
          try {
            const role = element.getAttribute('role') ?? implicitRole(element);
            const registered = [...(listeners.get(element)?.entries() ?? [])]
              .some(([type, values]) => values.size > 0 && activationEvents.test(type));
            const inline = Array.from(element.attributes)
              .some(({ name }) => /^on/iu.test(name) && activationEvents.test(name.slice(2)));
            const propertyHandler = [
              'onclick', 'onchange', 'oninput', 'onkeydown', 'onpointerup', 'onmouseup',
            ].some((name) => typeof (element as unknown as Record<string, unknown>)[name] === 'function');
            const style = styleFor(element);
            const isAction = nativeAction(element)
              || interactiveRoles.has(role)
              || (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')
              || element.hasAttribute('aria-controls')
              || element.hasAttribute('aria-expanded')
              || element.hasAttribute('popovertarget')
              || element.hasAttribute('commandfor')
              || (element as HTMLElement).tabIndex >= 0
              || registered
              || inline
              || propertyHandler
              || hasFrameworkHandler(element)
              || style.cursor === 'pointer';
            const observableRole = element.getAttribute('role') ?? '';
            const currentText = normalizedText(element.textContent, 300);
            const isObservable = element.localName === 'output'
              || ['status', 'alert', 'log'].includes(observableRole)
              || element.hasAttribute('aria-live')
              || element.hasAttribute('aria-busy')
              || (
                element.children.length === 0
                && currentText !== ''
                && (
                  numericValue.test(currentText)
                  || observableName.test(`${element.id} ${typeof element.className === 'string' ? element.className : ''}`)
                )
              );
            const isRegion = regionRoles.has(role) || regionTags.has(element.localName);
            if (!isAction && !isObservable && !isRegion) continue;

            semanticIndex += 1;
            const visible = rendered(element);
            const rect = rectFor(element);
            const inViewport = visible
              && rect.bottom > 0
              && rect.right > 0
              && rect.top < window.innerHeight
              && rect.left < window.innerWidth;
            if (isAction || isObservable) {
              hashPresentation(rootIndex);
              hashPresentation(semanticIndex);
              hashPresentation(element.localName);
              hashPresentation(role);
              hashPresentation(visible);
              hashPresentation(presentationCoordinate(rect.x));
              hashPresentation(presentationCoordinate(rect.y));
              hashPresentation(presentationCoordinate(rect.width));
              hashPresentation(presentationCoordinate(rect.height));
            }
            hash(rootIndex);
            hash(semanticIndex);
            hash(element.localName);
            hash(role);
            hash(visible);
            hash(inViewport);

            if (isAction) {
              actions += 1;
              const label = digestText(accessibleName(element));
              hash('action');
              hash(label);
              hash(element.getAttribute('type'));
              hash(element.hasAttribute('disabled') || element.getAttribute('aria-disabled'));
              hash(element.hasAttribute('readonly') || element.getAttribute('aria-readonly'));
              hash(element.hasAttribute('required') || element.getAttribute('aria-required'));
              hash(element.getAttribute('aria-expanded'));
              hash(element.getAttribute('aria-checked'));
              hash(element.getAttribute('aria-selected'));
              hash(element.getAttribute('aria-pressed'));
              hash(element.getAttribute('href') === null ? '' : exactUrl(element.getAttribute('href') ?? ''));
              hash(actionValue(element, label));
            }
            if (isObservable && !isAction) {
              observables += 1;
              hash('observable');
              hash(digestText(observableLabel(element, currentText)));
              hash(digestText(currentText));
            }
            if (isRegion) {
              regions += 1;
              hash('region');
              hash(digestText(accessibleName(element)));
              hash(element.getAttribute('aria-modal'));
              hash(element.getAttribute('open'));
            }
          } catch {
            // One hostile custom element must not suppress the whole signal.
            hash('unreadable-element');
          }
        }
      });
    } catch {
      // A digest is an optimisation hint. A changing fallback forces capture
      // rather than letting an instrumentation edge case hide page changes.
      hash('surface-unavailable');
      hash(materialEpoch);
    }

    return {
      digest: `${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`,
      presentationDigest: `${presentationHashA.toString(16).padStart(8, '0')}${presentationHashB.toString(16).padStart(8, '0')}`,
      actions,
      observables,
      regions,
    };
  };

  const deepElementCount = (): number =>
    shadowInclusiveRoots().reduce(
      (count, root) => count + Array.from(root.querySelectorAll('*'))
        .filter((element) => !element.hasAttribute(OVERLAY_ATTRIBUTE)).length,
      0,
    );

  const extract = (options: {
    framePath: string;
    maxNodes?: number;
    maxDepth?: number;
  }): unknown => {
    const startedAt = performance.now();
    const framePath = options.framePath;
    const maxNodes = options.maxNodes ?? 20_000;
    const maxDepth = options.maxDepth ?? 100;
    const warnings: Array<{ code: string; detail: string; ref: string | null }> = [];
    const regions: Array<{
      key: string;
      order: number;
      label: string;
      kind: string;
      global: boolean;
      conditional: boolean;
      parentKey: string | null;
      controlledBy: string | null;
      shadowPath: string[];
    }> = [];
    const actions: Array<Record<string, unknown>> = [];
    const observables: Array<Record<string, unknown>> = [];
    const collections: Array<Record<string, unknown>> = [];
    const actionRecords: Array<{ element: Element; raw: Record<string, unknown> }> = [];
    const observableRecords: Array<{ element: Element; raw: Record<string, unknown> }> = [];
    const allElements: Element[] = [];
    const elementNodeKeys = new WeakMap<Element, string>();
    const elementRegionKeys = new WeakMap<Element, string>();
    const elementShadowPaths = new WeakMap<Element, string[]>();
    const seenOcclusion = new Set<string>();
    let nodesVisited = 0;
    let order = 0;
    let truncated = false;

    // `Element.assignedSlot` deliberately returns null when the slot lives in
    // a closed shadow root. We retain those roots for extraction, so build the
    // same direct-assignment relation from their slot elements. This keeps a
    // slotted light-DOM action under its actual composed landmark instead of
    // falling back to the document group.
    const retainedAssignedSlots = new WeakMap<Element, HTMLSlotElement>();
    for (const root of shadowInclusiveRoots()) {
      for (const slot of Array.from(root.querySelectorAll('slot'))) {
        for (const assigned of (slot as HTMLSlotElement).assignedElements()) {
          retainedAssignedSlots.set(assigned, slot as HTMLSlotElement);
        }
      }
    }
    const assignedSlotFor = (element: Element): HTMLSlotElement | null =>
      element.assignedSlot ?? retainedAssignedSlots.get(element) ?? null;

    const hoverElements = new Set<Element>();
    let rulesExamined = 0;
    for (const root of shadowInclusiveRoots()) {
      const styleSheets = root instanceof Document
        ? Array.from(root.styleSheets)
        : [
            ...Array.from(root.adoptedStyleSheets),
            ...Array.from(root.querySelectorAll('style'))
              .map((style) => style.sheet)
              .filter((sheet): sheet is CSSStyleSheet => sheet !== null),
          ];
      for (const sheet of styleSheets) {
        if (rulesExamined >= 200) break;
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rulesExamined >= 200) break;
            rulesExamined += 1;
            if (!(rule instanceof CSSStyleRule)) continue;
            if (!/:hover|:active/u.test(rule.selectorText)) continue;
            const styleText = rule.style.cssText;
            if (!/(?:display|visibility|opacity)\s*:/iu.test(styleText)) continue;
            for (const selector of rule.selectorText.split(',')) {
              const base = selector.split(/:(?:hover|active)/u)[0]?.trim();
              if (!base) continue;
              try {
                for (const element of root.querySelectorAll(base)) hoverElements.add(element);
              } catch {
                // Invalid partial selector after removing the pseudo class.
              }
            }
          }
        } catch {
          // Cross-origin stylesheets are intentionally skipped.
        }
      }
      if (rulesExamined >= 200) break;
    }

    const composedParent = (element: Element): Element | null => {
      const assignedSlot = assignedSlotFor(element);
      if (assignedSlot !== null) return assignedSlot;
      if (element.parentElement !== null) return element.parentElement;
      const root = element.getRootNode();
      return root instanceof ShadowRoot ? root.host : null;
    };

    const composedChildren = (element: Element): Element[] => {
      if (element.localName === 'slot') {
        const assigned = (element as HTMLSlotElement).assignedElements({ flatten: true });
        if (assigned.length > 0) return assigned;
      }
      const shadow = element.shadowRoot ?? shadowRoots.get(element);
      return shadow === undefined || shadow === null
        ? Array.from(element.children)
        : Array.from(shadow.children);
    };

    const shadowInclusiveDescendants = (container: Element, limit = 4_000): Element[] => {
      const result: Element[] = [];
      const seen = new Set<Element>();
      const queue = [...Array.from(container.children)];
      const root = container.shadowRoot ?? shadowRoots.get(container);
      if (root !== undefined && root !== null) queue.push(...Array.from(root.children));
      while (queue.length > 0 && result.length < limit) {
        const current = queue.shift();
        if (current === undefined || seen.has(current)) continue;
        seen.add(current);
        result.push(current);
        queue.push(...Array.from(current.children));
        const shadow = current.shadowRoot ?? shadowRoots.get(current);
        if (shadow !== undefined && shadow !== null) queue.push(...Array.from(shadow.children));
        if (current.localName === 'slot') {
          queue.push(...(current as HTMLSlotElement).assignedElements({ flatten: true }));
        }
      }
      return result;
    };

    const inclusiveFind = (container: Element, selector: string): Element | null =>
      shadowInclusiveDescendants(container).find((candidate) => {
        try {
          return candidate.matches(selector);
        } catch {
          return false;
        }
      }) ?? null;

    const composedClosest = (element: Element, selector: string): Element | null => {
      let cursor: Element | null = element;
      while (cursor !== null) {
        try {
          if (cursor.matches(selector)) return cursor;
        } catch {
          return null;
        }
        cursor = composedParent(cursor);
      }
      return null;
    };

    const shadowInclusiveText = (element: Element, limit = 1_000): string => {
      const values: string[] = [element.textContent ?? ''];
      const ownShadow = element.shadowRoot ?? shadowRoots.get(element);
      if (ownShadow !== undefined && ownShadow !== null) values.push(ownShadow.textContent ?? '');
      for (const descendant of shadowInclusiveDescendants(element, 1_000)) {
        const shadow = descendant.shadowRoot ?? shadowRoots.get(descendant);
        if (shadow !== undefined && shadow !== null) values.push(shadow.textContent ?? '');
      }
      return normalizedText(values.join(' '), limit);
    };

    const choiceOwnerFor = (option: Element): Element | null => {
      let cursor = composedParent(option);
      while (cursor !== null) {
        const role = cursor.getAttribute('role') ?? implicitRole(cursor);
        if (
          ['select', 'datalist'].includes(cursor.localName)
          || role === 'listbox'
          || role === 'combobox'
        ) {
          // Portal/custom listboxes are frequently controlled by a combobox
          // or reveal button in the same document/shadow root. Link choices
          // to that executable owner rather than to the popup surface.
          if (role === 'listbox' && cursor.id !== '') {
            const root = cursor.getRootNode() as Document | ShadowRoot;
            const id = cssEscape(cursor.id);
            try {
              const controller = Array.from(root.querySelectorAll(
                `[aria-controls~="${id}"], [aria-owns~="${id}"]`,
              )).find((candidate) => {
                const candidateRole = candidate.getAttribute('role') ?? implicitRole(candidate);
                return candidateRole === 'combobox'
                  || candidate.getAttribute('aria-haspopup') === 'listbox';
              });
              if (controller !== undefined) return controller;
            } catch {
              // Fall through to a structurally enclosing owner when ids are
              // hostile or the popup is not externally controlled.
            }
          }
          if (role === 'listbox') {
            // A listbox is a popup/choice surface and is intentionally not an
            // executable action. If no external aria-controls/owns controller
            // exists, keep walking so an enclosing combobox owns its options.
            // Returning the listbox here would leave every option pointing at
            // a suppressed action key.
            cursor = composedParent(cursor);
            continue;
          }
          return cursor;
        }
        cursor = composedParent(cursor);
      }
      return null;
    };

    const semanticIdentityParts = (element: Element): string[] => [
      element.localName.includes('-') ? element.localName : null,
      element.id,
      ...Array.from(element.classList).map(dehashClass),
      element.getAttribute('data-testid'),
      element.getAttribute('data-test'),
      element.getAttribute('data-cy'),
    ].filter((value): value is string => value !== null && value !== '')
      .map((value) => normalizedText(
        value.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[-_]+/gu, ' '),
      ).toLocaleLowerCase())
      .filter(Boolean);

    const componentQualifier = /(?:^|\s)(?:card|item|row|tile|widget|modal|dialog|form|table|cell)(?:\s|$)/iu;
    const headerPart = /^(?:(?:site|app|application|page|global|primary|main)\s+)?(?:header|masthead|topbar|top bar)(?:\s+(?:container|wrapper|region))?$/iu;
    const secondaryHeaderPart = /^(?:(?:secondary\s+header|header\s+secondary))(?:\s+(?:container|wrapper|region))?$/iu;
    const mainPart = /^(?:(?:app|application|page|primary)\s+)?main(?:\s+(?:content|container|wrapper|region|panel))?$|^(?:main\s+content|page\s+content|content\s+body)(?:\s+(?:container|wrapper|region|panel))?$/iu;
    const navigationPart = /^(?:(?:site|app|global|primary|side)\s+)?(?:nav|navigation|sidebar|side bar)(?:\s+(?:container|wrapper|region))?$/iu;
    const toolbarPart = /(?:^|\s)(?:toolbar|tool bar|controls?|filters?|filter bar|sort bar|actions?|action bar)(?:\s|$)/iu;
    const containerPart = /(?:^|\s)(?:container|panel|section|area|content|body)(?:\s|$)/iu;
    const isHeaderIdentity = (element: Element): boolean => semanticIdentityParts(element).some(
      (part) => !componentQualifier.test(part) && (headerPart.test(part) || secondaryHeaderPart.test(part)),
    );
    const isSecondaryHeaderIdentity = (element: Element): boolean =>
      semanticIdentityParts(element).some((part) => secondaryHeaderPart.test(part));
    const isMainIdentity = (element: Element): boolean => semanticIdentityParts(element).some(
      (part) => !componentQualifier.test(part) && mainPart.test(part),
    );
    const isNavigationIdentity = (element: Element): boolean => semanticIdentityParts(element).some(
      (part) => !componentQualifier.test(part) && navigationPart.test(part),
    );
    const isToolbarIdentity = (element: Element): boolean => semanticIdentityParts(element).some(
      (part) => !componentQualifier.test(part) && toolbarPart.test(part),
    );
    const isContainerIdentity = (element: Element): boolean =>
      semanticIdentityParts(element).some((part) => containerPart.test(part));

    const hasSemanticAncestor = (
      element: Element,
      predicate: (candidate: Element) => boolean,
    ): boolean => {
      let ancestor = composedParent(element);
      while (ancestor !== null) {
        if (predicate(ancestor)) return true;
        ancestor = composedParent(ancestor);
      }
      return false;
    };

    const hasRepeatedBusinessObjects = (element: Element): boolean => {
      const candidates: Array<{ element: Element; depth: number }> = [{ element, depth: 0 }];
      const seen = new Set<Element>();
      while (candidates.length > 0 && seen.size < 80) {
        const next = candidates.shift();
        if (next === undefined || seen.has(next.element)) continue;
        seen.add(next.element);
        const children = composedChildren(next.element);
        if (next.depth < 3) {
          candidates.push(...children.map((child) => ({ element: child, depth: next.depth + 1 })));
        }
        if (children.length < 3) continue;
        const shapes = new Map<string, number>();
        for (const child of children) {
          // Native choices belong to one select/listbox control and must never
          // turn their owner into a business-object region.
          if (child.localName === 'option' || child.getAttribute('role') === 'option') {
            continue;
          }
          const role = child.getAttribute('role') ?? implicitRole(child);
          const childChildren = composedChildren(child);
          const primitiveControl = [
            'button', 'input', 'select', 'textarea', 'option', 'summary',
          ].includes(child.localName) || [
            'button', 'textbox', 'checkbox', 'radio', 'switch', 'combobox',
            'listbox', 'option', 'tab', 'menuitem', 'slider', 'spinbutton',
          ].includes(role);
          // Three submit/filter buttons are a control cluster, not three
          // business objects. Composite link tiles remain eligible because
          // their image/label structure is richer than a primitive control.
          if (primitiveControl || (child.localName === 'a' && childChildren.length < 2)) {
            continue;
          }
          if (
            !['article', 'tr'].includes(child.localName)
            && !['article', 'row', 'listitem'].includes(role)
            && childChildren.length < 2
            && !(
              child.localName.includes('-')
              && shadowInclusiveDescendants(child, 20).length >= 2
            )
          ) continue;
          const stableClass = Array.from(child.classList).map(dehashClass)[0] ?? '';
          const key = `${child.localName}|${child.getAttribute('role') ?? ''}|${stableClass}`;
          shapes.set(key, (shapes.get(key) ?? 0) + 1);
        }
        if ([...shapes.values()].some((count) => count >= 3)) return true;
      }
      return false;
    };

    const explicitMainPresent = shadowInclusiveRoots().some((root) =>
      root.querySelector('main, [role="main"]') !== null,
    );
    const inferredRegionRendered = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return !element.hasAttribute('hidden')
        && element.getAttribute('aria-hidden')?.toLocaleLowerCase() !== 'true'
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && box.width > 0
        && box.height > 0;
    };
    const inferredMainNegativePart = /(?:^|\s)(?:alerts?|dialogs?|footer|header|menu|modal|nav|navigation|notifications?|popover|sidebar|side bar|snackbar|toasts?|toolbar)(?:\s|$)/iu;
    const inferredMainCandidates = explicitMainPresent
      ? []
      : shadowInclusiveRoots().flatMap((root) => Array.from(root.querySelectorAll('*')))
        .filter((element) => {
          if (!inferredRegionRendered(element)) return false;
          const role = element.getAttribute('role') ?? implicitRole(element);
          if (
            ['navigation', 'dialog', 'alertdialog', 'menu', 'menubar'].includes(role)
            || ['nav', 'header', 'footer', 'aside'].includes(element.localName)
            || hasSemanticAncestor(element, (ancestor) => {
              const ancestorRole = ancestor.getAttribute('role') ?? implicitRole(ancestor);
              return ['navigation', 'dialog', 'alertdialog', 'menu', 'menubar'].includes(ancestorRole)
                || ['nav', 'header', 'footer', 'aside'].includes(ancestor.localName);
            })
          ) return false;
          const identityParts = semanticIdentityParts(element);
          const negativeIdentity = identityParts.some((part) => inferredMainNegativePart.test(part));
          if (negativeIdentity && !isMainIdentity(element)) return false;
          const directHeading = composedChildren(element).some((child) =>
            child.matches('h1, h2, [role="heading"]'),
          );
          const namedContainer = isMainIdentity(element) || isContainerIdentity(element);
          return isMainIdentity(element)
            || (
              (namedContainer || directHeading)
              && hasRepeatedBusinessObjects(element)
            );
        })
        .map((element, index) => {
          const directHeadings = composedChildren(element).filter((child) =>
            child.matches('h1, h2, [role="heading"]'),
          );
          const descendantH1 = inclusiveFind(element, 'h1');
          const descendantHeading = descendantH1 ?? inclusiveFind(
            element,
            'h2, [role="heading"]',
          );
          const box = element.getBoundingClientRect();
          const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
          const visibleArea = Math.max(0, Math.min(box.right, window.innerWidth) - Math.max(box.left, 0))
            * Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0));
          let score = Math.min(60, Math.round((visibleArea / viewportArea) * 60));
          if (isMainIdentity(element)) score += 1_000;
          if (isContainerIdentity(element)) score += 40;
          if (normalizedText(element.getAttribute('aria-label')) !== '') score += 30;
          if (directHeadings.some((heading) => heading.localName === 'h1')) score += 300;
          else if (directHeadings.length > 0) score += 200;
          else if (descendantH1 !== null) score += 100;
          else if (descendantHeading !== null) score += 50;
          return { element, score, index };
        })
        .sort((left, right) => right.score - left.score || left.index - right.index);
    // Decide once for the whole composed page. Traversal order otherwise made
    // whichever repeated rail appeared first (often notifications) become the
    // primary content landmark, even when a headed dashboard followed it.
    const inferredMainRegion = inferredMainCandidates[0]?.element ?? null;
    const regionKind = (element: Element): string | null => {
      const role = element.getAttribute('role') ?? implicitRole(element);
      if (role === 'navigation') return 'nav';
      if (role === 'main') return 'main';
      if (role === 'toolbar') return 'toolbar';
      if (role === 'dialog' || role === 'alertdialog') return 'dialog';
      if (role === 'menu' || role === 'menubar') return 'menu';
      if (role === 'table' || role === 'grid' || element.localName === 'table') return 'table';
      if (
        role === 'list'
        || role === 'listbox'
        || element.localName === 'ul'
        || element.localName === 'ol'
      ) return 'list';
      if (role === 'tablist') return 'tabset';
      if (role === 'form' || element.localName === 'form') return 'form';
      if (['section', 'aside', 'header', 'footer'].includes(element.localName)) return 'region';

      // Many component applications use div-only markup while still naming
      // their structural landmarks.  Preserve those DOM boundaries so the
      // public group graph mirrors what a person sees: header -> toolbar and
      // page -> repeated business-object container.  Only stable landmark
      // identities and containers that actually own a repeated object run are
      // promoted; generic wrapper divs remain invisible to the semantic tree.
      const descendantControl = inclusiveFind(
        element,
        'button, select, input:not([type="hidden"]), [role="button"], [role="combobox"]',
      );
      if (
        (isToolbarIdentity(element) && descendantControl !== null)
        || (
          isSecondaryHeaderIdentity(element)
          && descendantControl !== null
        )
      ) return 'toolbar';

      if (
        isHeaderIdentity(element)
        && !hasSemanticAncestor(element, isHeaderIdentity)
      ) {
        return 'region';
      }
      if (
        isMainIdentity(element)
        && !hasSemanticAncestor(element, isMainIdentity)
      ) {
        // Explicit HTML/ARIA main landmarks are authoritative across every
        // retained root. A class-named wrapper may still be useful structure,
        // but must not create a second Main landmark.
        return explicitMainPresent || element !== inferredMainRegion ? 'region' : 'main';
      }
      if (
        isNavigationIdentity(element)
        && inclusiveFind(element, 'a[href], button, [role="link"], [role="menuitem"]') !== null
      ) return 'nav';
      if (
        isContainerIdentity(element)
        && hasRepeatedBusinessObjects(element)
        && inferredRegionRendered(element)
      ) {
        if (!explicitMainPresent && element === inferredMainRegion) return 'main';
        return 'region';
      }
      return null;
    };

    const rootRegionKey = `${framePath}|document`;
    regions.push({
      key: rootRegionKey,
      order: order += 1,
      label: normalizedText(document.title) || (framePath === 'main' ? 'Page' : 'Frame'),
      kind: 'region',
      global: false,
      conditional: false,
      parentKey: null,
      controlledBy: null,
      shadowPath: [],
    });

    const occlusionLabel = (hit: Element): string => {
      const labelledContainer = hit.closest(
        '[aria-label], [role="dialog"], [role="alertdialog"], dialog, aside',
      );
      return accessibleName(labelledContainer ?? hit);
    };

    const isInteractiveNative = (element: Element): boolean => {
      if (['button', 'select', 'textarea', 'summary'].includes(element.localName)) return true;
      if (element.localName === 'a' && element.hasAttribute('href')) return true;
      if (element.localName === 'input' && (element.getAttribute('type') ?? '').toLowerCase() !== 'hidden') return true;
      return false;
    };

    const explicitActionRoles = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox',
      'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'slider', 'spinbutton', 'treeitem', 'gridcell',
    ]);

    // Resolve aria-labelledby field captions once per walk. Looking up every
    // control from every id-bearing node makes the label guard quadratic on
    // large applications such as Odoo, where thousands of elements carry ids.
    const fieldLabelText = new WeakSet<Element>();
    const nearbyFieldLabelText = new WeakSet<Element>();
    const fieldControlSelector =
      'input:not([type="hidden"]), textarea, select, '
      + '[contenteditable]:not([contenteditable="false"]), [role="textbox"], '
      + '[role="combobox"], [role="listbox"], [role="checkbox"], '
      + '[role="radio"], [role="switch"]';
    for (const root of shadowInclusiveRoots()) {
      const referencedIds = new Set<string>();
      for (const control of Array.from(root.querySelectorAll(fieldControlSelector))) {
        for (const id of (control.getAttribute('aria-labelledby') ?? '').split(/\s+/u)) {
          if (id !== '') referencedIds.add(id);
        }
      }
      if (referencedIds.size > 0) {
        for (const candidate of Array.from(root.querySelectorAll('[id]'))) {
          if (referencedIds.has(candidate.id)) fieldLabelText.add(candidate);
        }
      }

      const weakCaption = (candidate: Element, control: Element): boolean => {
        if (!['div', 'span', 'p', 'small', 'strong'].includes(candidate.localName)) return false;
        if (candidate.children.length > 0 || (candidate as HTMLElement).tabIndex >= 0) return false;
        const role = candidate.getAttribute('role') ?? '';
        if (role !== '' && explicitActionRoles.has(role)) return false;
        if (
          candidate.hasAttribute('contenteditable')
          || candidate.hasAttribute('aria-controls')
          || candidate.hasAttribute('aria-expanded')
          || candidate.hasAttribute('aria-haspopup')
          || candidate.hasAttribute('popovertarget')
          || candidate.hasAttribute('commandfor')
          || Array.from(candidate.attributes).some(({ name }) => /^on/iu.test(name))
        ) return false;
        const registered = [...(listeners.get(candidate)?.keys() ?? [])];
        if (registered.some((type) => /^(?:auxclick|click|contextmenu|dblclick|keydown|keypress|keyup|mousedown|mouseup|pointerdown|pointerup|touchend|touchstart)$/iu.test(type))) {
          return false;
        }
        try {
          for (const key of Object.getOwnPropertyNames(candidate)) {
            if (!key.startsWith('__reactProps$')) continue;
            const props = (candidate as unknown as Record<string, unknown>)[key];
            if (props === null || typeof props !== 'object') continue;
            if (Object.entries(props).some(([name, value]) =>
              typeof value === 'function'
              && /^on(?:AuxClick|Click|ContextMenu|DoubleClick|KeyDown|KeyPress|KeyUp|MouseDown|MouseUp|PointerDown|PointerUp|TouchEnd|TouchStart)$/u.test(name),
            )) return false;
          }
        } catch {
          // Hardened elements without inspectable framework props can still be
          // considered from their explicit DOM semantics above.
        }

        const caption = normalizedText(candidate.textContent, 80).toLocaleLowerCase();
        if (caption === '') return false;
        const descriptor = normalizedText([
          control.getAttribute('aria-label'),
          control.getAttribute('placeholder'),
          control.getAttribute('name'),
          control.id,
          control.getAttribute('autocomplete'),
          control.localName === 'input' ? control.getAttribute('type') : null,
        ].filter((value): value is string => value !== null && value !== '').join(' '), 240)
          .replace(/[-_]+/gu, ' ')
          .toLocaleLowerCase();
        if (descriptor === '' || (!descriptor.includes(caption) && !caption.includes(descriptor))) {
          const captionTerms = caption.split(/[^\p{L}\p{N}]+/gu).filter((term) => term.length > 2);
          const descriptorTerms = new Set(
            descriptor.split(/[^\p{L}\p{N}]+/gu).filter((term) => term.length > 2),
          );
          if (captionTerms.length === 0 || !captionTerms.every((term) => descriptorTerms.has(term))) {
            return false;
          }
        }

        const captionBox = candidate.getBoundingClientRect();
        const controlBox = control.getBoundingClientRect();
        if (captionBox.width <= 0 || captionBox.height <= 0 || controlBox.width <= 0 || controlBox.height <= 0) {
          return false;
        }
        const horizontalOverlap = Math.min(captionBox.right, controlBox.right)
          - Math.max(captionBox.left, controlBox.left);
        const verticalOverlap = Math.min(captionBox.bottom, controlBox.bottom)
          - Math.max(captionBox.top, controlBox.top);
        const aboveGap = controlBox.top - captionBox.bottom;
        const besideGap = controlBox.left >= captionBox.right
          ? controlBox.left - captionBox.right
          : captionBox.left - controlBox.right;
        return (horizontalOverlap > 0 && aboveGap >= -4 && aboveGap <= 32)
          || (verticalOverlap > 0 && besideGap >= -4 && besideGap <= 32);
      };

      for (const control of Array.from(root.querySelectorAll(fieldControlSelector))) {
        const candidates = new Set<Element>();
        if (control.previousElementSibling !== null) candidates.add(control.previousElementSibling);
        const wrapper = control.parentElement;
        if (wrapper !== null && wrapper.children.length === 1 && wrapper.previousElementSibling !== null) {
          candidates.add(wrapper.previousElementSibling);
        }
        for (const candidate of candidates) {
          if (weakCaption(candidate, control)) nearbyFieldLabelText.add(candidate);
        }
      }
    }

    /**
     * A label is a proxy for its field, not a second executable control.
     *
     * Browsers forward a click on <label> to label.control and applications
     * commonly style that label with cursor:pointer/:hover. Frameworks may
     * also attach a listener to it. Those signals used to add up to an
     * invented BUTTON named "Email" beside the real email input. Explicit ARIA
     * action semantics still win, which preserves intentional custom controls.
     */
    const isFieldLabelProxy = (element: Element, explicitRole: string): boolean => {
      if (explicitRole !== '' && explicitActionRoles.has(explicitRole)) return false;
      if (
        element.localName === 'label'
        && (element as HTMLLabelElement).control !== null
      ) return true;

      // Custom form renderers often use a span/div as aria-labelledby text.
      // Treat the referenced text as part of the field's accessible name, not
      // as an independent action, unless it declares its own action role.
      return fieldLabelText.has(element) || nearbyFieldLabelText.has(element);
    };

    /** Rendering across light/shadow ancestors, including accessibility gates. */
    const isRendered = (element: Element, box: DOMRect): boolean => {
      if (box.width <= 0 || box.height <= 0) return false;
      let cursor: Element | null = element;
      while (cursor !== null) {
        const cursorStyle = getComputedStyle(cursor);
        const cursorBox = cursor === element ? box : cursor.getBoundingClientRect();
        const opacity = Number.parseFloat(cursorStyle.opacity || '1');
        if (
          cursor.hasAttribute('hidden')
          || cursor.hasAttribute('inert')
          || cursor.getAttribute('aria-hidden')?.toLocaleLowerCase() === 'true'
          || cursorStyle.display === 'none'
          || cursorStyle.visibility === 'hidden'
          || cursorStyle.visibility === 'collapse'
          || (Number.isFinite(opacity) && opacity <= 0)
        ) return false;
        // A descendant can retain its own non-zero layout box while an
        // overflow-clipping ancestor has no drawable area. Treating that child
        // as visible made a collapsed menu look directly actionable even
        // though no pixel of it can be reached.
        if (
          cursor !== element
          && (
            (cursorBox.width <= 0 && cursorStyle.overflowX !== 'visible')
            || (cursorBox.height <= 0 && cursorStyle.overflowY !== 'visible')
          )
        ) return false;
        cursor = composedParent(cursor);
      }
      return true;
    };

    const visit = (
      element: Element,
      depth: number,
      shadowPath: string[],
      nearestRegionKey: string,
      parentRegionKey: string | null,
      ancestorIds: string[],
    ): void => {
      // The inspector's own overlay is not part of the application.
      if (element.hasAttribute(OVERLAY_ATTRIBUTE)) return;
      if (nodesVisited >= maxNodes || depth > maxDepth) {
        if (!truncated) {
          truncated = true;
          warnings.push({
            code: 'truncated_walk',
            detail: `Traversal stopped at ${nodesVisited} nodes and depth ${depth}.`,
            ref: framePath,
          });
        }
        return;
      }
      nodesVisited += 1;
      order += 1;
      allElements.push(element);
      const style = getComputedStyle(element);
      const viewportRect = element.getBoundingClientRect();
      const rect = {
        // Geometry leaves the frame in viewport coordinates.  The Node-side
        // compositor translates it through each iframe into the main page
        // viewport.  Adding scroll offsets here produced document coordinates,
        // which drifted away from CDP screencast/input coordinates as soon as
        // either the page or a child frame scrolled.
        x: viewportRect.left,
        y: viewportRect.top,
        w: viewportRect.width,
        h: viewportRect.height,
      };
      const nodeKey = `${framePath}|${shadowPath.join('>>')}|${structuralSelector(element)}`;
      elementNodeKeys.set(element, nodeKey);
      elementShadowPaths.set(element, [...shadowPath]);
      const kindOfRegion = regionKind(element);
      let activeRegionKey = nearestRegionKey;
      let nextParentRegionKey = parentRegionKey;
      if (kindOfRegion !== null) {
        activeRegionKey = `${nodeKey}|region`;
        const owningRoot = element.getRootNode() as Document | ShadowRoot;
        const controller = element.id === ''
          ? null
          : owningRoot.querySelector([
              `[aria-controls~="${cssEscape(element.id)}"]`,
              `[popovertarget="${cssEscape(element.id)}"]`,
              `[commandfor="${cssEscape(element.id)}"]`,
            ].join(','));
        // DOM ids are scoped to a document/shadow root. Carry the complete
        // root-aware node key so identical #trigger/#menu pairs in two web
        // component instances cannot cross-link.
        const controlledBy = controller === null
          ? null
          : `${framePath}|${shadowPath.join('>>')}|${structuralSelector(controller)}`;
        const titleSelector = [
          'h1', 'h2', 'legend', '[role="heading"]', '.title',
          '[data-testid="title"]', '[data-test="title"]',
        ].join(', ');
        const directTitleElement = composedChildren(element).find((candidate) =>
          candidate.matches(titleSelector),
        ) ?? (kindOfRegion === 'toolbar' ? inclusiveFind(element, titleSelector) : null);
        const directTitle = normalizedText(directTitleElement?.textContent);
        const identityLabel = humanize(
          element.id
          || Array.from(element.classList)[0]
          || (element.localName.includes('-') ? element.localName : kindOfRegion),
        );
        const regionLabel = normalizedText(element.getAttribute('aria-label'))
          || labelledByText(element)
          || directTitle
          || (kindOfRegion === 'region' && isHeaderIdentity(element) ? 'Header' : identityLabel);
        regions.push({
          key: activeRegionKey,
          order,
          label: regionLabel || humanize(kindOfRegion),
          kind: kindOfRegion,
          global: kindOfRegion === 'nav'
            || ['header', 'footer'].includes(element.localName)
            || (kindOfRegion === 'region' && isHeaderIdentity(element)),
          conditional: !isRendered(element, viewportRect),
          parentKey: nextParentRegionKey ?? rootRegionKey,
          controlledBy,
          shadowPath: [...shadowPath],
        });
        nextParentRegionKey = activeRegionKey;
      }
      elementRegionKeys.set(element, activeRegionKey);

      const explicitRole = element.getAttribute('role') ?? '';
      const role = explicitRole || implicitRole(element);
      const interactiveRoles = explicitActionRoles;
      const evidence: string[] = [];
      const evidenceWeight = new Map<string, number>();
      const addEvidence = (signal: string, weight: number) => {
        if (!evidenceWeight.has(signal)) {
          evidence.push(signal);
          evidenceWeight.set(signal, weight);
        }
      };
      if (isInteractiveNative(element)) addEvidence('native_tag', 1);
      if (interactiveRoles.has(role)) addEvidence('ax_role', 1);
      if (explicitRole !== '' && interactiveRoles.has(explicitRole)) addEvidence('aria_role', 0.8);
      let reactHandler = false;
      try {
        for (const key of Object.getOwnPropertyNames(element)) {
          if (!key.startsWith('__reactProps$')) continue;
          const props = (element as unknown as Record<string, unknown>)[key];
          if (props === null || typeof props !== 'object') continue;
          const handlerNames = Object.entries(props)
            .filter(([, value]) => typeof value === 'function')
            .map(([name]) => name);
          const pointerActivation = handlerNames.some((name) =>
            /^on(?:AuxClick|Click|ContextMenu|DoubleClick|MouseDown|MouseUp|PointerDown|PointerUp|TouchEnd|TouchStart)$/u.test(name),
          );
          const keyboardActivation = handlerNames.some((name) =>
            /^onKey(?:Down|Press|Up)$/u.test(name),
          ) && ((element as HTMLElement).tabIndex >= 0 || interactiveRoles.has(role));
          const controlActivation = handlerNames.some((name) =>
            /^on(?:BeforeInput|Change|Input)$/u.test(name),
          ) && (
            isInteractiveNative(element)
            || element.hasAttribute('contenteditable')
            || interactiveRoles.has(role)
          );
          // React exposes form submission and other bubbling callbacks on the
          // container which receives them. Those callbacks are evidence for
          // the descendant control, not a directly executable action on the
          // form/landmark itself.
          const passiveContainer = [
            'html', 'body', 'main', 'form', 'nav', 'header', 'footer',
            'section', 'article', 'aside', 'ul', 'ol', 'table', 'thead',
            'tbody', 'tfoot', 'fieldset',
          ].includes(element.localName)
            && !interactiveRoles.has(role)
            && (element as HTMLElement).tabIndex < 0;
          if (!passiveContainer && (pointerActivation || keyboardActivation || controlActivation)) {
            reactHandler = true;
          }
        }
      } catch {
        reactHandler = false;
      }
      if (reactHandler) addEvidence('react_props', 0.95);
      const registeredTypes = [...(listeners.get(element)?.entries() ?? [])]
        .filter(([, registered]) => registered.size > 0)
        .map(([type]) => type);
      if (registeredTypes.length > 0) addEvidence('listener_registry', 0.9);
      if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') {
        addEvidence('contenteditable', 0.8);
      }
      if (Array.from(element.attributes).some(({ name }) => /^on/iu.test(name))) {
        addEvidence('inline_handler', 0.7);
      }
      if (element.hasAttribute('aria-controls') || element.hasAttribute('aria-expanded')) {
        addEvidence('aria_controls', 0.5);
      }
      if (style.cursor === 'pointer') addEvidence('cursor_pointer', 0.35);
      if (hoverElements.has(element)) addEvidence('hover_css', 0.3);
      if ((element as HTMLElement).tabIndex >= 0) addEvidence('focusable', 0.25);
      const categoricalEvidence = evidence.some((signal) => [
        'native_tag',
        'ax_role',
        'aria_role',
        'react_props',
        'listener_registry',
        'contenteditable',
        'inline_handler',
      ].includes(signal));
      let confidence = [...evidenceWeight.values()].reduce((sum, weight) => sum + weight, 0);
      if (style.pointerEvents === 'none') confidence -= 0.5;
      if (viewportRect.width === 0 || viewportRect.height === 0) confidence -= 0.4;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') confidence -= 0.6;
      confidence = Math.max(0, Math.min(1, confidence));
      const fieldLabelProxy = isFieldLabelProxy(element, explicitRole);
      const compositeChoiceSurface = role === 'listbox' && element.localName !== 'select';

      // Visibility describes the present rendering, not whether a categorical
      // control exists. A native/AX/framework/listener-backed action remains in
      // the exhaustive artifact while display:none, visibility:hidden, or
      // zero-area so an agent knows what a safe reveal can make reachable.
      if (
        !fieldLabelProxy
        && !compositeChoiceSurface
        && (confidence >= 0.6 || categoricalEvidence)
      ) {
        const label = accessibleName(element);
        const classification = classifyAction(element, role, label);
        const visible = isRendered(element, viewportRect);
        const inViewport = visible
          && viewportRect.bottom > 0
          && viewportRect.right > 0
          && viewportRect.top < window.innerHeight
          && viewportRect.left < window.innerWidth;
        let hitTestable = false;
        let occludedBy: string | null = null;
        if (visible && inViewport && style.pointerEvents !== 'none') {
          const centerX = Math.max(0, Math.min(window.innerWidth - 1, viewportRect.left + viewportRect.width / 2));
          const centerY = Math.max(0, Math.min(window.innerHeight - 1, viewportRect.top + viewportRect.height / 2));
          const hit = document.elementFromPoint(centerX, centerY);
          const root = element.getRootNode();
          const rootHit = root instanceof ShadowRoot
            ? root.elementFromPoint(centerX, centerY)
            : hit;
          hitTestable = rootHit === element
            || (rootHit !== null && element.contains(rootHit))
            || hit === element
            || (hit !== null && element.contains(hit))
            || (root instanceof ShadowRoot && hit === root.host);
          if (!hitTestable && hit !== null && !hit.contains(element)) {
            occludedBy = occlusionLabel(hit);
          }
        }
        if (occludedBy !== null && !seenOcclusion.has(nodeKey)) {
          seenOcclusion.add(nodeKey);
          warnings.push({
            code: 'occluded',
            detail: `${label} is occluded by ${occludedBy}.`,
            ref: label,
          });
        }
        const htmlElement = element as HTMLInputElement;
        const inputType = element.localName === 'input'
          ? (element.getAttribute('type') ?? 'text').trim().toLowerCase()
          : '';
        const value = element.localName === 'select'
          ? normalizedText((element as HTMLSelectElement).selectedOptions[0]?.textContent, 1000)
          : ['input', 'textarea'].includes(element.localName)
            ? String(htmlElement.value ?? '')
            : element.hasAttribute('contenteditable')
              ? element.textContent ?? ''
              : null;
        const testSelector = uniqueTestSelector(element);
        const choiceOwner = role === 'option' ? choiceOwnerFor(element) : null;
        const choiceOwnerNodeKey = choiceOwner === null
          ? null
          : elementNodeKeys.get(choiceOwner)
            ?? `${framePath}|${shadowPath.join('>>')}|${structuralSelector(choiceOwner)}`;
        const raw: Record<string, unknown> = {
          nodeKey,
          order,
          depth,
          label,
          tag: element.localName,
          role,
          inputType: element.localName === 'input' ? inputType : null,
          type: classification.type,
          kind: classification.kind,
          risk: classification.risk,
          confidence: Math.round(confidence * 100) / 100,
          evidence,
          state: {
            disabled: Boolean((element as HTMLButtonElement).disabled) || element.getAttribute('aria-disabled') === 'true',
            expanded: element.localName === 'summary'
              ? element.closest('details')?.hasAttribute('open') === true
              : parseBoolean(element.getAttribute('aria-expanded')),
            checked: 'checked' in element
              ? Boolean((element as HTMLInputElement).checked)
              : parseBoolean(element.getAttribute('aria-checked')),
            selected: 'selected' in element
              ? Boolean((element as HTMLOptionElement).selected)
              : parseBoolean(element.getAttribute('aria-selected')),
            pressed: parseBoolean(element.getAttribute('aria-pressed')),
            readonly: 'readOnly' in element
              ? Boolean((element as HTMLInputElement).readOnly)
              : parseBoolean(element.getAttribute('aria-readonly')),
            required: 'required' in element
              ? Boolean((element as HTMLInputElement).required)
              : parseBoolean(element.getAttribute('aria-required')),
          },
          value,
          placeholder: element.getAttribute('placeholder'),
          visible,
          inViewport,
          hitTestable,
          occludedBy,
          regionKey: activeRegionKey,
          shadowPath,
          rect,
          locator: {
            testId: testSelector,
            associatedLabel: associatedLabel(element) || null,
            placeholder: element.getAttribute('placeholder'),
            structural: structuralSelector(element),
          },
          controlsId: element.getAttribute('aria-controls'),
          observedDestination: element.localName === 'a'
            ? (element as HTMLAnchorElement).href
            : null,
          ancestorIds,
          collectionKey: null,
          collectionMemberKey: null,
          anchor: null,
          relPath: null,
          optionOfKey: choiceOwnerNodeKey,
        };
        actions.push(raw);
        actionRecords.push({ element, raw });

        // <option> elements score ~0 in the evidence model: they have no
        // implicit interactive role, tabIndex -1, and a zero-area rect while
        // the select is closed. Enumerate them from the select instead of
        // relying on the walk, so a dropdown's choices are inventoried rather
        // than collapsed into the select's current value.
        if (element.localName === 'select') {
          const selectElement = element as HTMLSelectElement;
          const selectSelector = structuralSelector(element);
          Array.from(selectElement.options).forEach((optionElement, optionIndex) => {
            const optionLabel = normalizedText(
              optionElement.label || optionElement.textContent,
              180,
            );
            if (optionLabel === '') return;
            const group = optionElement.parentElement;
            const groupLabel = group !== null && group.localName === 'optgroup'
              ? normalizedText(group.getAttribute('label'), 180)
              : '';
            actions.push({
              nodeKey: `${nodeKey}|option[${optionIndex + 1}]`,
              order: order + optionIndex + 1,
              depth: depth + 1,
              label: optionLabel,
              tag: 'option',
              role: 'option',
              inputType: null,
              type: 'input',
              kind: 'select',
              risk: riskFor(optionLabel, 'select'),
              confidence: 1,
              // Declared by the DOM. No inference took place, so the evidence
              // is the native tag alone.
              evidence: ['native_tag'],
              state: {
                disabled: optionElement.disabled || selectElement.disabled,
                expanded: null,
                checked: null,
                selected: optionElement.selected,
                pressed: null,
                readonly: null,
                required: null,
              },
              value: optionElement.value,
              placeholder: null,
              // An option is not independently clickable while the select is
              // closed. The parent select must be operated first.
              visible: false,
              inViewport: false,
              hitTestable: false,
              occludedBy: null,
              regionKey: activeRegionKey,
              shadowPath,
              // Options have no box of their own; point at the select so
              // highlighting resolves to something the user can see.
              rect,
              locator: {
                testId: null,
                associatedLabel: groupLabel === '' ? null : groupLabel,
                placeholder: null,
                structural: `${selectSelector} > option:nth-of-type(${optionIndex + 1})`,
              },
              controlsId: null,
              observedDestination: null,
              ancestorIds,
              collectionKey: null,
              collectionMemberKey: null,
              anchor: null,
              relPath: null,
              optionOfKey: nodeKey,
            });
          });
        }
      }

      const currentValue = normalizedText(element.textContent, 1000);
      const observableRole = element.getAttribute('role') ?? '';
      const declaredObservable = element.localName === 'output'
        || ['status', 'alert', 'log'].includes(observableRole)
        || element.hasAttribute('aria-live')
        || element.hasAttribute('aria-busy');
      const inferredObservable = element.children.length === 0
        && currentValue !== ''
        && (
          /^(?:[$€£₹]|USD\s*)[-+]?\d[\d,]*(?:\.\d+)?$/u.test(currentValue)
          || /^[-+]?\d+(?:\.\d+)?\s*%$/u.test(currentValue)
          || /^(?:Quantity|Count)\s+\d+$/iu.test(currentValue)
          || /(?:badge|count|price|total|amount|quantity)/iu.test(`${element.id} ${element.className}`)
        );
      const isValidation = observableRole === 'alert'
        || /(?:error|validation|invalid)/iu.test(`${element.id} ${element.className}`);
      if ((declaredObservable || inferredObservable) && confidence < 0.6) {
        const label = observableLabel(element, currentValue);
        const raw: Record<string, unknown> = {
          nodeKey,
          order,
          label,
          kind: isValidation
            ? 'validation'
            : observableRole === 'status' || element.hasAttribute('aria-live')
              ? 'live_region'
              : /(?:badge|count)/iu.test(`${element.id} ${element.className}`)
                ? 'count'
                : 'value_display',
          valueType: valueType(currentValue, label),
          currentValue,
          regionKey: activeRegionKey,
          shadowPath: [...shadowPath],
          rect,
          collectionKey: null,
          collectionMemberKey: null,
          anchor: null,
          relPath: null,
        };
        observables.push(raw);
        observableRecords.push({ element, raw });
      }

      const nextAncestors = element.id === '' ? ancestorIds : [...ancestorIds, element.id];
      const shadow = element.shadowRoot ?? shadowRoots.get(element);
      if (shadow !== undefined && shadow !== null) {
        const hostSelector = structuralSelector(element);
        for (const child of Array.from(shadow.children)) {
          visit(
            child,
            depth + 1,
            [...shadowPath, hostSelector],
            activeRegionKey,
            nextParentRegionKey,
            nextAncestors,
          );
        }
      }
      // Visit a host's shadow surface before its light children so an assigned
      // node can inherit the semantic region that owns its <slot>. The node's
      // locator remains light-DOM rooted; only its group ancestry follows the
      // composed tree.
      for (const child of Array.from(element.children)) {
        const assignedSlot = assignedSlotFor(child);
        const slotRegion = assignedSlot === null
          ? undefined
          : elementRegionKeys.get(assignedSlot);
        visit(
          child,
          depth + 1,
          shadowPath,
          slotRegion ?? activeRegionKey,
          slotRegion ?? nextParentRegionKey,
          nextAncestors,
        );
      }
    };

    if (document.documentElement !== null) {
      visit(document.documentElement, 0, [], rootRegionKey, rootRegionKey, []);
    }

    const shapeOf = (element: Element): string => {
      const classes = Array.from(element.classList).map(dehashClass).sort().join('.');
      const role = element.getAttribute('role') ?? '';
      const childShape = composedChildren(element)
        .slice(0, 6)
        .map((child) => `${child.localName}:${child.getAttribute('role') ?? ''}`)
        .join(',');
      return `${element.localName}|${role}|${classes}|${childShape}`;
    };

    const withinComposedSubtree = (container: Element, candidate: Element): boolean => {
      let cursor: Element | null = candidate;
      while (cursor !== null) {
        if (cursor === container) return true;
        cursor = composedParent(cursor);
      }
      return false;
    };

    const safeIdentityName = (element: Element): string => {
      const identity = element.id
        || Array.from(element.classList)[0]
        || (element.localName.includes('-') ? element.localName : '');
      // Odoo/Owl implementation classes commonly start with o_/oe_. Exposing
      // that namespace as "O apps" is less useful than the semantic "Apps".
      return humanize(identity.replace(/^(?:o|oe|owl)[_-]+/iu, ''));
    };

    const collectionLabelFor = (container: Element): string => {
      const explicit = normalizedText(container.getAttribute('aria-label'))
        || labelledByText(container);
      if (explicit !== '') return explicit;
      const directSemantic = composedChildren(container).find((candidate) => candidate.matches(
        'caption, legend, h1, h2, h3, h4, h5, h6, [role="heading"]',
      )) ?? null;
      const directName = normalizedText(directSemantic?.textContent);
      if (directName !== '') return directName;
      const preceding = container.previousElementSibling;
      if (
        preceding !== null
        && /^(?:h[1-6])$/u.test(preceding.localName)
      ) {
        const precedingName = normalizedText(preceding.textContent);
        if (precedingName !== '') return precedingName;
      }
      return safeIdentityName(container) || 'Collection';
    };

    const meaningfulVisualCache = new WeakMap<Element, Element[]>();
    const meaningfulVisuals = (member: Element): Element[] => {
      const cached = meaningfulVisualCache.get(member);
      if (cached !== undefined) return cached;
      const candidates = new Set<Element>();
      if (member.matches('img, [role="img"], svg')) candidates.add(member);
      const descendants = shadowInclusiveDescendants(member);
      for (const visual of descendants.filter((candidate) =>
        candidate.matches('img, [role="img"], svg'),
      )) {
        candidates.add(visual);
      }
      // A launcher logo is often supplied as a CSS background rather than an
      // <img>. Record only the owning box and never the background URL itself.
      // Bound the style walk so one unusually deep card cannot dominate a scan.
      for (const candidate of [member, ...descendants.slice(0, 200)]) {
        try {
          if (getComputedStyle(candidate).backgroundImage.includes('url(')) candidates.add(candidate);
        } catch {
          // Hostile custom elements may reject style access.
        }
      }
      const eligible = [...candidates].filter((visual) => {
        if (composedClosest(visual, '[aria-hidden="true"]') !== null) return false;
        const box = visual.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return false;
        if (visual.localName === 'svg') {
          const named = normalizedText(
            visual.getAttribute('aria-label')
            || visual.getAttribute('title')
            || visual.querySelector(':scope > title')?.textContent,
          );
          const substantive = visual.querySelector(
            'path, circle, rect, ellipse, polygon, polyline, line, use, image, text',
          ) !== null;
          if (named === '' && visual.getAttribute('role') !== 'img' && !substantive) return false;
        }
        return true;
      });
      const result = eligible.filter((visual, index) => {
        // `[role=img]` can wrap an actual img/svg. Keep the innermost visual so
        // one logo does not become two cells.
        return !eligible.some((other, otherIndex) =>
          otherIndex !== index && withinComposedSubtree(visual, other),
        );
      });
      meaningfulVisualCache.set(member, result);
      return result;
    };

    const anchorFor = (member: Element): { value: string; relPath: string } => {
      const memberIsAnchor = member.matches('a[href], [data-anchor]');
      const explicit = memberIsAnchor
        ? member
        : inclusiveFind(member,
            '[data-anchor], h1, h2, h3, h4, h5, h6, [role="heading"]',
          );
      const navigationActions = actionRecords.filter(({ element, raw }) =>
        raw.type === 'navigation' && withinComposedSubtree(member, element),
      );
      const titleAction = navigationActions.find(({ element }) =>
        element.matches(
          '[data-testid*="title"], [data-test*="title"], [class*="title"], [class*="name"]',
        )
        || inclusiveFind(element,
          '[data-testid*="title"], [data-test*="title"], [class*="title"], [class*="name"]',
        ) !== null,
      ) ?? navigationActions.find(({ raw }) =>
        normalizedText(String(raw.label)) !== '',
      );
      const visual = shadowInclusiveDescendants(member).find((element) =>
        element.matches('img[alt], [role="img"][aria-label], svg[aria-label]')
        && normalizedText(
        element.getAttribute('alt') || element.getAttribute('aria-label'),
        ) !== '',
      );
      const fallbackText = shadowInclusiveDescendants(member).find(
        (element) => element.matches('strong, span, p, div')
          && composedChildren(element).length === 0
          && normalizedText(element.textContent) !== '',
      );
      const target = explicit ?? titleAction?.element ?? visual ?? fallbackText ?? member;
      const value = titleAction?.element === target
        ? normalizedText(String(titleAction.raw.label))
        : normalizedText(
            target.getAttribute('data-anchor')
            || target.getAttribute('aria-label')
            || target.getAttribute('alt')
            || (target === member ? shadowInclusiveText(target) : accessibleName(target)),
          );
      return {
        value,
        relPath: target === member ? ':scope' : structuralSelector(target, member),
      };
    };

    const aligned = (members: Element[], parentDisplay: string): boolean => {
      if (parentDisplay.includes('grid') || parentDisplay.includes('flex')) return true;
      const boxes = members.map((member) => member.getBoundingClientRect());
      const allX = boxes.every((box) => Math.abs(box.x - (boxes[0]?.x ?? box.x)) <= 4);
      const allY = boxes.every((box) => Math.abs(box.y - (boxes[0]?.y ?? box.y)) <= 4);
      return allX || allY;
    };

    const nearestComposedScrollContainer = (element: Element): Element | null => {
      let cursor: Element | null = element;
      while (cursor !== null) {
        const style = getComputedStyle(cursor);
        const verticalOverflow = `${style.overflowY} ${style.overflow}`;
        const hasScrollableExtent = cursor.scrollHeight > cursor.clientHeight + 1;
        if (
          hasScrollableExtent
          && (
            /(?:auto|overlay|scroll)/iu.test(verticalOverflow)
            || cursor === document.scrollingElement
          )
        ) return cursor;
        cursor = composedParent(cursor);
      }
      return null;
    };

    const tableColumnHeaders = new WeakMap<Element, Map<number, string>>();
    const columnHeadersFor = (container: Element): Map<number, string> => {
      const cached = tableColumnHeaders.get(container);
      if (cached !== undefined) return cached;
      const indexed = new Map<number, string>();
      for (const header of Array.from(container.querySelectorAll(
        'thead th, th[scope="col"], [role="columnheader"]',
      ))) {
        const declared = Number.parseInt(header.getAttribute('aria-colindex') ?? '', 10);
        const headerRow = header.closest('tr, [role="row"]');
        const headerCells = headerRow === null
          ? []
          : Array.from(headerRow.children).filter((candidate) => candidate.matches(
              'th, td, [role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]',
            ));
        const index = Number.isFinite(declared) && declared > 0
          ? declared - 1
          : headerCells.indexOf(header);
        if (index < 0 || indexed.has(index)) continue;
        const name = normalizedText(
          header.getAttribute('aria-label') || labelledByText(header) || header.textContent,
        );
        if (name !== '') indexed.set(index, name);
      }
      tableColumnHeaders.set(container, indexed);
      return indexed;
    };

    const tableColumnName = (
      container: Element,
      member: Element,
      valueElement: Element,
    ): string => {
      if (!container.matches('table, [role="table"], [role="grid"], [aria-rowcount]')) return '';
      const cell = valueElement.closest(
        'td, th, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]',
      );
      if (cell === null || !withinComposedSubtree(member, cell)) return '';

      const explicit = normalizedText(cell.getAttribute('aria-label')) || labelledByText(cell);
      if (explicit !== '') return explicit;
      const root = cell.getRootNode() as Document | ShadowRoot;
      const headers = (cell.getAttribute('headers') ?? '')
        .split(/\s+/u)
        .filter(Boolean)
        .map((id) => normalizedText(root.querySelector(`#${cssEscape(id)}`)?.textContent))
        .filter(Boolean);
      if (headers.length > 0) return headers.join(' / ');

      const row = cell.closest('tr, [role="row"]');
      if (row === null) return '';
      const rowCells = Array.from(row.children).filter((candidate) => candidate.matches(
        'td, th, [role="cell"], [role="gridcell"], [role="rowheader"], [role="columnheader"]',
      ));
      const declaredIndex = Number.parseInt(cell.getAttribute('aria-colindex') ?? '', 10);
      const columnIndex = Number.isFinite(declaredIndex) && declaredIndex > 0
        ? declaredIndex - 1
        : rowCells.indexOf(cell);
      if (columnIndex < 0) return '';

      return columnHeadersFor(container).get(columnIndex) ?? '';
    };

    /**
     * Turn implementation-oriented row field names into compact table headers.
     *
     * Repeated components commonly prefix every class/test id with the
     * collection and member vocabulary (`inventory_item_price`). Repeating that
     * prefix in every column wastes the small inspector width and obscures
     * useful operational fields such as Price, Status, and Role.
     */
    const collectionColumnName = (
      collectionLabel: string,
      element: Element,
      fallback: string,
    ): string => {
      const identity = element.getAttribute('data-label')
        || element.getAttribute('data-field')
        || element.getAttribute('data-name')
        || element.getAttribute('data-testid')
        || element.getAttribute('data-test')
        || element.id
        || Array.from(element.classList)[0]
        || '';
      const source = humanize(identity) || normalizedText(fallback) || 'Text';
      const collectionWords = new Set(
        humanize(collectionLabel).toLocaleLowerCase().split(/\s+/u).filter(Boolean),
      );
      const structuralWords = new Set([
        'collection', 'container', 'detail', 'details', 'field', 'item', 'items',
        'list', 'object', 'objects', 'row', 'rows', 'table',
      ]);
      const words = source.split(/\s+/u).filter(Boolean);
      while (
        words.length > 1
        && (
          collectionWords.has((words[0] ?? '').toLocaleLowerCase())
          || structuralWords.has((words[0] ?? '').toLocaleLowerCase())
        )
      ) {
        words.shift();
      }
      const compact = words.join(' ') || source;
      if (/^desc(?:ription)?$/iu.test(compact)) return 'Description';
      if (/^(?:price|cost|amount)$/iu.test(compact)) return 'Price';
      if (/^(?:img|image|photo|thumbnail)$/iu.test(compact)) return 'Image';
      return `${compact[0]?.toUpperCase() ?? ''}${compact.slice(1)}`;
    };

    const likelyMutableCollectionColumn = (column: string): boolean =>
      /(?:^|\s)(?:access|active|amount|assignee|balance|count|created|date|email|health|inventory|last active|owner|permission|phone|plan|price|progress|quantity|rating|region|role|state|status|stock|team|tier|total|updated|usage|version)(?:\s|$)/iu
        .test(normalizedText(column).toLocaleLowerCase());

    const narrativeCollectionColumn = (column: string): boolean => {
      const normalizedColumn = normalizedText(column).toLocaleLowerCase();
      return /(?:^|\s)(?:about|bio|caption|content|desc|description|details?|excerpt|notes?|summary|subtitle)(?:\s|$)/iu.test(normalizedColumn)
        && !likelyMutableCollectionColumn(normalizedColumn);
    };

    const operationalCollectionText = (
      column: string,
      value: string,
      explicitTableColumn: boolean,
    ): boolean => {
      const normalizedColumn = normalizedText(column).toLocaleLowerCase();
      // Repeated-object rows are an operational data model. Card descriptions,
      // bios, and other presentation prose are neither actionable nor useful
      // changing state, so do not spend artifact/model budget on them.
      if (narrativeCollectionColumn(normalizedColumn)) {
        return false;
      }
      if (value.length > 160) return false;
      // Explicit table/grid headers are the application's own data schema.
      // Preserve concise columns such as Email, Role, Team, or Phone even when
      // the DOM does not expose them as live observables.
      if (explicitTableColumn) return true;
      if (likelyMutableCollectionColumn(normalizedColumn)) {
        return true;
      }
      return /^(?:[-+]?\d[\d,.]*%?|\S+@\S+\.\S+|\+?[\d ()-]{7,}|active|blocked|disabled|enabled|inactive|invited|offline|online|pending)$/iu.test(value);
    };

    const seenCollectionMembers = new Set<Element>();
    const seenCollectionKeys = new Set<string>();
    for (const parent of allElements) {
      const children = composedChildren(parent);
      if (children.length < 3) continue;
      // Choices are the finite value domain of one control, not repeated
      // business objects.  Promoting <select><option>...</option></select> (or
      // an ARIA listbox) created a bogus collection/open-menu branch beside
      // the real select action.  The option actions remain enumerated and are
      // linked to their owner through optionOfKey/parentAction.
      const choiceChildren = children.every((child) =>
        child.localName === 'option'
        || child.localName === 'optgroup'
        || child.getAttribute('role') === 'option',
      );
      const firstChoiceOwner = choiceChildren ? choiceOwnerFor(children[0] as Element) : null;
      const oneChoiceControl = firstChoiceOwner !== null
        && children.every((child) => choiceOwnerFor(child) === firstChoiceOwner);
      const directChoiceOwner = ['select', 'datalist', 'optgroup'].includes(parent.localName)
        || ['listbox', 'combobox'].includes(parent.getAttribute('role') ?? '');
      if (directChoiceOwner || (choiceChildren && oneChoiceControl)) continue;
      const parentDisplay = getComputedStyle(parent).display;
      // Launchers and visual card grids commonly vary the logo implementation
      // per item (<img>, inline SVG, CSS background) while retaining one
      // repeated outer tile. Group by the outer semantic shape in that case;
      // strict descendant shape remains the default elsewhere.
      const visualTileFamily = (parentDisplay.includes('grid') || parentDisplay.includes('flex'))
        && children.every((member) => meaningfulVisuals(member).length > 0)
        && children.every((member) =>
          member.localName === children[0]?.localName
          && (member.getAttribute('role') ?? implicitRole(member))
            === (children[0]?.getAttribute('role') ?? (children[0] === undefined ? '' : implicitRole(children[0]))),
        );
      const collectionShape = (member: Element): string => visualTileFamily
        ? `${member.localName}|${member.getAttribute('role') ?? implicitRole(member)}`
        : shapeOf(member);
      const authoritativeMemberFamily = (member: Element): string | null => {
        const role = member.getAttribute('role') ?? implicitRole(member);
        if (['article', 'listitem', 'row'].includes(role)) return `role:${role}`;
        if (['article', 'li', 'tr'].includes(member.localName)) return `tag:${member.localName}`;
        if (member.localName.includes('-')) return `custom:${member.localName}|${role}`;
        return null;
      };

      // aria-posinset/aria-setsize identify one logical recycled collection
      // even when ads, loading sentinels, or recommendation shelves are
      // interleaved between its currently rendered members.
      const semanticFamilies = new Map<string, Element[]>();
      for (const child of children) {
        const position = Number.parseInt(child.getAttribute('aria-posinset') ?? '', 10);
        const setSize = Number.parseInt(child.getAttribute('aria-setsize') ?? '', 10);
        if (!(position > 0) || (!(setSize > 0) && setSize !== -1)) continue;
        // ARIA set metadata is authoritative. Runtime classes such as
        // selected/watched/loading are state, not object shape, so do not let
        // them fragment one virtualized pool.
        const familyKey = authoritativeMemberFamily(child);
        const key = `${familyKey ?? collectionShape(child)}|set:${setSize}`;
        const members = semanticFamilies.get(key) ?? [];
        members.push(child);
        semanticFamilies.set(key, members);
      }
      const parentRole = parent.getAttribute('role') ?? implicitRole(parent);
      const parentIdentity = semanticIdentityParts(parent).join(' ');
      const authoritativePool = ['feed', 'list', 'grid'].includes(parentRole)
        || ['ul', 'ol'].includes(parent.localName)
        || (
          parent.localName.includes('-')
          && /(?:^|\s)(?:feed|grid|list)(?:\s|$)/iu.test(parentIdentity)
        );
      if (authoritativePool) {
        for (const child of children) {
          const familyKey = authoritativeMemberFamily(child);
          if (familyKey === null) continue;
          const key = `pool:${familyKey}`;
          const family = semanticFamilies.get(key) ?? [];
          family.push(child);
          semanticFamilies.set(key, family);
        }
      }
      const memberRuns: Array<{ familyKey: string; members: Element[] }> = [
        ...semanticFamilies.entries(),
      ]
        .filter(([, family]) => family.length >= 3)
        .map(([familyKey, family]) => ({
          familyKey,
          members: [...family].sort((left, right) =>
            Number.parseInt(left.getAttribute('aria-posinset') ?? '0', 10)
            - Number.parseInt(right.getAttribute('aria-posinset') ?? '0', 10),
          ),
        }));
      const canonicalFamilyKey = (familyKey: string): string => familyKey
        .replace(/^pool:/u, '')
        .replace(/\|set:-?\d+$/u, '');
      const authoritativeFamilyKeys = new Set(
        [...semanticFamilies.entries()]
          .filter(([, family]) => family.length >= 3)
          .map(([familyKey]) => canonicalFamilyKey(familyKey)),
      );
      const familyDisplayName = (familyKey: string): string => {
        const canonical = canonicalFamilyKey(familyKey)
          .replace(/^(?:custom|role|tag):/u, '');
        return humanize(canonical.split('|')[0] ?? canonical);
      };
      let runStart = 0;
      while (runStart < children.length) {
        const signature = collectionShape(children[runStart] as Element);
        let runEnd = runStart + 1;
        while (runEnd < children.length && collectionShape(children[runEnd] as Element) === signature) {
          runEnd += 1;
        }
        const members = children.slice(runStart, runEnd);
        const familyKey = `run:${signature}`;
        runStart = runEnd;
        memberRuns.push({ familyKey, members });
      }
      for (const { familyKey, members } of memberRuns) {
        if (members.length < 3 || members.some((member) => seenCollectionMembers.has(member))) continue;
        const primitiveRoles = new Set([
          'button', 'textbox', 'checkbox', 'radio', 'switch', 'combobox',
          'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
          'menuitemradio', 'slider', 'spinbutton', 'treeitem', 'gridcell',
        ]);
        const primitiveMembers = members.every((member) => {
          const memberRole = member.getAttribute('role') ?? implicitRole(member);
          return [
            'button', 'input', 'select', 'textarea', 'option', 'summary',
          ].includes(member.localName) || primitiveRoles.has(memberRole);
        });
        // A row of ordinary controls is a toolbar/action cluster. It becomes a
        // collection only when each control is a genuine visual tile (for
        // example an app launcher with a logo), which was established above.
        if (primitiveMembers && !visualTileFamily) continue;
        const texts = members.map((member) => shadowInclusiveText(member));
        if (new Set(texts).size < 2) continue;
        if (!aligned(members, parentDisplay)) continue;
        const navigation = composedClosest(parent, 'nav, [role="navigation"]');
        const nativeTable = composedClosest(parent, 'table, [role="table"]');
        // In a table, the repeated business objects are rows. Header cells and
        // each row's repeated td/th cells otherwise look like valid sibling
        // runs and collide on the same semantic table owner.
        if (
          nativeTable !== null
          && !members.every((member) =>
            member.localName === 'tr' || member.getAttribute('role') === 'row',
          )
        ) continue;
        const candidateContainer = composedClosest(
          parent,
          'table, [role="table"], [aria-rowcount], [role="grid"]',
        ) ?? (parent.localName === 'slot' ? composedParent(parent) ?? parent : parent);
        const baseLabel = collectionLabelFor(candidateContainer);
        // When one authoritative feed owns heterogeneous repeated families,
        // expose that distinction to the UI/agent as well as the hidden key.
        // Two identical "Following creators" tables are otherwise impossible
        // for a small model (or a person) to address deterministically.
        const label = authoritativeFamilyKeys.size > 1 && !familyKey.startsWith('run:')
          ? `${baseLabel} · ${familyDisplayName(familyKey)}`
          : baseLabel;
        const containerIdentity = `${candidateContainer.id} ${candidateContainer.className} ${label}`;
        const appTileRun = members.every((member) => meaningfulVisuals(member).length > 0)
          && (
            parentDisplay.includes('grid')
            || /(?:^|[\s_-])(?:app|apps|launcher|tile|tiles|card|cards)(?:$|[\s_-])/iu.test(containerIdentity)
          );
        if (navigation !== null && !appTileRun) {
          const navigationLabel = normalizedText(navigation.getAttribute('aria-label')) || label;
          warnings.push({
            code: 'collection_rejected',
            detail: `${navigationLabel} was rejected because it is global navigation.`,
            ref: navigationLabel,
          });
          continue;
        }
        const anchorsWithPath = members.map(anchorFor);
        const anchors = anchorsWithPath.map(({ value }) => value);
        const anchorCounts = new Map<string, number>();
        for (const anchor of anchors) {
          anchorCounts.set(anchor, (anchorCounts.get(anchor) ?? 0) + 1);
        }
        const attributeCounts = new Map<string, number>();
        for (const member of members) {
          for (const attribute of ['data-key', 'data-id']) {
            const value = member.getAttribute(attribute);
            if (value !== null && value !== '') {
              const key = `${attribute}:${value}`;
              attributeCounts.set(key, (attributeCounts.get(key) ?? 0) + 1);
            }
          }
        }
        const anchorOccurrences = new Map<string, number>();
        const memberIdentities = members.map((member, memberIndex) => {
          const anchor = anchors[memberIndex] ?? '';
          if (anchor !== '' && anchorCounts.get(anchor) === 1) return `anchor:${anchor}`;
          const uniqueAttribute = ['data-key', 'data-id']
            .map((attribute) => {
              const value = member.getAttribute(attribute);
              return value === null || value === '' ? null : `${attribute}:${value}`;
            })
            .find((candidate): candidate is string =>
              candidate !== null && attributeCounts.get(candidate) === 1,
            );
          if (uniqueAttribute !== undefined) return uniqueAttribute;
          const uniqueSelector = uniqueIdSelector(member) ?? uniqueTestSelector(member);
          if (uniqueSelector !== null) return `selector:${uniqueSelector}`;
          const position = Number.parseInt(member.getAttribute('aria-posinset') ?? '', 10);
          if (position > 0) return `position:${position}`;
          const occurrence = (anchorOccurrences.get(anchor) ?? 0) + 1;
          anchorOccurrences.set(anchor, occurrence);
          return `anchor:${anchor || 'unnamed'}|occurrence:${occurrence}`;
        });
        const entropy = new Set(anchors).size / members.length;
        const declaredFromMembers = members.reduce((maximum, member) => Math.max(
          maximum,
          Number.parseInt(member.getAttribute('aria-setsize') ?? '0', 10) || 0,
        ), 0);
        const declaredRaw = candidateContainer.getAttribute('aria-rowcount');
        const declared = Math.max(
          members.length,
          declaredFromMembers,
          Number.parseInt(declaredRaw ?? '0', 10) || 0,
        );
        const scrollContainer = nearestComposedScrollContainer(candidateContainer);
        const positions = members.map((member) =>
          Number.parseInt(member.getAttribute('aria-posinset') ?? '', 10),
        ).filter((position) => position > 0);
        const positionMinimum = positions.length === 0 ? 0 : Math.min(...positions);
        const positionMaximum = positions.length === 0 ? 0 : Math.max(...positions);
        const positionWindow = positions.length === members.length
          && (
            positionMinimum > 1
            || positionMaximum - positionMinimum + 1 > positions.length
          );
        const unknownSetSize = members.some((member) =>
          Number.parseInt(member.getAttribute('aria-setsize') ?? '', 10) === -1,
        );
        const unknownVirtualized = unknownSetSize
          && positionWindow
          && scrollContainer !== null;
        const virtualized = declared > members.length || unknownVirtualized;
        const containerNodeKey = elementNodeKeys.get(candidateContainer)
          ?? `${framePath}||${structuralSelector(candidateContainer)}`;
        // A feed may authoritatively expose more than one repeated family
        // (for example video and channel renderers). The family participates
        // in identity so the second collection cannot collide with the first.
        const collectionKey = `${containerNodeKey}|collection|${familyKey}`;
        const collectionMemberKeys = memberIdentities.map((identity) =>
          `${collectionKey}|member|${identity}`,
        );
        if (seenCollectionKeys.has(collectionKey)) continue;
        if (entropy < 0.7) {
          warnings.push({
            code: 'low_stability_anchor',
            detail: `${label} has no sufficiently distinct anchor field.`,
            ref: label,
          });
        }
        if (unknownVirtualized) {
          warnings.push({
            code: 'unknown_collection_size',
            detail: `${label} reports aria-setsize=-1; ${members.length} observed items are a lower bound.`,
            ref: label,
          });
        }
        const sampledAnchors = virtualized ? anchors.slice(0, 20) : anchors;
        const rows = members.map((member, memberIndex) => {
          const anchor = anchors[memberIndex] ?? String(memberIndex + 1);
          const memberActions = actionRecords.filter(({ element }) =>
            withinComposedSubtree(member, element),
          );
          const memberObservables = observableRecords.filter(({ element }) =>
            withinComposedSubtree(member, element),
          );
          const anchorAction = memberActions.find(({ element, raw }) =>
            element === member && raw.type === 'navigation',
          ) ?? memberActions.find(({ raw }) =>
            raw.type === 'navigation'
            && normalizedText(String(raw.label)).toLocaleLowerCase()
              .includes(anchor.toLocaleLowerCase()),
          ) ?? memberActions.find(({ raw }) => raw.type === 'navigation')
            ?? memberActions.find(({ element }) => element === member);
          const memberBox = member.getBoundingClientRect();
          const memberRect = {
            x: memberBox.left,
            y: memberBox.top,
            w: memberBox.width,
            h: memberBox.height,
          };
          const visuals = meaningfulVisuals(member);

          // A one-action visual tile is one composite target. Keep the real
          // action/locator but highlight the complete repeated object, which
          // includes its logo and label instead of a tiny nested text box.
          if (
            anchorAction !== undefined
            && memberActions.length === 1
            && anchorAction.raw.type === 'navigation'
            && visuals.length > 0
          ) {
            anchorAction.raw.rect = memberRect;
          }

          const cells: Array<Record<string, unknown>> = [];
          for (const action of memberActions) {
            const isAnchorAction = action === anchorAction;
            // When the repeated member is itself the link/button, the row's
            // anchor + anchorActionId is already its concrete interactive
            // cell. Repeating it inside cells would render "Discuss" twice.
            if (isAnchorAction && action.element === member) continue;
            cells.push({
              column: isAnchorAction
                ? action.raw.type === 'navigation' ? 'Title link' : 'Action'
                : action.raw.type === 'navigation'
                  ? 'Link'
                  : action.raw.type === 'input'
                    ? 'Input'
                    : action.raw.type === 'toggle'
                      ? 'Toggle'
                      : 'Action',
              type: 'action',
              value: normalizedText(String(action.raw.label)),
              rect: action.raw.rect,
              actionNodeKey: action.raw.nodeKey,
              observableNodeKey: null,
            });
          }
          for (const observable of memberObservables) {
            const column = collectionColumnName(
              label,
              observable.element,
              normalizedText(String(observable.raw.label)) || 'Value',
            );
            // Live regions can contain changing marketing/description copy.
            // They are technically observable, but not operational row state.
            if (narrativeCollectionColumn(column)) continue;
            cells.push({
              column,
              type: 'observable',
              value: normalizedText(String(observable.raw.currentValue), 1000),
              rect: observable.raw.rect,
              actionNodeKey: null,
              observableNodeKey: observable.raw.nodeKey,
            });
          }

          for (const visual of visuals.slice(0, 4)) {
            const visualBox = visual.getBoundingClientRect();
            const identity = `${visual.id} ${visual.className}`;
            const value = normalizedText(
              visual.getAttribute('alt')
              || visual.getAttribute('aria-label')
              || visual.getAttribute('title')
              || visual.querySelector(':scope > title')?.textContent,
            ) || 'Image';
            cells.push({
              column: /(?:logo|icon)/iu.test(identity) ? 'Logo' : 'Image',
              type: 'image',
              value,
              rect: {
                x: visualBox.left,
                y: visualBox.top,
                w: visualBox.width,
                h: visualBox.height,
              },
              actionNodeKey: null,
              observableNodeKey: null,
            });
          }

          const representedText = new Set([
            anchor,
            ...memberActions.map(({ raw }) => normalizedText(String(raw.label))),
            ...memberObservables.map(({ raw }) => normalizedText(String(raw.currentValue))),
          ].map((value) => value.toLocaleLowerCase()));
          const textCandidates = shadowInclusiveDescendants(member).filter((candidate) =>
            candidate.matches(
              'h1, h2, h3, h4, h5, h6, [role="heading"], [data-anchor], p, span, div, td, th, dt, dd, small, strong, time',
            ),
          );
          for (const textElement of textCandidates) {
            if (cells.length >= 20) break;
            if (textCandidates.some((other) =>
              other !== textElement && withinComposedSubtree(textElement, other),
            )) {
              continue;
            }
            if (memberActions.some(({ element }) => withinComposedSubtree(element, textElement))) {
              continue;
            }
            const value = normalizedText(textElement.textContent, 1000);
            const comparable = value.toLocaleLowerCase();
            if (value === '' || representedText.has(comparable)) continue;
            const textBox = textElement.getBoundingClientRect();
            if (!isRendered(textElement, textBox)) continue;
            const tableColumn = tableColumnName(candidateContainer, member, textElement);
            const column = /^h[1-6]$/u.test(textElement.localName)
              || textElement.getAttribute('role') === 'heading'
              || textElement.hasAttribute('data-anchor')
              ? 'Title'
              : tableColumn || collectionColumnName(label, textElement, 'Text');
            if (!operationalCollectionText(column, value, tableColumn !== '')) continue;
            representedText.add(comparable);
            cells.push({
              column,
              type: 'text',
              value,
              rect: {
                x: textBox.left,
                y: textBox.top,
                w: textBox.width,
                h: textBox.height,
              },
              actionNodeKey: null,
              observableNodeKey: null,
            });
          }

          return {
            rowKey: collectionMemberKeys[memberIndex],
            anchor,
            rect: memberRect,
            anchorActionNodeKey: anchorAction === undefined
              ? null
              : String(anchorAction.raw.nodeKey),
            cells,
          };
        });
        const rawCollection: Record<string, unknown> = {
          key: collectionKey,
          order: order += 1,
          parentRegionKey: elementRegionKeys.get(candidateContainer) ?? rootRegionKey,
          shadowPath: [...(elementShadowPaths.get(candidateContainer) ?? [])],
          label,
          instancesObserved: members.length,
          instancesDeclared: declared,
          traversal: virtualized ? 'virtualized_scroll' : 'static',
          scrollContainer: virtualized && scrollContainer !== null
            ? structuralSelector(scrollContainer)
            : null,
          anchorRelPath: anchorsWithPath[0]?.relPath ?? ':scope',
          anchorEntropy: Math.round(entropy * 1000) / 1000,
          anchorStability: entropy >= 0.7 ? 'high' : 'low',
          anchorType: 'text',
          anchors: sampledAnchors,
          memberKeys: members.map((member, memberIndex) =>
            collectionMemberKeys[memberIndex]
            ?? `${containerNodeKey}|member|${structuralSelector(member, candidateContainer)}`,
          ),
          rows,
        };
        collections.push(rawCollection);
        seenCollectionKeys.add(collectionKey);
        members.forEach((member) => seenCollectionMembers.add(member));
        members.forEach((member, memberIndex) => {
          const anchor = anchors[memberIndex] ?? String(memberIndex + 1);
          const collectionMemberKey = collectionMemberKeys[memberIndex]
            ?? `${collectionKey}|member|${memberIndex + 1}`;
          for (const action of actionRecords) {
            if (!withinComposedSubtree(member, action.element)) continue;
            action.raw.collectionKey = collectionKey;
            action.raw.collectionMemberKey = collectionMemberKey;
            action.raw.anchor = anchor;
            action.raw.relPath = action.element === member
              ? ':scope'
              : structuralSelector(action.element, member);
          }
          for (const observable of observableRecords) {
            if (!withinComposedSubtree(member, observable.element)) continue;
            observable.raw.collectionKey = collectionKey;
            observable.raw.collectionMemberKey = collectionMemberKey;
            observable.raw.anchor = anchor;
            observable.raw.relPath = observable.element === member
              ? ':scope'
              : structuralSelector(observable.element, member);
          }
        });
      }
    }

    const primary = shadowInclusiveRoots()
      .map((root) => root.querySelector('main, [role="main"]'))
      .find((candidate): candidate is Element => candidate !== null)
      ?? inferredMainRegion
      ?? document.body;
    const documentShape = primary === null
      ? ''
      : shadowInclusiveDescendants(primary, 200)
        .map((element) => `${element.localName}:${element.getAttribute('role') ?? ''}`)
        .join('|');

    return {
      framePath,
      url: location.href,
      title: document.title,
      documentShape,
      actions,
      observables,
      regions,
      collections,
      warnings,
      stats: {
        nodesVisited,
        walkMs: Math.max(0, performance.now() - startedAt),
      },
    };
  };

  scope.__nexus = {
    version: 1,
    listenerTypes(target) {
      return [...(listeners.get(target)?.entries() ?? [])]
        .filter(([, registered]) => registered.size > 0)
        .map(([type]) => type)
        .sort();
    },
    registerShadowRoot(root) {
      shadowRoots.set(root.host, root);
      mutations?.observe(root, { attributes: true, characterData: true, childList: true, subtree: true });
    },
    shadowRoot(host) {
      return host.shadowRoot ?? shadowRoots.get(host) ?? null;
    },
    quiescent,
    waitForQuiescence(timeoutMs = 8_000) {
      if (quiescent().settled) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const done = (settled: boolean) => {
          window.clearTimeout(timeout);
          settleWaiters.delete(done);
          resolve(settled);
        };
        const timeout = window.setTimeout(() => done(false), timeoutMs);
        settleWaiters.add(done);
        scheduleSettleCheck();
      });
    },
    semanticSurfaceDigest,
    deepElementCount,
    highlight,
    clearHighlight,
    extract,
  };
}
