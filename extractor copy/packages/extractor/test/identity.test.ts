import { describe, expect, it } from 'vitest';

import { fingerprintState, normalizeRoute } from '../src/identity/index.js';

const baseFingerprint = {
  routeTemplate: 'https://shop.example.test/products/42?tab=details',
  overlayStack: [] as string[],
  primaryRegionShape: 'main:|form:|label:|input:|button:',
  actionVocabulary: ['Search', 'Add item 42'],
  personaId: 'anonymous',
};

describe('state identity', () => {
  it('keeps exact origin, record path, meaningful query, and hash in page identity', () => {
    expect(normalizeRoute('https://Example.test/users/847?sessionId=x&tab=billing&utm_source=mail#security'))
      .toBe('https://example.test/users/847?sessionId=x&tab=billing&utm_source=mail#security');
    expect(normalizeRoute('https://other.test/users/847?tab=billing#security'))
      .not.toBe(normalizeRoute('https://example.test/users/847?tab=billing#security'));
  });

  it('does not create a state for ordinary DOM churn or isolated action changes', () => {
    const first = fingerprintState(baseFingerprint);
    const changed = fingerprintState({
      ...baseFingerprint,
      primaryRegionShape: 'main:|form:|label:|input:|span:status|strong:|button:',
      actionVocabulary: ['Search', 'Add item 99', 'Error button', 'Dismiss'],
    });
    expect(changed).toBe(first);
    expect(fingerprintState({ ...baseFingerprint, actionVocabulary: ['Completely renamed action'] }))
      .toBe(first);
  });

  it('retains meaningful URL, overlay, and landmark states', () => {
    const first = fingerprintState(baseFingerprint);
    expect(fingerprintState({ ...baseFingerprint, routeTemplate: 'https://other.example.test/products/42?tab=details' })).not.toBe(first);
    expect(fingerprintState({ ...baseFingerprint, routeTemplate: 'https://shop.example.test/products/43?tab=details' })).not.toBe(first);
    expect(fingerprintState({ ...baseFingerprint, overlayStack: ['dialog:Confirm order'] })).not.toBe(first);
    expect(fingerprintState({ ...baseFingerprint, overlayStack: ['menu:Account'] })).not.toBe(first);
    expect(fingerprintState({ ...baseFingerprint, overlayStack: ['dialog:Delete order 123?'] }))
      .not.toBe(fingerprintState({ ...baseFingerprint, overlayStack: ['dialog:Delete order 456?'] }));
    expect(fingerprintState({ ...baseFingerprint, viewContext: ['form:Checkout'] }))
      .not.toBe(fingerprintState({ ...baseFingerprint, viewContext: ['form:Login'] }));
    expect(fingerprintState({ ...baseFingerprint, primaryRegionShape: `${baseFingerprint.primaryRegionShape}|nav:navigation` })).not.toBe(first);
  });

  it('does not collapse token-selected exact URLs', () => {
    expect(normalizeRoute('https://example.test/reset?token=first'))
      .not.toBe(normalizeRoute('https://example.test/reset?token=second'));
  });

  it('preserves query order and repeated-value order as exact page identity', () => {
    const first = normalizeRoute('https://Example.test/items?sort=name&filter=open&tag=b&tag=a#results');
    const reordered = normalizeRoute('https://example.test/items?filter=open&sort=name&tag=a&tag=b#results');

    expect(first).toBe('https://example.test/items?sort=name&filter=open&tag=b&tag=a#results');
    expect(reordered).toBe('https://example.test/items?filter=open&sort=name&tag=a&tag=b#results');
    expect(first).not.toBe(reordered);
    expect(fingerprintState({ ...baseFingerprint, routeTemplate: first }))
      .not.toBe(fingerprintState({ ...baseFingerprint, routeTemplate: reordered }));
  });
});
