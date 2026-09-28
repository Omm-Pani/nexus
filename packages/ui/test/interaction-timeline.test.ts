import { expect, it } from 'vitest';
import type { DomElement, DomObservation } from '@nexus/schema';
import { buildInteractionTimeline, type ActivityEvent, type TimelineState } from '../src/interaction-timeline.js';

const time = (second: number) => new Date(1_700_000_000_000 + second * 1000).toISOString();
const element = (id: string, value = '', focused = false): DomElement => ({ id, documentId: 'doc', frame: 'main', parentId: null, depth: 0, boundary: 'light', shadowPath: [], tag: 'input', namespace: '', selector: `#${id}`, attributes: { 'aria-label': id }, text: '', state: { value, focused }, visible: true, rect: { x: 0, y: 0, w: 100, h: 20 }, eventTypes: [] });
const state = (id: string, elements: DomElement[], url = 'https://example.test/login'): TimelineState => ({ stateId: id, url, dom: [{ documentId: 'doc', frame: 'main', url, sequence: 0, elements }] });
const batch = (...observations: DomObservation[]): ActivityEvent => ({ t: 'dom.observed', batch: { firstSequence: observations[0]!.sequence, lastSequence: observations.at(-1)!.sequence, fromStateId: null, observations } });
const event = (sequence: number, type: string, targetId: string, detail: DomObservation['detail'] = {}): DomObservation => ({ documentId: 'doc', sequence, timestamp: time(sequence), url: 'https://example.test/login', kind: 'interaction', type, targetId, causeId: `action${sequence}`, detail: { trusted: true, label: targetId, ...detail } });
const transition = (fromStateId: string | null, toStateId: string, firstSequence: number, lastSequence: number): ActivityEvent => ({ t: 'state.transition', fromStateId, toStateId, firstSequence, lastSequence, trigger: 'DOM activity', timestamp: time(lastSequence) });

it('groups complete field entries across captures, punctuation, spaces, and blur without masking', () => {
  const states = [state('a', [element('Username'), element('Password')]), state('b', [element('Username', 'standard_', true), element('Password')]), state('c', [element('Username', 'standard_user name', true), element('Password')]), state('d', [element('Username', 'standard_user name'), element('Password', 'secret_sauce x', true)]), state('e', [element('Username', 'standard_user name'), element('Password', 'secret_sauce x')])];
  const events: ActivityEvent[] = [transition(null, 'a', 1, 0), batch(event(1, 'focusin', 'Username', { editable: true, value: '' }), event(2, 'input', 'Username', { editable: true, value: 'standard_' })), transition('a', 'b', 1, 2), batch(event(3, 'input', 'Username', { editable: true, value: 'standard_user name' })), transition('b', 'c', 3, 3), batch(event(4, 'focusout', 'Username', { editable: true }), event(5, 'focusin', 'Password', { editable: true }), event(6, 'input', 'Password', { editable: true, value: 'secret_sauce x' })), transition('c', 'd', 4, 6), batch(event(7, 'focusout', 'Password', { editable: true })), transition('d', 'e', 7, 7)];
  const steps = buildInteractionTimeline(events, states);
  expect(steps.map((step) => step.title)).toEqual(['Initial page state', 'Type Username', 'Type Password']);
  expect(steps[1]).toMatchObject({ value: 'standard_user name', lifecycle: ['Focus Username', 'Type Username', 'Unfocus Username'], stateIds: ['b', 'c', 'd'] });
  expect(steps[2]).toMatchObject({ value: 'secret_sauce x', lifecycle: ['Focus Password', 'Type Password', 'Unfocus Password'], stateIds: ['d', 'e'] });
});

it('discards no-op clicks and pointer movement, including button-focus-only snapshots', () => {
  const states = [state('a', [element('Button')]), state('focus', [element('Button', '', true)])];
  const events = [transition(null, 'a', 1, 0), batch(event(1, 'pointermove', 'Button'), event(2, 'click', 'Button')), transition('a', 'focus', 1, 2), batch(event(3, 'click', 'Button')), transition('focus', 'focus', 3, 3)];
  expect(buildInteractionTimeline(events, states).map((step) => step.title)).toEqual(['Initial page state']);
});

it('attributes DOM effects to the responsible click or hover and leaves background changes as system steps', () => {
  const base = element('Menu');
  const states = [state('a', [base]), state('b', [{ ...base, attributes: { ...base.attributes, 'aria-expanded': 'true' } }]), state('c', [{ ...base, text: 'Tooltip' }]), state('d', [{ ...base, text: 'Background update' }])];
  const mutation = (sequence: number, causeId?: string): DomObservation => ({ ...event(sequence, 'attributes', 'Menu'), kind: 'mutation', ...(causeId ? { causeId } : { causeId: undefined }) } as DomObservation);
  const events: ActivityEvent[] = [transition(null, 'a', 1, 0), batch(event(1, 'click', 'Menu'), mutation(2, 'action1')), transition('a', 'b', 1, 2), batch(event(3, 'pointerover', 'Menu'), mutation(4, 'action3')), transition('b', 'c', 3, 4), batch(event(5, 'pointermove', 'Menu'), mutation(6)), transition('c', 'd', 5, 6)];
  expect(buildInteractionTimeline(events, states).map((step) => [step.title, step.kind])).toEqual([['Initial page state', 'System'], ['Click Menu', 'User'], ['Hover Menu', 'User'], ['Page updated', 'System']]);
});

it('keeps the click responsible for navigation even if an unchanged capture intervenes', () => {
  const states = [state('a', [element('Login')]), state('b', [element('Products')], 'https://example.test/inventory')];
  const events = [transition(null, 'a', 1, 0), batch(event(1, 'click', 'Login')), transition('a', 'a', 1, 1), transition('a', 'b', 2, 1)];
  const steps = buildInteractionTimeline(events, states);
  expect(steps.map((step) => step.title)).toEqual(['Initial page state', 'Click Login', 'Navigate to https://example.test/inventory']);
  expect(steps[1]?.stateIds).toEqual(['b']);
});

it('starts a new edit after refocusing and keeps identical labels in different frames separate', () => {
  const field = (id: string, value: string) => ({ ...element(id, value), attributes: { 'aria-label': 'Name' } });
  const states = [state('a', [field('main:name', ''), field('frame:name', '')]), state('b', [field('main:name', 'one'), field('frame:name', 'two')]), state('c', [field('main:name', 'three'), field('frame:name', 'two')])];
  const input = (seq: number, id: string, type: string, value: string) => event(seq, type, id, { label: 'Name', editable: true, value });
  const events = [transition(null, 'a', 1, 0), batch(input(1, 'main:name', 'input', 'one'), input(2, 'main:name', 'focusout', 'one'), input(3, 'frame:name', 'input', 'two')), transition('a', 'b', 1, 3), batch(input(4, 'main:name', 'input', 'three')), transition('b', 'c', 4, 4)];
  expect(buildInteractionTimeline(events, states).filter((step) => step.kind === 'User').map((step) => step.value)).toEqual(['one', 'two', 'three']);
});

it('keeps native checkbox and select actions even without mutation records', () => {
  const checkbox = { ...element('Remember'), state: { checked: false, focused: false } };
  const checked = { ...checkbox, state: { checked: true, focused: true } };
  const states = [state('a', [checkbox, element('Sort', 'name')]), state('b', [checked, element('Sort', 'name')]), state('c', [checked, element('Sort', 'price')])];
  const events = [transition(null, 'a', 1, 0), batch(event(1, 'click', 'Remember', { checked: true })), transition('a', 'b', 1, 1), batch(event(2, 'change', 'Sort', { value: 'price' })), transition('b', 'c', 2, 2)];
  expect(buildInteractionTimeline(events, states).map((step) => step.title)).toEqual(['Initial page state', 'Click Remember', 'Select Sort']);
});

it('links a typed password to its last field state when blur and navigation share a capture', () => {
  const states = [state('a', [element('Password')]), state('b', [element('Password', 'secret_sauce', true)]), state('c', [element('Products')], 'https://example.test/inventory')];
  const events = [transition(null, 'a', 1, 0), batch(event(1, 'input', 'Password', { editable: true, value: 'secret_sauce' })), transition('a', 'b', 1, 1), batch(event(2, 'focusout', 'Password', { editable: true, value: 'secret_sauce' }), event(3, 'click', 'Login')), transition('b', 'c', 2, 3)];
  const steps = buildInteractionTimeline(events, states);
  expect(steps.find((step) => step.title === 'Type Password')?.stateIds).toEqual(['b']);
  expect(steps.find((step) => step.title === 'Click Login')?.stateIds).toEqual(['c']);
});
