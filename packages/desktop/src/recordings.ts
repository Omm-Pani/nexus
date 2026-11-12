import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PageNames, writeStateArtifact } from '@nexus/extractor';
import type { StateArtifact } from '@nexus/schema';

export interface Recording {
  id: string; name: string; url: string; createdAt: string; stoppedAt: string | null;
  status: 'recording' | 'stopped' | 'interrupted';
}

export class Recordings {
  readonly #pageNames = new Map<string, PageNames>();
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  directory(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid recording ID.');
    return join(this.root, id);
  }
  #name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('Recording names must contain 1–120 characters.');
    return value.trim();
  }
  async #write(recording: Recording): Promise<void> {
    const directory = this.directory(recording.id);
    await mkdir(directory, { recursive: true });
    const target = join(directory, 'recording.json');
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(recording, null, 2) + '\n');
    await rename(temporary, target);
  }
  async get(id: unknown): Promise<Recording> {
    const record = JSON.parse(await readFile(join(this.directory(id), 'recording.json'), 'utf8')) as Recording;
    if (record.id !== id) throw new Error('Invalid recording metadata.');
    return record;
  }
  async create(id: string, name: unknown, url: string): Promise<Recording> {
    const recording: Recording = { id, name: this.#name(name), url, createdAt: new Date().toISOString(), stoppedAt: null, status: 'recording' };
    await this.#write(recording);
    return recording;
  }
  async list(activeId: string | null): Promise<Recording[]> {
    await this.#queue.catch(() => undefined);
    await mkdir(this.root, { recursive: true });
    const result: Recording[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const record = await this.get(entry.name);
        result.push(record.status === 'recording' && record.id !== activeId ? { ...record, status: 'interrupted' } : record);
      } catch { /* Older sessions have no recording metadata. */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  rename(id: unknown, name: unknown): Promise<Recording> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const recording = { ...await this.get(id), name: this.#name(name) };
      await this.#write(recording);
      return recording;
    });
    this.#queue = operation;
    return operation;
  }
  finish(id: string, artifacts: StateArtifact[]): Promise<Recording> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      // Re-save in-memory captures strictly: a recording must not report saved after a disk failure.
      for (const artifact of artifacts) await writeStateArtifact(this.directory(id), artifact);
      const recording: Recording = { ...await this.get(id), status: 'stopped', stoppedAt: new Date().toISOString() };
      await this.#write(recording);
      return recording;
    });
    this.#queue = operation;
    return operation;
  }
  async read(id: unknown): Promise<{ recording: Recording; artifacts: StateArtifact[] }> {
    await this.#queue.catch(() => undefined);
    const recording = await this.get(id);
    const directory = join(this.directory(id), 'states');
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; files = []; }
    const artifacts: StateArtifact[] = [];
    for (const file of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      artifacts.push(JSON.parse(await readFile(join(directory, file), 'utf8')) as StateArtifact);
    }
    artifacts.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return { recording, artifacts };
  }
  async pageNames(id: unknown): Promise<PageNames> {
    await this.get(id);
    const directory = this.directory(id);
    let names = this.#pageNames.get(directory);
    if (!names) { names = new PageNames(directory); this.#pageNames.set(directory, names); }
    return names;
  }
}
