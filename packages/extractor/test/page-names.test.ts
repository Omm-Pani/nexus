import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PageNames } from '../src/artifact/page-names.js';

it('persists exact-URL overrides, serializes edits, and restores automatic names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-page-names-'));
  try {
    const store = new PageNames(directory);
    expect(await store.get()).toEqual({});
    const first = 'https://example.test/cart?sort=a&filter=b';
    const second = 'https://example.test/cart?filter=b&sort=a';
    await Promise.all([store.set(first, '  My cart  '), store.set(second, 'Other cart')]);
    expect(await new PageNames(directory).get()).toEqual({ [first]: 'My cart', [second]: 'Other cart' });
    await expect(store.set(first, '   ')).rejects.toThrow('1–120');
    await expect(store.set(first, 'x'.repeat(121))).rejects.toThrow('1–120');
    await expect(store.set('bad URL', 'Name')).rejects.toThrow('valid page URL');
    await store.set(first, null);
    expect(JSON.parse(await readFile(join(directory, 'page-names.json'), 'utf8'))).toEqual({ [second]: 'Other cart' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
