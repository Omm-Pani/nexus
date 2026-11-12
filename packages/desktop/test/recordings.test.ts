import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Recordings } from '../src/recordings.js';

it('persists names and terminal state, reports interrupted runs, and rejects unsafe IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-recordings-'));
  try {
    const store = new Recordings(directory);
    const id = randomUUID();
    await expect(store.create(id, ' ', 'https://example.test')).rejects.toThrow('1–120');
    await store.create(id, ' Cart ', 'https://example.test');
    expect((await store.list(id))[0]?.status).toBe('recording');
    expect((await new Recordings(directory).list(null))[0]?.status).toBe('interrupted');
    await Promise.all([store.rename(id, 'Checkout'), store.finish(id, [])]);
    const saved = await new Recordings(directory).read(id);
    expect(saved.recording.name).toBe('Checkout');
    expect(saved.recording.status).toBe('stopped');
    expect(saved.artifacts).toEqual([]);
    await expect(store.read('../outside')).rejects.toThrow('Invalid recording ID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
