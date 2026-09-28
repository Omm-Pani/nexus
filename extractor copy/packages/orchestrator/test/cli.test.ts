import type { StateArtifact } from '@nexus/schema';
import type { Browser, BrowserContext, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import { parseCliArgs, runCli } from '../src/cli.js';

const emptyArtifact: StateArtifact = {
  schemaVersion: 1,
  stateId: 'a'.repeat(64),
  url: 'https://example.test/',
  routeTemplate: '/',
  title: 'Example',
  personaId: 'anonymous',
  buildId: 'phase-1',
  capturedAt: '2026-01-01T00:00:00.000Z',
  timings: { total: 0 },
  groups: [],
  actions: [],
  observables: [],
  collections: [],
  warnings: [],
};

function fakeLifecycle() {
  const page = {
    addInitScript: vi.fn(async () => undefined),
    frames: () => [],
    goto: vi.fn(async () => null),
  } as unknown as Page;
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  } as unknown as BrowserContext;
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;

  return { browser, context, page };
}

describe('nexus CLI arguments', () => {
  it('parses the Phase 1 extract command', () => {
    expect(
      parseCliArgs(
        ['extract', 'https://example.test/products', '--out', './artifacts'],
        '/workspace',
      ),
    ).toEqual({
      command: 'extract',
      url: 'https://example.test/products',
      outputDirectory: '/workspace/artifacts',
    });
  });

  it('fails closed for unsupported protocols and unknown options', () => {
    expect(() => parseCliArgs(['extract', 'javascript:alert(1)'])).toThrow(
      'Unsupported URL protocol',
    );
    expect(() =>
      parseCliArgs(['extract', 'https://example.test/', '--retry']),
    ).toThrow('Unknown argument');
  });

  it('allocates one browser, context, and page and writes through the extractor boundary', async () => {
    const lifecycle = fakeLifecycle();
    const launchBrowser = vi.fn(async () => lifecycle.browser);
    const scan = vi.fn(async () => emptyArtifact);
    const writeBundle = vi.fn(async () => ({
      manifest: '/tmp/nexus/manifest.json',
      state: '/tmp/nexus/states/state.json',
      warnings: '/tmp/nexus/warnings.json',
    }));
    const output: string[] = [];

    await expect(
      runCli(['extract', 'https://example.test/', '--out', '/tmp/nexus'], {
        launchBrowser,
        scan,
        writeBundle,
        stdout: (message) => output.push(message),
      }),
    ).resolves.toBe(0);

    expect(launchBrowser).toHaveBeenCalledTimes(1);
    expect(lifecycle.browser.newContext).toHaveBeenCalledTimes(1);
    expect(lifecycle.context.newPage).toHaveBeenCalledTimes(1);
    expect(lifecycle.page.goto).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(lifecycle.page);
    expect(writeBundle).toHaveBeenCalledTimes(1);
    expect(writeBundle).toHaveBeenCalledWith('/tmp/nexus', emptyArtifact);
    expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.browser.close).toHaveBeenCalledTimes(1);
    expect(output.join('\n')).toContain('/tmp/nexus/states/state.json');
  });

  it('closes the existing context and browser when capture fails', async () => {
    const lifecycle = fakeLifecycle();
    const captureError = new Error('fixture capture failed');

    await expect(
      runCli(['extract', 'https://example.test/'], {
        launchBrowser: async () => lifecycle.browser,
        scan: async () => {
          throw captureError;
        },
      }),
    ).rejects.toBe(captureError);

    expect(lifecycle.browser.newContext).toHaveBeenCalledTimes(1);
    expect(lifecycle.context.newPage).toHaveBeenCalledTimes(1);
    expect(lifecycle.context.close).toHaveBeenCalledTimes(1);
    expect(lifecycle.browser.close).toHaveBeenCalledTimes(1);
  });
});
