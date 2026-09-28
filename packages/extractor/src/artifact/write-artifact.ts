import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { StateArtifact } from '@nexus/schema';

export interface ArtifactBundlePaths {
  manifest: string;
  state: string;
  warnings: string;
}

interface ManifestState {
  stateId: string;
  url: string;
  routeTemplate: string;
  title: string;
  path: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  baseUrl: string;
  personas: string[];
  states: ManifestState[];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }

  return value;
}

export function serializeArtifact(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

async function writeFileAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readManifest(path: string): Promise<ArtifactManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<ArtifactManifest>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.baseUrl !== 'string' ||
      !Array.isArray(value.personas) ||
      !Array.isArray(value.states)
    ) {
      throw new Error(`Invalid Nexus manifest: ${path}`);
    }
    return value as ArtifactManifest;
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeStateArtifact(
  outputDirectory: string,
  artifact: StateArtifact,
): Promise<string> {
  const statePath = join(outputDirectory, 'states', `${artifact.stateId}.json`);
  await writeFileAtomically(statePath, serializeArtifact(artifact));
  return statePath;
}

export async function writeArtifactBundle(
  outputDirectory: string,
  artifact: StateArtifact,
): Promise<ArtifactBundlePaths> {
  const state = await writeStateArtifact(outputDirectory, artifact);
  const manifest = join(outputDirectory, 'manifest.json');
  const warnings = join(outputDirectory, 'warnings.json');
  const existingManifest = await readManifest(manifest);

  let baseUrl = artifact.url;
  try {
    const parsed = new URL(artifact.url);
    baseUrl = parsed.origin === 'null' ? parsed.href : parsed.origin;
  } catch {
    // The artifact retains the original value if it is not URL-shaped.
  }

  const nextState: ManifestState = {
    stateId: artifact.stateId,
    url: artifact.url,
    routeTemplate: artifact.routeTemplate,
    title: artifact.title,
    path: `states/${artifact.stateId}.json`,
  };
  const statesById = new Map(
    (existingManifest?.states ?? []).map((entry) => [entry.stateId, entry]),
  );
  statesById.set(nextState.stateId, nextState);

  const nextManifest: ArtifactManifest = {
    schemaVersion: 1,
    baseUrl: existingManifest?.baseUrl ?? baseUrl,
    personas: [...new Set([...(existingManifest?.personas ?? []), artifact.personaId])].sort(),
    states: [...statesById.values()].sort((left, right) =>
      left.stateId < right.stateId ? -1 : left.stateId > right.stateId ? 1 : 0,
    ),
  };

  await Promise.all([
    mkdir(join(outputDirectory, 'transitions'), { recursive: true }),
    writeFileAtomically(manifest, serializeArtifact(nextManifest)),
    writeFileAtomically(warnings, serializeArtifact(artifact.warnings)),
  ]);

  return { manifest, state, warnings };
}
