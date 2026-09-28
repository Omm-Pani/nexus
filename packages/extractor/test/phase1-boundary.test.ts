import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { scanState, writeArtifactBundle } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Phase 1 extractor boundary', () => {
  it('returns and atomically writes a schema-valid empty artifact', async () => {
    const page = {
      url: () => 'https://example.test/products/42?sessionId=volatile',
      title: async () => 'Example products',
    } as unknown as Page;

    const artifact = await scanState(page, {
      personaId: 'fixture-user',
      buildId: 'test-build',
    });

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      url: 'https://example.test/products/42?sessionId=volatile',
      routeTemplate: '/products/42',
      title: 'Example products',
      personaId: 'fixture-user',
      buildId: 'test-build',
      groups: [],
      actions: [],
      observables: [],
      collections: [],
      warnings: [],
    });
    expect(artifact.stateId).toMatch(/^[a-f0-9]{64}$/u);

    const outputDirectory = await mkdtemp(join(tmpdir(), 'nexus-phase-1-'));
    temporaryDirectories.push(outputDirectory);
    const paths = await writeArtifactBundle(outputDirectory, artifact);

    const persisted = JSON.parse(await readFile(paths.state, 'utf8')) as unknown;
    expect(persisted).toEqual(artifact);
    expect(JSON.parse(await readFile(paths.warnings, 'utf8'))).toEqual([]);
    expect(await readdir(join(outputDirectory, 'transitions'))).toEqual([]);

    const stateEntries = await readdir(join(outputDirectory, 'states'));
    expect(stateEntries).toEqual([`${artifact.stateId}.json`]);
    expect(stateEntries.some((name) => name.endsWith('.tmp'))).toBe(false);

    const firstStateBytes = await readFile(paths.state, 'utf8');
    await writeArtifactBundle(outputDirectory, artifact);
    expect(await readFile(paths.state, 'utf8')).toBe(firstStateBytes);

    const secondArtifact = {
      ...artifact,
      stateId: 'b'.repeat(64),
      url: 'https://example.test/settings',
      routeTemplate: '/settings',
      title: 'Settings',
    };
    await writeArtifactBundle(outputDirectory, secondArtifact);
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as {
      states: Array<{ stateId: string }>;
    };
    expect(manifest.states.map(({ stateId }) => stateId)).toEqual([
      artifact.stateId,
      secondArtifact.stateId,
    ].sort());
  });
});
