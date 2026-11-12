import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from './write-artifact.js';

export class InvalidPageNameError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_page_name';
}

/** Session display metadata, independent of captured page identities. */
export class PageNames {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  async #read(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.directory, 'page-names.json'), 'utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some((name) => typeof name !== 'string')) throw new Error('Invalid page names metadata.');
      return value as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async get(): Promise<Record<string, string>> {
    await this.#queue.catch(() => undefined);
    return this.#read();
  }

  set(url: unknown, name: unknown): Promise<Record<string, string>> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      if (typeof url !== 'string' || (name !== null && typeof name !== 'string')) throw new InvalidPageNameError('A page URL and name are required.');
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new InvalidPageNameError('A valid page URL is required.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new InvalidPageNameError('An HTTP or HTTPS page URL is required.');
      const normalized = typeof name === 'string' ? name.trim() : null;
      if (normalized !== null && (normalized.length === 0 || normalized.length > 120)) throw new InvalidPageNameError('Page names must contain 1–120 characters.');
      const names = await this.#read();
      if (normalized === null) delete names[parsed.href];
      else names[parsed.href] = normalized;
      await writeFileAtomically(join(this.directory, 'page-names.json'), JSON.stringify(names, null, 2) + '\n');
      return names;
    });
    this.#queue = operation;
    return operation;
  }
}
