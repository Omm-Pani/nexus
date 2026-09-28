import { describe, expect, it } from 'vitest';

import {
  exactPageKey,
  groupStatesByExactUrl,
  pageContainsCurrentState,
} from '../src/page-history.js';

describe('exact page history', () => {
  it('keeps same-address states together without reordering query parameters', () => {
    const first = 'https://example.test/items?sort=name&filter=open';
    const reordered = 'https://example.test/items?filter=open&sort=name';
    const states = [
      { stateId: 'initial', url: first },
      { stateId: 'menu-open', url: first },
      { stateId: 'different-address', url: reordered },
    ];

    expect(exactPageKey(first)).toBe(first);
    expect(exactPageKey(reordered)).toBe(reordered);
    expect(groupStatesByExactUrl(states).map((page) => ({
      key: page.key,
      states: page.states.map(({ stateId }) => stateId),
    }))).toEqual([
      { key: first, states: ['initial', 'menu-open'] },
      { key: reordered, states: ['different-address'] },
    ]);
  });

  it('retains repeated query values, fragments, and first-seen page order', () => {
    const first = 'https://example.test/search?tag=b&tag=a#results';
    const second = 'https://example.test/search?tag=b&tag=a#details';
    expect(groupStatesByExactUrl([
      { stateId: 'a', url: first },
      { stateId: 'b', url: second },
      { stateId: 'c', url: first },
    ]).map((page) => [page.url, page.states.map(({ stateId }) => stateId)]))
      .toEqual([
        [first, ['a', 'c']],
        [second, ['b']],
      ]);
  });

  it('derives live-current expansion independently from historical selection', () => {
    const currentPage = ['state-a', 'state-b'];
    const historicalPage = ['state-old'];

    expect(pageContainsCurrentState(currentPage, 'state-b')).toBe(true);
    expect(pageContainsCurrentState(historicalPage, 'state-b')).toBe(false);
    // Selecting state-old is deliberately not an input: browsing history does
    // not transfer live-current ownership away from state-b.
    expect(pageContainsCurrentState(currentPage, 'state-b')).toBe(true);
  });
});
