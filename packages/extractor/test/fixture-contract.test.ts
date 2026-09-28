import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActionKind, ElementType, RiskLevel } from '@nexus/schema';
import { type Browser, type Frame, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface FixtureBase {
  id: string;
  expected: string;
}

type FixtureEntry =
  | (FixtureBase & { kind: 'static'; document: string })
  | (FixtureBase & {
      kind: 'live';
      url: string;
      setup: {
        credentials: { username: string; password: string };
        steps: string[];
        expected: string;
      };
    });

interface FixtureManifest {
  schemaVersion: number;
  fixtures: FixtureEntry[];
}

interface ExpectedControl {
  label: string;
  labelPattern?: string;
  type: ElementType;
  kind: ActionKind;
  risk: RiskLevel;
  selector: string;
  minimumMatches?: number;
  frame: string;
  shadowPath: string[];
}

interface ExpectedObservable {
  label: string;
  valuePattern?: string;
  kind: 'live_region' | 'value_display' | 'validation' | 'status' | 'count';
  valueType: 'currency' | 'number' | 'percent' | 'date' | 'text' | 'count';
  selector: string;
  minimumMatches?: number;
  initialValue?: string;
  after?: { action: string; value: string };
  frame: string;
}

interface ExpectedCollection {
  label: string;
  selector: string;
  instancesObserved: number;
  instancesDeclared: number;
  traversal: 'static' | 'paginated' | 'virtualized_scroll';
  shouldPromote: boolean;
  anchors: string[];
  itemActions: string[];
  itemObservables: string[];
}

interface ExpectedWarning {
  code:
    | 'truncated_walk'
    | 'shadow_root_unreachable'
    | 'low_stability_anchor'
    | 'ax_unavailable'
    | 'quiescence_timeout'
    | 'frame_inaccessible'
    | 'occluded'
    | 'collection_rejected';
  ref?: string;
}

interface FixtureOracle {
  schemaVersion: number;
  fixture: string;
  controls: ExpectedControl[];
  observables: ExpectedObservable[];
  collections: ExpectedCollection[];
  warnings: ExpectedWarning[];
  rejectedCollections?: Array<{ label: string; selector: string; reason: string }>;
}

const fixturesDirectory = fileURLToPath(
  new URL('../../../fixtures/', import.meta.url),
);

const elementTypes = new Set<ElementType>([
  'navigation',
  'button',
  'input',
  'toggle',
  'text',
  'container',
  'observable',
]);
const actionKinds = new Set<ActionKind>([
  'navigate',
  'input',
  'select',
  'toggle',
  'open',
  'close',
  'expand',
  'collapse',
  'switch_tab',
  'submit',
  'upload',
  'unknown',
]);
const risks = new Set<RiskLevel>([
  'safe',
  'reversible',
  'mutating',
  'destructive',
  'unknown',
]);
const observableKinds = new Set([
  'live_region',
  'value_display',
  'validation',
  'status',
  'count',
]);
const observableValueTypes = new Set([
  'currency',
  'number',
  'percent',
  'date',
  'text',
  'count',
]);
const traversals = new Set(['static', 'paginated', 'virtualized_scroll']);
const warningCodes = new Set([
  'truncated_walk',
  'shadow_root_unreachable',
  'low_stability_anchor',
  'ax_unavailable',
  'quiescence_timeout',
  'frame_inaccessible',
  'occluded',
  'collection_rejected',
  'unknown_collection_size',
]);

let browser: Browser;
let fixtureServer: Server;
let fixtureBaseUrl: string;

beforeAll(async () => {
  const fixturesRoot = resolve(fixturesDirectory);
  fixtureServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://fixture.test');
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    const requestedPath = resolve(fixturesRoot, relativePath);
    if (!requestedPath.startsWith(`${fixturesRoot}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const contents = await readFile(requestedPath);
      const contentType = extname(requestedPath) === '.json'
        ? 'application/json; charset=utf-8'
        : 'text/html; charset=utf-8';
      response.writeHead(200, { 'content-type': contentType }).end(contents);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    fixtureServer.once('error', rejectListening);
    fixtureServer.listen(0, () => resolveListening());
  });
  const address = fixtureServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP port.');
  }
  fixtureBaseUrl = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolveClosed, rejectClosed) => {
    fixtureServer.close((error) => {
      if (error === undefined) resolveClosed();
      else rejectClosed(error);
    });
  });
});

function scopeForFrame(page: Page, framePath: string): Page | Frame {
  if (framePath === 'main') return page;
  const frameName = framePath.includes('#same-origin')
    ? 'same-origin'
    : framePath.includes('#cross-origin')
      ? 'cross-origin'
      : null;
  if (frameName === null) {
    throw new Error(`Unknown fixture frame path: ${framePath}`);
  }
  const frame = page.frame({ name: frameName });
  if (frame === null) {
    throw new Error(`Fixture frame was not attached: ${framePath}`);
  }
  return frame;
}

async function accessibleNames(
  scope: Page | Frame,
  selector: string,
): Promise<string[]> {
  return scope.locator(selector).evaluateAll((elements) => {
    const normalize = (value: string | null | undefined) =>
      (value ?? '').replace(/\s+/gu, ' ').trim();

    return elements.map((element) => {
      const ariaLabel = normalize(element.getAttribute('aria-label'));
      if (ariaLabel !== '') return ariaLabel;

      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy !== null) {
        const resolved = normalize(
          labelledBy
            .split(/\s+/u)
            .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
            .join(' '),
        );
        if (resolved !== '') return resolved;
      }

      if ('labels' in element) {
        const labels = (element as HTMLInputElement).labels;
        const resolved = normalize(
          labels === null
            ? ''
            : Array.from(labels, (label) => label.textContent ?? '').join(' '),
        );
        if (resolved !== '') return resolved;
      }

      for (const attribute of ['alt', 'title', 'placeholder']) {
        const value = normalize(element.getAttribute(attribute));
        if (value !== '') return value;
      }

      return normalize(element.textContent);
    });
  });
}

async function readJson<T>(relativePath: string): Promise<T> {
  const contents = await readFile(
    new URL(relativePath, new URL('../../../fixtures/', import.meta.url)),
    'utf8',
  );
  return JSON.parse(contents) as T;
}

describe('hand-labelled fixture corpus', () => {
  it('contains the exact eight Phase 1 fixtures and valid expectation files', async () => {
    const manifest = await readJson<FixtureManifest>('manifest.json');
    const requiredFixtureIds = [
      'saucedemo',
      'react-delegated',
      'shadow-nested',
      'iframe-composed',
      'occlusion',
      'nav-vs-collection',
      'virtualized',
      'observables',
    ];

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fixtures.map(({ id }) => id)).toEqual(requiredFixtureIds);

    for (const fixture of manifest.fixtures) {
      const oracle = await readJson<FixtureOracle>(fixture.expected);
      expect(oracle.schemaVersion, fixture.id).toBe(1);
      expect(oracle.fixture, fixture.id).toBe(fixture.id);
      expect(Array.isArray(oracle.controls), fixture.id).toBe(true);
      expect(Array.isArray(oracle.observables), fixture.id).toBe(true);
      expect(Array.isArray(oracle.collections), fixture.id).toBe(true);
      expect(Array.isArray(oracle.warnings), fixture.id).toBe(true);

      for (const control of oracle.controls) {
        expect(control.label.length, `${fixture.id}: control label`).toBeGreaterThan(0);
        const controlLabelPattern = control.labelPattern;
        if (controlLabelPattern !== undefined) {
          expect(() => new RegExp(controlLabelPattern, 'u'), fixture.id).not.toThrow();
        }
        expect(elementTypes.has(control.type), `${fixture.id}: element type`).toBe(true);
        expect(actionKinds.has(control.kind), `${fixture.id}: action kind`).toBe(true);
        expect(risks.has(control.risk), `${fixture.id}: risk`).toBe(true);
        expect(control.selector.length, `${fixture.id}: control selector`).toBeGreaterThan(0);
        expect(control.minimumMatches ?? 1, fixture.id).toBeGreaterThan(0);
        expect(control.frame.length, `${fixture.id}: control frame`).toBeGreaterThan(0);
        expect(Array.isArray(control.shadowPath), `${fixture.id}: shadow path`).toBe(true);
      }

      for (const observable of oracle.observables) {
        expect(observable.label.length, `${fixture.id}: observable label`).toBeGreaterThan(0);
        expect(observable.selector.length, `${fixture.id}: observable selector`).toBeGreaterThan(0);
        expect(observable.frame.length, `${fixture.id}: observable frame`).toBeGreaterThan(0);
        expect(observableKinds.has(observable.kind), fixture.id).toBe(true);
        expect(observableValueTypes.has(observable.valueType), fixture.id).toBe(true);
        const observableValuePattern = observable.valuePattern;
        if (observableValuePattern !== undefined) {
          expect(() => new RegExp(observableValuePattern, 'u'), fixture.id).not.toThrow();
        }
        if (observable.after !== undefined) {
          expect(observable.after.action.length, fixture.id).toBeGreaterThan(0);
          expect(
            oracle.controls.some(
              (control) => control.label === observable.after?.action,
            ),
            `${fixture.id}: observable action reference`,
          ).toBe(true);
          expect(observable.after.value, fixture.id).not.toBe(observable.initialValue);
        }
      }

      for (const collection of oracle.collections) {
        expect(collection.label.length, `${fixture.id}: collection label`).toBeGreaterThan(0);
        expect(collection.selector.length, `${fixture.id}: collection selector`).toBeGreaterThan(0);
        expect(traversals.has(collection.traversal), fixture.id).toBe(true);
        expect(collection.shouldPromote, `${fixture.id}: promoted collection`).toBe(true);
        expect(collection.instancesObserved, fixture.id).toBeGreaterThanOrEqual(3);
        expect(collection.instancesDeclared, fixture.id).toBeGreaterThanOrEqual(
          collection.instancesObserved,
        );
        expect(collection.anchors.length, fixture.id).toBeLessThanOrEqual(
          collection.traversal === 'virtualized_scroll' ? 20 : collection.instancesObserved,
        );
      }

      for (const warning of oracle.warnings) {
        expect(warningCodes.has(warning.code), `${fixture.id}: warning code`).toBe(true);
      }

      if (fixture.kind === 'static') {
        expect(fixture.document, fixture.id).toBeTypeOf('string');
        await expect(
          readFile(`${fixturesDirectory}/${fixture.document}`, 'utf8'),
        ).resolves.toContain('<!doctype html>');
      } else {
        expect(fixture.url, fixture.id).toMatch(/^https:\/\//u);
        expect(fixture.setup.credentials.username, fixture.id).toBe('standard_user');
        expect(fixture.setup.credentials.password.length, fixture.id).toBeGreaterThan(0);
        expect(fixture.setup.expected, fixture.id).toContain('Cart badge');
      }
    }

    const collectionOracle = await readJson<FixtureOracle>(
      'expected/nav-vs-collection.json',
    );
    expect(collectionOracle.collections.map(({ label }) => label)).toEqual([
      'Product grid',
    ]);
    expect(collectionOracle.rejectedCollections).toEqual([
      expect.objectContaining({ label: 'Site navigation', reason: 'global_navigation' }),
    ]);
  });

  it('executes static fixtures and resolves every top-level matcher', async () => {
    const manifest = await readJson<FixtureManifest>('manifest.json');
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      for (const fixture of manifest.fixtures) {
        if (fixture.kind !== 'static') continue;
        const oracle = await readJson<FixtureOracle>(fixture.expected);
        await page.goto(new URL(fixture.document, fixtureBaseUrl).href, {
          waitUntil: 'load',
        });

        for (const expected of oracle.controls) {
          if (expected.shadowPath.length > 0) continue;
          const scope = scopeForFrame(page, expected.frame);
          const count = await scope.locator(expected.selector).count();
          expect(count, `${fixture.id}: ${expected.selector}`).toBeGreaterThanOrEqual(
            expected.minimumMatches ?? 1,
          );
          const names = await accessibleNames(scope, expected.selector);
          for (const name of names) {
            if (expected.labelPattern === undefined) {
              expect(name, `${fixture.id}: ${expected.selector} name`).toBe(
                expected.label,
              );
            } else {
              expect(name, `${fixture.id}: ${expected.selector} name`).toMatch(
                new RegExp(expected.labelPattern, 'u'),
              );
            }
          }
        }

        for (const expected of oracle.observables) {
          const scope = scopeForFrame(page, expected.frame);
          const locator = scope.locator(expected.selector);
          const count = await locator.count();
          expect(count, `${fixture.id}: ${expected.selector}`).toBeGreaterThanOrEqual(
            expected.minimumMatches ?? 1,
          );
          const values = (await locator.allTextContents()).map((value) =>
            value.replace(/\s+/gu, ' ').trim(),
          );
          if (expected.valuePattern !== undefined) {
            const valuePattern = new RegExp(expected.valuePattern, 'u');
            for (const value of values) {
              expect(value, `${fixture.id}: ${expected.selector} value`).toMatch(
                valuePattern,
              );
            }
          }
          if (expected.initialValue !== undefined) {
            expect(values, `${fixture.id}: ${expected.selector} initial value`).toContain(
              expected.initialValue,
            );
          }
        }

        for (const collection of oracle.collections) {
          await expect(page.locator(collection.selector).count()).resolves.toBeGreaterThanOrEqual(1);
        }
        for (const rejected of oracle.rejectedCollections ?? []) {
          await expect(page.locator(rejected.selector).count()).resolves.toBeGreaterThanOrEqual(1);
        }

        if (fixture.id === 'iframe-composed') {
          const mainOrigin = new URL(page.url()).origin;
          const sameOriginFrame = scopeForFrame(
            page,
            'main/iframe#same-origin',
          ) as Frame;
          const crossOriginFrame = scopeForFrame(
            page,
            'main/iframe#cross-origin',
          ) as Frame;
          expect(new URL(sameOriginFrame.url()).origin).toBe(mainOrigin);
          expect(new URL(crossOriginFrame.url()).origin).not.toBe(mainOrigin);
        }

        if (fixture.id === 'shadow-nested') {
          const roots = await page.locator('#outer-host').evaluate((host) => {
            const outerRoot = host.shadowRoot;
            const innerHost = outerRoot?.querySelector('#inner-host');
            return {
              outerOpen: outerRoot !== null,
              innerClosed: innerHost instanceof Element && innerHost.shadowRoot === null,
            };
          });
          expect(roots).toEqual({ outerOpen: true, innerClosed: true });
        }

        if (fixture.id === 'virtualized') {
          await page.locator('.edit-row').first().click();
          await expect(page.locator('#selected-row').textContent()).resolves.toBe('None');
          await page.locator('[role=row]').first().click({ position: { x: 8, y: 8 } });
          await expect(page.locator('#selected-row').textContent()).resolves.toBe('SKU-001');
        }
      }
    } finally {
      await context.close();
    }
  });

  it('labels and executes delegated controls without inline handlers', async () => {
    const document = await readFile(
      `${fixturesDirectory}/react-delegated.html`,
      'utf8',
    );
    const oracle = await readJson<FixtureOracle>('expected/react-delegated.json');

    expect(document).toContain("root.addEventListener('click'");
    expect(document).not.toMatch(/\sonclick\s*=/iu);
    expect(oracle.controls.map(({ label }) => label)).toEqual([
      'Increment count',
      'Reset count',
      'Download report',
    ]);
    expect(oracle.observables).toContainEqual(
      expect.objectContaining({ label: 'Count', initialValue: '0' }),
    );
    expect(oracle.collections).toEqual([]);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(
        new URL('react-delegated.html', fixtureBaseUrl).href,
      );
      expect(await page.locator('#increment').getAttribute('onclick')).toBeNull();
      await page.locator('#increment').click();
      await expect(page.locator('#delegated-count').textContent()).resolves.toBe('1');
      await expect(
        page.locator('#nested-icon-control > span > svg > path').count(),
      ).resolves.toBe(1);
    } finally {
      await context.close();
    }
  });
});
