import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type CDPSession, chromium, type Page } from 'playwright';

import type { Action, StateArtifact } from '@nexus/schema';

import {
  BOOTSTRAP_SOURCE,
  CdpDriver,
  type CdpEventHandler,
  type CdpTransport,
  fromPlaywrightPage,
  scanState,
} from '../src/index.js';

/**
 * Playwright can hand out a raw CDP session against the page it drives, which
 * lets the CDP driver be exercised by the normal suite. Without this the only
 * way to run it would be to launch Electron, and the two drivers would be free
 * to drift apart between manual checks.
 */
const FORWARDED_EVENTS = [
  'Runtime.executionContextCreated',
  'Runtime.executionContextsCleared',
  'Page.frameNavigated',
  'Page.frameDetached',
  'Target.attachedToTarget',
] as const;

class PlaywrightCdpTransport implements CdpTransport {
  readonly #session: CDPSession;
  readonly #handlers = new Set<CdpEventHandler>();

  constructor(session: CDPSession) {
    this.#session = session;
    for (const event of FORWARDED_EVENTS) {
      this.#session.on(event as never, (params: unknown) => {
        for (const handler of this.#handlers) {
          handler(event, (params ?? {}) as Record<string, unknown>, undefined);
        }
      });
    }
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.#session.send(method as never, params as never)) as T;
  }

  on(handler: CdpEventHandler): void { this.#handlers.add(handler); }
  off(handler: CdpEventHandler): void { this.#handlers.delete(handler); }
}

let server: Server;
let browser: Browser;
let baseUrl: string;

async function serve(file: string): Promise<void> {
  const body = await readFile(new URL(`../../../fixtures/${file}`, import.meta.url));
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    void (async () => {
      const path = (request.url ?? '/').replace(/^\//u, '');
      if (path === '' || path === 'index.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
        return;
      }
      try {
        const nested = await readFile(new URL(`../../../fixtures/${path}`, import.meta.url));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(nested);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
}

/** Identity fields only: ids are positional and say nothing about behaviour. */
function comparable(artifact: StateArtifact): {
  stateId: string;
  url: string;
  title: string;
  actions: Array<Pick<Action, 'stableId' | 'label' | 'type' | 'kind' | 'frame' | 'visible'>>;
  observables: string[];
  groups: string[];
} {
  return {
    stateId: artifact.stateId,
    url: artifact.url,
    title: artifact.title,
    actions: artifact.actions
      .map(({ stableId, label, type, kind, frame, visible }) => ({
        stableId, label, type, kind, frame, visible,
      }))
      .sort((left, right) => left.stableId.localeCompare(right.stableId)),
    observables: artifact.observables.map(({ stableId }) => stableId).sort(),
    groups: artifact.groups.map(({ label, kind }) => `${kind}:${label}`).sort(),
  };
}

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function extractBothWays(fixture: string): Promise<{
  playwright: StateArtifact;
  cdp: StateArtifact;
}> {
  await serve(fixture);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page: Page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    const cdpDriver = new CdpDriver(new PlaywrightCdpTransport(session));
    await cdpDriver.attach();

    // Closed roots created by application startup are observable only when the
    // CDP driver wins the document-start race, which is how Electron uses it.
    await cdpDriver.addInitScript(BOOTSTRAP_SOURCE);

    // Both drivers install the same instrumentation; scanState does it itself.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const viaCdp = await scanState(cdpDriver);
    const viaPlaywright = await scanState(fromPlaywrightPage(page));
    return { playwright: viaPlaywright, cdp: viaCdp };
  } finally {
    await context.close();
  }
}

describe('driver parity', () => {
  it('produces the same inventory through Playwright and CDP', async () => {
    const { playwright, cdp } = await extractBothWays('react-delegated.html');
    expect(cdp.actions.length).toBeGreaterThan(0);
    expect(comparable(cdp)).toEqual(comparable(playwright));
    // The identity fingerprint must match, or the two shells would report the
    // same page as two different states.
    expect(cdp.stateId).toBe(playwright.stateId);
  }, 120_000);

  it('agrees on shadow DOM and delegated listeners', async () => {
    const { playwright, cdp } = await extractBothWays('shadow-nested.html');
    expect(comparable(cdp)).toEqual(comparable(playwright));
    for (const artifact of [cdp, playwright]) {
      expect(artifact.actions.find(({ label }) => label === 'Closed shadow action'))
        .toMatchObject({ shadowPath: ['#outer-host', '#inner-host'] });
    }
  }, 120_000);

  it('agrees on collections and observable values', async () => {
    const { playwright, cdp } = await extractBothWays('observables.html');
    expect(comparable(cdp)).toEqual(comparable(playwright));
    expect(cdp.observables.map((item) => item.currentValue))
      .toEqual(playwright.observables.map((item) => item.currentValue));
  }, 120_000);
});
