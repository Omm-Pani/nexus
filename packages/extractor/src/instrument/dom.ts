import type { DomElement, DomObservation, DomSnapshot } from '@nexus/schema';

/** Serialized into every frame. No imports or module values may be used here. */
export function domBootstrap(): void {
  type Runtime = {
    snapshot(frame: string): DomSnapshot;
    registerShadowRoot(root: ShadowRoot): void;
    takeRecords(): DomObservation[];
    flush(): void;
  };
  const scope = window as typeof window & {
    __nexusDom?: Runtime;
    __nexus?: { shadowRoot(element: Element): ShadowRoot | null; listenerTypes(element: Element): string[] };
    __nexusObserved?: (payload: string) => unknown;
  };
  if (scope.__nexusDom !== undefined) return;
  const documentId = `doc-${(crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)}`;
  const ids = new WeakMap<Node, string>();
  const roots = new WeakMap<Element, ShadowRoot>();
  const watched = new WeakSet<Node>();
  const seenEvents = new WeakSet<Event>();
  const eventTargets = new WeakMap<Event, EventTarget>();
  const causes = new WeakMap<Event, string>();
  const origins = new WeakMap<Event, 'user' | 'system'>();
  const focusedByHost = new WeakMap<Element, Element>();
  let programmaticFocus = 0;
  let focusGesture: { time: number; target: Element | null; keyboard: boolean } | undefined;
  let nextCause = 0;
  let activeCause: string | undefined;
  let activeUserEvent: Event | undefined;
  let nextId = 0;
  let sequence = 0;
  let pending: DomObservation[] = [];
  let flushTimer: number | undefined;
  const id = (node: Node): string => {
    let value = ids.get(node);
    if (value === undefined) { value = `${documentId}:dom${++nextId}`; ids.set(node, value); }
    return value;
  };
  const ignored = (node: Node): boolean => {
    let element = node instanceof Element ? node : node.parentElement;
    while (element !== null) {
      if (element.hasAttribute('data-nexus-overlay')) return true;
      const root = element.getRootNode();
      element = element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  };
  const safeValue = (_element: Element, _name: string, value: unknown): string => String(value ?? '');
  const label = (element: Element): string => {
    const root = element.getRootNode() as Document | ShadowRoot;
    const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/)
      .map((ref) => root.getElementById?.(ref)?.textContent ?? '').join(' ').trim();
    const labels = (element as HTMLInputElement).labels;
    return (element.getAttribute('aria-label') || labelledBy
      || (labels ? Array.from(labels, (item) => item.textContent ?? '').join(' ') : '')
      || element.getAttribute('placeholder') || element.getAttribute('alt')
      || element.getAttribute('title') || (element.matches('input, textarea, select') ? '' : element.textContent?.trim())
      || element.getAttribute('name') || element.id || element.localName).replace(/\s+/g, ' ').trim().slice(0, 160);
  };
  const editable = (element: Element): boolean => element.matches('textarea, input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color])') || (element as HTMLElement).isContentEditable;
  const state = (element: Element): Record<string, string | number | boolean | null> => {
    const result: Record<string, string | number | boolean | null> = {};
    const target = element as unknown as Record<string, unknown>;
    for (const name of ['value', 'checked', 'indeterminate', 'selected', 'selectedIndex', 'disabled', 'readOnly', 'required', 'open', 'scrollTop', 'scrollLeft', 'currentTime', 'paused', 'volume', 'muted']) {
      const value = target[name];
      if (typeof value === 'string') result[name] = safeValue(element, name, value);
      else if (typeof value === 'boolean' || typeof value === 'number') result[name] = value;
    }
    result.focused = element.getRootNode() instanceof ShadowRoot
      ? (element.getRootNode() as ShadowRoot).activeElement === element
      : document.activeElement === element;
    if ((element as HTMLElement).isContentEditable) result.value = element.textContent ?? '';
    return result;
  };
  const selector = (element: Element): string => {
    const segments: string[] = [];
    let cursor: Element | null = element;
    while (cursor !== null) {
      const siblings: Element[] = Array.from(cursor.parentNode?.children ?? []).filter((child) => child.localName === cursor!.localName);
      segments.unshift(`${cursor.localName}:nth-of-type(${Math.max(1, siblings.indexOf(cursor) + 1)})`);
      cursor = cursor.parentElement;
    }
    return segments.join(' > ');
  };
  const shadowFor = (element: Element): ShadowRoot | null => roots.get(element) ?? scope.__nexus?.shadowRoot(element) ?? element.shadowRoot;
  const describe = (element: Element, frame: string, parentId: string | null, shadowPath: string[], depth: number, boundary: DomElement['boundary']): DomElement => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      id: id(element), parentId, frame, documentId, shadowPath, depth, boundary,
      tag: element.localName, namespace: element.namespaceURI ?? '', selector: selector(element),
      attributes: Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name, safeValue(element, attribute.name, attribute.value)])),
      text: Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join(''),
      state: state(element),
      visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse',
      rect: { x: box.x, y: box.y, w: box.width, h: box.height },
      eventTypes: [...new Set([...(scope.__nexus?.listenerTypes(element) ?? []), ...Array.from(element.attributes).filter(({ name }) => name.startsWith('on')).map(({ name }) => name.slice(2))])].sort(),
    };
  };
  const flush = (): void => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pending.length === 0 || scope.__nexusObserved === undefined) return;
    const batch = pending;
    pending = [];
    try {
      const sent = scope.__nexusObserved(JSON.stringify(batch));
      if (sent instanceof Promise) void sent.catch(() => { pending.unshift(...batch); });
    } catch { pending.unshift(...batch); }
  };
  const record = (entry: Omit<DomObservation, 'documentId' | 'sequence' | 'timestamp' | 'url'>): void => {
    pending.push({ ...(activeCause === undefined || entry.kind === 'interaction' ? {} : { causeId: activeCause }), ...entry, documentId, sequence: ++sequence, timestamp: new Date().toISOString(), url: location.href });
    // Explicitly record a coverage gap if an unattached consumer cannot keep up.
    if (pending.length > 20_000) {
      const dropped = pending.splice(0, 10_000);
      pending.unshift({ documentId, sequence: dropped[0]!.sequence, timestamp: new Date().toISOString(), url: location.href, kind: 'gap', type: 'buffer_overflow', targetId: null, detail: { dropped: dropped.length } });
    }
    if (pending.length >= 200) flush();
    else if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 16);
  };
  const targetKey = (node: Node): string | null => {
    const element = node instanceof Element ? node : node instanceof ShadowRoot ? node.host : node instanceof Document ? node.documentElement : node.parentElement;
    return element === null ? null : id(element);
  };
  const eventTypes = [
    'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'keydown', 'keyup', 'beforeinput', 'input', 'change', 'compositionstart', 'compositionupdate', 'compositionend',
    'focus', 'blur', 'focusin', 'focusout', 'submit', 'reset', 'invalid', 'select', 'selectionchange',
    'dragstart', 'drag', 'dragenter', 'dragleave', 'dragover', 'drop', 'dragend', 'copy', 'cut', 'paste',
    'wheel', 'scroll', 'scrollend', 'resize', 'toggle', 'beforetoggle', 'slotchange', 'fullscreenchange',
    'play', 'pause', 'ended', 'volumechange', 'seeking', 'seeked', 'timeupdate', 'load', 'error',
    'animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel',
    'popstate', 'hashchange', 'pageshow', 'pagehide',
  ];
  const onEvent = (event: Event): void => {
    if (seenEvents.has(event)) return;
    let originalTarget = event.composedPath()[0] ?? event.target;
    if (/^(focus|blur|focusin|focusout)$/.test(event.type)) {
      // Native dispatch can run a microtask checkpoint before the inner closed
      // root listener. Resolve its focused leaf before that outer flush.
      while (originalTarget instanceof Element) {
        const host = originalTarget;
        const shadow = shadowFor(host);
        const leaf = shadow?.activeElement ?? (/^(blur|focusout)$/.test(event.type) ? focusedByHost.get(host) : null);
        if (!leaf) break;
        focusedByHost.set(host, leaf);
        originalTarget = leaf;
      }
    }
    if (event.isTrusted && (event.type === 'pointerdown' || (event.type === 'keydown' && (event as KeyboardEvent).key === 'Tab'))) {
      focusGesture = { time: event.timeStamp, target: originalTarget instanceof Element ? originalTarget : null, keyboard: event.type === 'keydown' };
    }
    if (!origins.has(event) || /^(focus|blur|focusin|focusout)$/.test(event.type)) {
      let user = event.isTrusted;
      if (/^(focus|blur|focusin|focusout)$/.test(event.type)) {
        const recent = focusGesture !== undefined && event.timeStamp - focusGesture.time < 1000;
        const target = originalTarget instanceof Element ? originalTarget : null;
        const gestureTarget = focusGesture?.target;
        let matches = focusGesture?.keyboard || gestureTarget === target || gestureTarget?.closest('label')?.control === target;
        let cursor = target;
        while (!matches && cursor?.getRootNode() instanceof ShadowRoot) {
          cursor = (cursor.getRootNode() as ShadowRoot).host;
          matches = gestureTarget === cursor;
        }
        user = user && programmaticFocus === 0 && recent && (/^(blur|focusout)$/.test(event.type) || !!matches);
      }
      origins.set(event, user ? 'user' : 'system');
    }
    if (origins.get(event) === 'system' && activeCause !== undefined && activeUserEvent && activeUserEvent.eventPhase !== Event.NONE) causes.set(event, activeCause);
    if (origins.get(event) === 'user' && /^(click|dblclick|auxclick|contextmenu|pointerdown|pointerover|pointermove|pointerout|keydown|input|change|focusin|focusout|drop|scroll|wheel)$/.test(event.type)) {
      let cause = causes.get(event);
      if (cause === undefined) { cause = `${documentId}:action${++nextCause}`; causes.set(event, cause); }
      activeCause = cause;
      activeUserEvent = event;
      const ownCause = cause;
      // Scope attribution to the event task; later independent updates are system steps.
      window.setTimeout(() => { if (activeCause === ownCause) activeCause = undefined; }, 0);
    }
    const observedTarget = originalTarget;
    if (observedTarget !== null) eventTargets.set(event, observedTarget);
    // Closed-root listeners see the original target before the outer document is processed.
    queueMicrotask(() => {
      if (seenEvents.has(event)) return;
      seenEvents.add(event);
      const target = eventTargets.get(event) ?? event.target;
      if (target instanceof Node && ignored(target)) return;
      const original = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      const element = original?.closest('input, textarea, select, button, a[href], [role="button"], [role="textbox"], [contenteditable="true"], [contenteditable=""]') ?? original;
      const detail: Record<string, string | number | boolean | null> = { trusted: event.isTrusted, origin: origins.get(event) ?? 'system' };
      if (element !== null) Object.assign(detail, state(element), { label: label(element), tag: element.localName, inputType: element.getAttribute('type') ?? '', editable: editable(element) });
      for (const name of ['key', 'code', 'button', 'buttons', 'clientX', 'clientY', 'deltaX', 'deltaY', 'inputType', 'data', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
        const value = (event as unknown as Record<string, unknown>)[name];
        if (typeof value === 'string') detail[name] = element === null ? value : safeValue(element, name, value);
        else if (typeof value === 'boolean' || typeof value === 'number') detail[name] = value;
      }
      record({ kind: 'interaction', type: event.type, targetId: element === null ? null : id(element), detail, ...(causes.has(event) ? { causeId: causes.get(event)! } : {}) });
      flush();
    });
  };
  const observer = new MutationObserver((records) => {
    for (let index = 0; index < records.length; index++) {
      const mutation = records[index]!;
      if (ignored(mutation.target)) continue;
      if (mutation.type === 'childList') {
        const added = Array.from(mutation.addedNodes).filter((node) => !ignored(node));
        const removed = Array.from(mutation.removedNodes).filter((node) => !ignored(node));
        if (added.length === 0 && removed.length === 0) continue;
        // Preserve removed and transient subtrees even when they disappear before a scan.
        const describeNodes = (nodes: Node[]): DomElement[] => nodes.flatMap((node) => node instanceof Element ? inventory(node, '', targetKey(mutation.target)).elements : []);
        record({ kind: 'mutation', type: 'childList', targetId: targetKey(mutation.target), added: describeNodes(added), removed: describeNodes(removed), detail: { addedText: added.filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''), removedText: removed.filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') } });
        for (const node of added) if (node instanceof Element) discoverRoots(node);
      } else {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        // The next record's oldValue is this mutation's actual new value.
        const next = records.slice(index + 1).find((candidate) => candidate.target === mutation.target && candidate.type === mutation.type && candidate.attributeName === mutation.attributeName);
        const name = mutation.attributeName ?? 'text';
        const current = next === undefined ? mutation.type === 'attributes' ? (mutation.target as Element).getAttribute(name) : mutation.target.textContent : next.oldValue;
        record({ kind: 'mutation', type: mutation.type, targetId: target === null ? id(mutation.target) : id(target), detail: { name, before: target === null ? mutation.oldValue : safeValue(target, name, mutation.oldValue), after: target === null ? current : safeValue(target, name, current) } });
      }
    }
  });
  const watch = (root: Document | ShadowRoot | DocumentFragment): void => {
    if (watched.has(root)) return;
    watched.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
    for (const type of eventTypes) root.addEventListener(type, onEvent, { capture: true, passive: true });
  };
  const registerShadowRoot = (root: ShadowRoot): void => {
    if (ignored(root.host)) return;
    roots.set(root.host, root);
    watch(root);
    discoverRoots(root);
  };
  const discoverRoots = (root: ParentNode): void => {
    const elements = root instanceof Element ? [root, ...root.querySelectorAll('*')] : Array.from(root.querySelectorAll('*'));
    for (const element of elements) {
      if (ignored(element)) continue;
      const shadow = shadowFor(element);
      if (shadow !== null && !watched.has(shadow)) registerShadowRoot(shadow);
      if (element instanceof HTMLTemplateElement && !watched.has(element.content)) { watch(element.content); discoverRoots(element.content); }
    }
  };
  const inventory = (root: ParentNode, frame: string, parent: string | null): DomSnapshot => {
    const elements: DomElement[] = [];
    const initial = root instanceof Element ? [root] : Array.from(root.children);
    const stack = initial.reverse().map((element) => ({ element, parentId: parent, shadowPath: [] as string[], depth: 0, boundary: 'light' as DomElement['boundary'] }));
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (ignored(item.element)) continue;
      elements.push(describe(item.element, frame, item.parentId, item.shadowPath, item.depth, item.boundary));
      const push = (children: Element[], boundary: DomElement['boundary'], shadowPath = item.shadowPath): void => {
        for (const element of children.reverse()) stack.push({ element, parentId: id(item.element), shadowPath, depth: item.depth + 1, boundary });
      };
      push(Array.from(item.element.children), 'light');
      if (item.element instanceof HTMLTemplateElement) push(Array.from(item.element.content.children), 'template');
      const shadow = shadowFor(item.element);
      if (shadow !== null) push(Array.from(shadow.children), shadow.mode === 'closed' ? 'shadow-closed' : 'shadow-open', [...item.shadowPath, selector(item.element)]);
    }
    return { documentId, frame, url: location.href, sequence, elements };
  };
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init): ShadowRoot {
    const root = attach.call(this, init);
    registerShadowRoot(root);
    if (!ignored(this)) record({ kind: 'mutation', type: 'shadowRoot', targetId: id(this), detail: { mode: init.mode } });
    return root;
  };
  Object.defineProperty(Element.prototype.attachShadow, 'toString', { configurable: true, value: attach.toString.bind(attach) });
  // focus()/blur() produce trusted browser events even when called by app code.
  // Preserve their origin at dispatch time, before the deferred event flush.
  for (const prototype of [HTMLElement.prototype, SVGElement.prototype]) {
    for (const name of ['focus', 'blur'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value !== 'function' || !descriptor.configurable) continue;
      const original = descriptor.value as (...args: unknown[]) => unknown;
      const wrapped = function(this: Element, ...args: unknown[]): unknown {
        programmaticFocus++;
        try { return original.apply(this, args); } finally { programmaticFocus--; }
      };
      Object.defineProperty(wrapped, 'toString', { configurable: true, value: original.toString.bind(original) });
      Object.defineProperty(prototype, name, { ...descriptor, value: wrapped });
    }
  }
  // Native property assignments do not emit MutationRecords or input events.
  for (const [prototype, names] of [
    [HTMLInputElement.prototype, ['value', 'checked', 'indeterminate']],
    [HTMLTextAreaElement.prototype, ['value']],
    [HTMLSelectElement.prototype, ['value', 'selectedIndex']],
    [HTMLOptionElement.prototype, ['selected']],
  ] as const) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.set === undefined || descriptor.get === undefined || !descriptor.configurable) continue;
      Object.defineProperty(prototype, name, { ...descriptor, set(this: Element, value: unknown) {
        const before = descriptor.get!.call(this);
        descriptor.set!.call(this, value);
        const after = descriptor.get!.call(this);
        if (before !== after && !ignored(this)) record({ kind: 'property', type: name, targetId: id(this), detail: { before: safeValue(this, name, before), after: safeValue(this, name, after) } });
      } });
    }
  }
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function(...args: Parameters<History[typeof name]>): void {
      const before = location.href; original.apply(this, args);
      record({ kind: 'navigation', type: name, targetId: null, detail: { before, after: location.href } });
    };
  }
  scope.__nexusDom = {
    snapshot(frame) { discoverRoots(document); return inventory(document, frame, null); },
    registerShadowRoot,
    takeRecords() { const records = pending; pending = []; return records; },
    flush,
  };
  watch(document);
  discoverRoots(document);
  for (const type of ['scroll', 'resize', 'popstate', 'hashchange', 'pageshow', 'pagehide']) window.addEventListener(type, onEvent, { capture: true, passive: true });
  window.addEventListener('pagehide', flush, { capture: true });
}
