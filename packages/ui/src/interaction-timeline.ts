import type { DomElement, DomObservation, DomSnapshot, OrchestratorEvent } from '@nexus/schema';

export type ActivityEvent = Extract<OrchestratorEvent, { t: 'dom.observed' | 'state.transition' }>;
export interface TimelineState { stateId: string; url: string; dom: DomSnapshot[] }
export interface TimelineStep {
  id: string;
  kind: 'User' | 'System';
  title: string;
  timestamp: string;
  value?: string;
  lifecycle: string[];
  changes: string[];
  stateIds: string[];
}
type Observation = DomObservation & { sessionSequence: number };
type Candidate = TimelineStep & { targetId: string | null; category: string; records: Observation[] };

const elementName = (element: DomElement): string => element.attributes['aria-label'] || element.attributes.placeholder || element.attributes.name || element.attributes.id || element.text.trim().slice(0, 80) || element.tag;
const observationName = (record: Observation, elements: Map<string, DomElement>): string => String(record.detail.label || (record.targetId ? elements.get(record.targetId) && elementName(elements.get(record.targetId)!) : '') || 'page');
const timestamp = (value: string): number => Date.parse(value) || 0;
const signature = ({ state, rect, id, documentId, ...element }: DomElement): string => {
  const { focused, ...properties } = state;
  return JSON.stringify({ ...element, state: properties });
};

/** A presentation of confirmed changes; raw observations remain in the journal. */
export function buildInteractionTimeline(events: ActivityEvent[], states: TimelineState[]): TimelineStep[] {
  const stateMap = new Map(states.map((state) => [state.stateId, state]));
  const transitions = events.filter((event): event is Extract<ActivityEvent, { t: 'state.transition' }> => event.t === 'state.transition');
  const through = Math.max(0, ...transitions.map((event) => event.lastSequence));
  const seen = new Set<string>();
  const records: Observation[] = events.flatMap((event) => event.t === 'dom.observed'
    ? event.batch.observations.map((record, index) => ({ ...record, sessionSequence: event.batch.firstSequence + index })) : [])
    .filter((record) => {
      const key = `${record.documentId}:${record.sequence}`;
      if (seen.has(key) || record.sessionSequence > through) return false;
      seen.add(key); return true;
    }).sort((a, b) => a.sessionSequence - b.sessionSequence);
  const elements = new Map(states.flatMap((state) => state.dom.flatMap((frame) => frame.elements)).map((element) => [element.id, element]));
  const candidates: Candidate[] = [];
  const byCause = new Map<string, Candidate>();
  const editing = new Map<string, Candidate>();
  const lastAction = new Map<string, Candidate>();
  const create = (record: Observation, title: string, category: string): Candidate => {
    const candidate: Candidate = { id: `${record.documentId}:${record.sequence}`, kind: 'User', title, category, targetId: record.targetId, timestamp: record.timestamp, lifecycle: [], changes: [], stateIds: [], records: [] };
    candidates.push(candidate); return candidate;
  };
  for (const record of records) {
    if (record.type === 'pagehide') {
      for (const [key, field] of editing) if (field.records[0]?.documentId === record.documentId) editing.delete(key);
    }
    if (record.kind !== 'interaction' || record.detail.trusted === false) continue;
    const name = observationName(record, elements);
    const target = record.targetId ?? record.documentId;
    let candidate: Candidate | undefined;
    if (record.detail.editable === true && /^(focusin|focusout|input|change)$/.test(record.type)) {
      candidate = editing.get(target);
      if (candidate === undefined && record.type !== 'focusout') {
        candidate = create(record, `Focus ${name}`, 'field');
        editing.set(target, candidate);
      }
      if (candidate === undefined) continue;
      if (record.type === 'focusin' && !candidate.lifecycle.includes(`Focus ${name}`)) candidate.lifecycle.push(`Focus ${name}`);
      if (/^(input|change)$/.test(record.type) && typeof record.detail.value === 'string') {
        candidate.title = `Type ${name}`;
        candidate.value = record.detail.value;
        if (!candidate.lifecycle.includes(`Type ${name}`)) { candidate.lifecycle.push(`Type ${name}`); candidate.timestamp = record.timestamp; }
      }
      if (record.type === 'focusout') {
        if (candidate.value !== undefined && typeof record.detail.value === 'string') candidate.value = record.detail.value;
        candidate.lifecycle.push(`Unfocus ${name}`);
        editing.delete(target);
      }
    } else if (/^(click|dblclick|auxclick|contextmenu|input|change|keydown|pointerdown|pointerover|pointermove|pointerout|drop|scroll|wheel)$/.test(record.type)) {
      if (record.detail.editable === true && /^(click|pointerdown|keydown)$/.test(record.type)) continue;
      if (record.type === 'keydown' && !['Enter', 'Escape', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(String(record.detail.key))) continue;
      const hover = /^pointer(over|move|out)$/.test(record.type);
      const previous = lastAction.get(target);
      // Browser input/change pairs describe one selection, not two actions.
      if (/^(input|change)$/.test(record.type) && previous && timestamp(record.timestamp) - timestamp(previous.timestamp) < 100 && ['click', 'change'].includes(previous.category)) candidate = previous;
      else {
        const category = hover ? 'hover' : record.type === 'input' ? 'change' : record.type;
        const verb = hover ? (record.type === 'pointerout' ? 'Leave' : 'Hover') : ({ click: 'Click', dblclick: 'Double-click', auxclick: 'Click', contextmenu: 'Right-click', change: 'Select', input: 'Select', pointerdown: 'Press', drop: 'Drop on', scroll: 'Scroll', wheel: 'Scroll', keydown: `Press ${String(record.detail.key)} on` } as Record<string, string>)[record.type];
        candidate = create(record, `${verb} ${name}`, category);
        lastAction.set(target, candidate);
      }
      if (/^(input|change)$/.test(record.type) && typeof record.detail.value === 'string') candidate.value = record.detail.value;
    }
    if (candidate) {
      candidate.records.push(record);
      if (record.causeId) byCause.set(record.causeId, candidate);
    }
  }

  const output: TimelineStep[] = [];
  const emitted = new Set<string>();
  let cursor = 0;
  let lastCaptured: TimelineState | undefined;
  const confirm = (candidate: Candidate, stateId: string, changes: string[] = []): void => {
    if (!candidate.stateIds.includes(stateId)) candidate.stateIds.push(stateId);
    candidate.changes = [...new Set([...candidate.changes, ...changes])];
    if (!emitted.has(candidate.id)) { emitted.add(candidate.id); output.push(candidate); }
  };
  for (const transition of transitions) {
    const current = stateMap.get(transition.toStateId);
    if (!current || current.dom.length === 0) continue; // Wait for artifact hydration.
    const parent = transition.fromStateId === null ? undefined : stateMap.get(transition.fromStateId);
    const previous = parent && parent.dom.length > 0 ? parent : lastCaptured;
    lastCaptured = current;
    const time = transition.timestamp ?? records.find((record) => record.sessionSequence >= transition.firstSequence)?.timestamp ?? records[0]?.timestamp ?? '';
    if (output.length === 0 && !previous) {
      output.push({ id: `initial:${current.stateId}`, kind: 'System', title: 'Initial page state', timestamp: time, lifecycle: [], changes: [], stateIds: [current.stateId] });
      cursor = Math.max(cursor, transition.lastSequence);
      continue;
    }
    const interval = records.filter((record) => record.sessionSequence > cursor && record.sessionSequence <= transition.lastSequence);
    cursor = Math.max(cursor, transition.lastSequence);
    if (transition.fromStateId === transition.toStateId) continue;
    const before = new Map((previous?.dom ?? []).flatMap((frame) => frame.elements).map((element) => [element.id, element]));
    const after = new Map(current.dom.flatMap((frame) => frame.elements).map((element) => [element.id, element]));
    const changed = new Set<string>();
    const focused = new Set<string>();
    for (const [id, element] of after) {
      const old = before.get(id);
      if (!old || signature(element) !== signature(old)) changed.add(id);
      if (old?.state.focused !== element.state.focused) focused.add(id);
    }
    for (const id of before.keys()) if (!after.has(id)) changed.add(id);
    const names = [...new Set([...changed].map((id) => elementName(after.get(id) ?? before.get(id)!)))].slice(0, 6);
    const local = candidates.filter((candidate) => candidate.records.some((record) => record.sessionSequence > (interval[0]?.sessionSequence ?? cursor + 1) - 1 && record.sessionSequence <= transition.lastSequence));
    const confirmed = new Set<Candidate>();
    const causes = new Set<Candidate>();
    const fieldEffects = new Map<Candidate, Set<string>>();
    for (const record of interval) {
      if (record.kind !== 'mutation' && record.kind !== 'property') continue;
      const candidate = record.causeId ? byCause.get(record.causeId) : undefined;
      if (candidate && changed.size > 0 && (candidate.category !== 'field' || (candidate.targetId !== null && after.has(candidate.targetId)))) {
        causes.add(candidate);
        if (candidate.category === 'field' && record.targetId && record.targetId !== candidate.targetId) {
          const effect = after.get(record.targetId) ?? before.get(record.targetId);
          if (effect) {
            const labels = fieldEffects.get(candidate) ?? new Set<string>();
            labels.add(elementName(effect)); fieldEffects.set(candidate, labels);
          }
        }
      }
    }
    for (const candidate of local) {
      if (candidate.category === 'field' && candidate.targetId && after.has(candidate.targetId) && (changed.has(candidate.targetId) || focused.has(candidate.targetId))) confirmed.add(candidate);
      if (candidate.targetId && ['click', 'change', 'keydown'].includes(candidate.category)) {
        const oldControl = before.get(candidate.targetId);
        const control = after.get(candidate.targetId);
        // Native selections and checkbox toggles change DOM properties without
        // emitting attribute MutationRecords or invoking patched JS setters.
        if (oldControl && control && ['value', 'checked', 'selected', 'selectedIndex', 'open'].some((property) =>
          oldControl.state[property] !== control.state[property]
          && candidate.records.some((record) => record.detail[property] === control.state[property]),
        )) confirmed.add(candidate);
      }
      if (causes.has(candidate)) confirmed.add(candidate);
    }
    for (const candidate of causes) confirmed.add(candidate);
    const previousUrl = previous?.dom.find((frame) => frame.frame === 'main')?.url ?? previous?.url;
    const currentUrl = current.dom.find((frame) => frame.frame === 'main')?.url ?? current.url;
    const navigated = previousUrl !== undefined && previousUrl !== currentUrl;
    if (navigated) {
      // Full-document navigation can destroy the event target before the next scan.
      const opener = [...candidates].reverse().find((candidate) => ['click', 'keydown'].includes(candidate.category)
        && candidate.records[0]!.sessionSequence <= transition.lastSequence
        && timestamp(time) - timestamp(candidate.timestamp) >= 0 && timestamp(time) - timestamp(candidate.timestamp) < 5000);
      if (opener) confirmed.add(opener);
    }
    // CSS hover changes may have no MutationRecord, but must change the captured DOM.
    if (changed.size > 0 && confirmed.size === 0 && !interval.some((record) => record.kind === 'mutation' || record.kind === 'property')) {
      const hover = [...local].reverse().find((candidate) => ['hover', 'scroll', 'wheel'].includes(candidate.category));
      if (hover) confirmed.add(hover);
    }
    for (const candidate of [...confirmed].sort((a, b) => a.records[0]!.sessionSequence - b.records[0]!.sessionSequence)) {
      // A click supersedes its keyboard/pointer precursor when both have effects.
      if (['pointerdown', 'keydown'].includes(candidate.category) && [...confirmed].some((other) => other.category === 'click' && other.targetId === candidate.targetId)) continue;
      confirm(candidate, current.stateId, candidate.category === 'field' ? [...(fieldEffects.get(candidate) ?? [])] : names);
    }
    const independentChange = interval.some((record) => (record.kind === 'mutation' || record.kind === 'property')
      && (!record.causeId || !byCause.has(record.causeId)) && record.targetId !== null && changed.has(record.targetId)
      && ![...confirmed].some((candidate) => candidate.targetId === record.targetId));
    if (navigated || (changed.size > 0 && (confirmed.size === 0 || independentChange))) {
      output.push({ id: `system:${transition.lastSequence}:${current.stateId}`, kind: 'System', title: navigated ? `Navigate to ${currentUrl}` : 'Page updated', timestamp: time, lifecycle: [], changes: names, stateIds: [current.stateId] });
    }
  }
  return output;
}
