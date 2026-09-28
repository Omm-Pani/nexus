import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ActionKind,
  ElementType,
  ExtractionPhase,
  RiskLevel,
  StateArtifact,
} from '@nexus/schema';
import { isActionElementId, parseElementId } from '@nexus/schema';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  installInstrumentation,
  type NexusQuiescence,
  type NexusSemanticSurface,
  type NexusSettledNotification,
  normalizeRoute,
  scanState,
} from '../src/index.js';

interface ExpectedControl {
  label: string;
  labelPattern?: string;
  type: ElementType;
  kind: ActionKind;
  risk: RiskLevel;
  minimumMatches?: number;
  frame: string;
  shadowPath: string[];
  expected?: {
    visible: boolean;
    inViewport: boolean;
    hitTestable: boolean;
    occludedBy: string | null;
  };
}

interface ExpectedObservable {
  label: string;
  kind: string;
  valueType: string;
  minimumMatches?: number;
  initialValue?: string;
  frame: string;
}

interface ExpectedCollection {
  label: string;
  instancesObserved: number;
  instancesDeclared: number;
  traversal: string;
  anchors: string[];
  itemActions: string[];
  itemObservables: string[];
}

interface FixtureOracle {
  controls: ExpectedControl[];
  observables: ExpectedObservable[];
  collections: ExpectedCollection[];
  warnings: Array<{ code: string; ref?: string }>;
}

const fixturesDirectory = fileURLToPath(
  new URL('../../../fixtures/', import.meta.url),
);
const staticFixtures = [
  'react-delegated',
  'shadow-nested',
  'iframe-composed',
  'occlusion',
  'nav-vs-collection',
  'virtualized',
  'observables',
];

let browser: Browser;
let server: Server;
let baseUrl: string;
const quietAfterTestWindowMs = 250;

beforeAll(async () => {
  const root = resolve(fixturesDirectory);
  server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://fixture.test');
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    if (relative === 'geometry-main.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Viewport geometry</title>
            <style>
              html, body { margin: 0; }
              #main-spacer { height: 820px; }
              #main-geometry { display: block; width: 180px; height: 44px; margin-left: 24px; }
              #same-geometry {
                display: block;
                width: 500px;
                height: 300px;
                margin: 24px 0 0 31px;
                border: 11px solid #234;
              }
              #tail { height: 900px; }
            </style>
          </head>
          <body>
            <div id="main-spacer"></div>
            <button id="main-geometry" type="button">Main viewport action</button>
            <iframe
              id="same-geometry"
              name="same-geometry"
              title="Same-origin geometry"
              src="/geometry-same.html"
            ></iframe>
            <div id="tail"></div>
          </body>
        </html>
      `);
      return;
    }
    if (relative === 'geometry-same.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Same-origin geometry frame</title>
            <style>
              html, body { margin: 0; }
              #same-spacer { height: 90px; }
              #same-action { display: block; width: 190px; height: 36px; margin-left: 19px; }
              #nested-gap { height: 105px; }
              #cross-geometry {
                display: block;
                width: 360px;
                height: 170px;
                margin-left: 27px;
                border: 9px solid #567;
              }
              #same-tail { height: 500px; }
            </style>
          </head>
          <body>
            <div id="same-spacer"></div>
            <button id="same-action" type="button">Same frame action</button>
            <div id="nested-gap"></div>
            <iframe
              id="cross-geometry"
              name="cross-geometry"
              title="Cross-origin geometry"
            ></iframe>
            <div id="same-tail"></div>
            <script>
              const crossUrl = new URL('/geometry-cross.html', location.href);
              crossUrl.hostname = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
              document.querySelector('#cross-geometry').src = crossUrl.href;
            </script>
          </body>
        </html>
      `);
      return;
    }
    if (relative === 'geometry-cross.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Cross-origin geometry frame</title>
            <style>
              html, body { margin: 0; }
              button, output { position: absolute; display: block; }
              #cross-action { left: 31px; top: 24px; width: 170px; height: 34px; }
              #nested-status { left: 35px; top: 76px; width: 150px; height: 24px; }
              #clipped-cross-action { left: 29px; top: 140px; width: 180px; height: 28px; }
            </style>
          </head>
          <body>
            <button id="cross-action" type="button">Cross frame action</button>
            <output id="nested-status" aria-label="Nested status">Ready 42</output>
            <button id="clipped-cross-action" type="button">Clipped cross action</button>
          </body>
        </html>
      `);
      return;
    }
    const path = resolve(root, relative);
    if (!path.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const body = await readFile(path);
      response.writeHead(200, {
        'content-type': extname(path) === '.json'
          ? 'application/json; charset=utf-8'
          : 'text/html; charset=utf-8',
      }).end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('error', rejectListening);
    server.listen(0, () => resolveListening());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port.');
  baseUrl = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolveClosed, rejectClosed) => {
    server.close((error) => error === undefined ? resolveClosed() : rejectClosed(error));
  });
});

async function oracle(id: string): Promise<FixtureOracle> {
  return JSON.parse(
    await readFile(resolve(fixturesDirectory, 'expected', `${id}.json`), 'utf8'),
  ) as FixtureOracle;
}

function expectLocalElementReferencesToResolve(artifact: StateArtifact): void {
  const actionIds = new Set(artifact.actions.map(({ id }) => id));
  const actionStableIds = new Set(artifact.actions.map(({ stableId }) => stableId));
  const observableIds = new Set(artifact.observables.map(({ id }) => id));
  const groupIds = new Set(artifact.groups.map(({ id }) => id));
  for (const group of artifact.groups) {
    expect(group.actions.every((id) => actionIds.has(id)), `${group.label}: actions`).toBe(true);
    expect(
      group.observables.every((id) => observableIds.has(id)),
      `${group.label}: observables`,
    ).toBe(true);
    if (group.parentAction !== undefined) expect(actionIds.has(group.parentAction)).toBe(true);
  }
  for (const action of artifact.actions) {
    if (action.parentAction !== undefined) expect(actionIds.has(action.parentAction)).toBe(true);
  }
  for (const observable of artifact.observables) {
    expect(observable.changedBy.every((stableId) => actionStableIds.has(stableId))).toBe(true);
  }
  for (const collection of artifact.collections) {
    expect(collection.id).toMatch(/^col[1-9]\d*$/u);
    if (collection.groupId !== undefined) {
      expect(groupIds.has(collection.groupId), `${collection.label}: groupId`).toBe(true);
      expect(artifact.groups.find(({ id }) => id === collection.groupId)?.kind).toBe('collection');
    }
    for (const row of collection.rows ?? []) {
      if (row.anchorActionId !== undefined) expect(actionIds.has(row.anchorActionId)).toBe(true);
      for (const cell of row.cells) {
        if (cell.actionId !== undefined) expect(actionIds.has(cell.actionId)).toBe(true);
        if (cell.observableId !== undefined) expect(observableIds.has(cell.observableId)).toBe(true);
      }
    }
  }
}

describe('real DOM extraction', () => {
  it('matches every hand-labelled static fixture', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      for (const fixture of staticFixtures) {
        const page = await context.newPage();
        await installInstrumentation(page);
        await page.goto(new URL(`${fixture}.html`, baseUrl).href, { waitUntil: 'load' });
        const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
        const expected = await oracle(fixture);

        for (const control of expected.controls) {
          const label = control.labelPattern === undefined
            ? (value: string) => value === control.label
            : (value: string) => new RegExp(control.labelPattern as string, 'u').test(value);
          const matches = artifact.actions.filter((action) =>
            label(action.label)
            && action.type === control.type
            && action.kind === control.kind
            && action.risk === control.risk
            && action.frame === control.frame
            && JSON.stringify(action.shadowPath) === JSON.stringify(control.shadowPath),
          );
          expect(matches.length, `${fixture}: ${control.label}`).toBeGreaterThanOrEqual(
            control.minimumMatches ?? 1,
          );
          for (const action of matches) {
            expect(action.locators.length, `${fixture}: locator`).toBeGreaterThan(0);
            expect(action.locators.every(({ frame }) => frame === control.frame)).toBe(true);
          }
          if (control.expected !== undefined) {
            expect(matches[0], `${fixture}: geometry for ${control.label}`).toMatchObject(
              control.expected,
            );
          }
        }

        for (const observable of expected.observables) {
          const matches = artifact.observables.filter((value) =>
            value.label === observable.label
            && value.kind === observable.kind
            && value.valueType === observable.valueType
            && value.frame === observable.frame,
          );
          expect(matches.length, `${fixture}: ${observable.label}`).toBeGreaterThanOrEqual(
            observable.minimumMatches ?? 1,
          );
          if (observable.initialValue !== undefined) {
            expect(matches.some(({ currentValue }) => currentValue === observable.initialValue)).toBe(true);
          }
        }

        for (const collection of expected.collections) {
          const extracted = artifact.collections.find(({ label }) => label === collection.label);
          expect(extracted, `${fixture}: ${collection.label}`).toMatchObject({
            instancesObserved: collection.instancesObserved,
            instancesDeclared: collection.instancesDeclared,
            traversal: collection.traversal,
          });
          expect(extracted?.anchors).toEqual(collection.anchors);
          expect(extracted?.itemActions.map(({ label }) => label)).toEqual(
            expect.arrayContaining(collection.itemActions),
          );
          expect(extracted?.itemObservables.map(({ label }) => label)).toEqual(
            expect.arrayContaining(collection.itemObservables),
          );
        }
        for (const expectedWarning of expected.warnings) {
          expect(artifact.warnings).toContainEqual(expect.objectContaining(expectedWarning));
        }
        expect(artifact.observables.every(({ id }) => /^obs[1-9]\d*$/u.test(id))).toBe(true);
        expectLocalElementReferencesToResolve(artifact);
        await page.close();
      }
    } finally {
      await context.close();
    }
  }, 20_000);

  it('composes scrolled and nested frame rectangles into the main viewport', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(new URL('geometry-main.html', baseUrl).href, { waitUntil: 'load' });
      const sameFrame = page.frame({ name: 'same-geometry' });
      const crossFrame = page.frame({ name: 'cross-geometry' });
      if (sameFrame === null || crossFrame === null) {
        throw new Error('Geometry fixture frames did not attach.');
      }
      expect(new URL(sameFrame.url()).origin).toBe(new URL(page.url()).origin);
      expect(new URL(crossFrame.url()).origin).not.toBe(new URL(page.url()).origin);

      await page.evaluate(() => window.scrollTo(0, 760));
      await sameFrame.evaluate(() => window.scrollTo(0, 55));
      await page.evaluate(() => new Promise<void>((resolveFrame) => {
        requestAnimationFrame(() => resolveFrame());
      }));

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const actionCases = [
        {
          label: 'Main viewport action',
          locator: page.locator('#main-geometry'),
          frame: 'main',
          inViewport: true,
        },
        {
          label: 'Same frame action',
          locator: sameFrame.locator('#same-action'),
          frame: 'main/iframe#same-geometry',
          inViewport: true,
        },
        {
          label: 'Cross frame action',
          locator: crossFrame.locator('#cross-action'),
          frame: 'main/iframe#same-geometry/iframe#cross-geometry',
          inViewport: true,
        },
        {
          label: 'Clipped cross action',
          locator: crossFrame.locator('#clipped-cross-action'),
          frame: 'main/iframe#same-geometry/iframe#cross-geometry',
          inViewport: false,
        },
      ] as const;

      for (const expected of actionCases) {
        const box = await expected.locator.boundingBox();
        const extracted = artifact.actions.find(({ label }) => label === expected.label);
        expect(box, `${expected.label}: browser box`).not.toBeNull();
        expect(extracted, `${expected.label}: extracted action`).toBeDefined();
        if (box === null || extracted === undefined) continue;
        expect(extracted.frame).toBe(expected.frame);
        expect(extracted.rect.x).toBeCloseTo(box.x, 1);
        expect(extracted.rect.y).toBeCloseTo(box.y, 1);
        expect(extracted.rect.w).toBeCloseTo(box.width, 1);
        expect(extracted.rect.h).toBeCloseTo(box.height, 1);
        expect(extracted.inViewport).toBe(expected.inViewport);
      }

      const mainAction = artifact.actions.find(({ label }) => label === 'Main viewport action');
      expect(mainAction?.rect.y).toBeLessThan(100);

      const statusBox = await crossFrame.locator('#nested-status').boundingBox();
      const status = artifact.observables.find(({ label }) => label === 'Nested status');
      expect(statusBox).not.toBeNull();
      expect(status).toBeDefined();
      if (statusBox !== null && status !== undefined) {
        expect(status.frame).toBe('main/iframe#same-geometry/iframe#cross-geometry');
        expect(status.rect.x).toBeCloseTo(statusBox.x, 1);
        expect(status.rect.y).toBeCloseTo(statusBox.y, 1);
        expect(status.rect.w).toBeCloseTo(statusBox.width, 1);
        expect(status.rect.h).toBeCloseTo(statusBox.height, 1);
      }
    } finally {
      await context.close();
    }
  });

  it('retains closed roots, listener state, and native-looking wrappers', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(new URL('react-delegated.html', baseUrl).href);
      const runtime = await page.evaluate(async () => {
        const root = document.querySelector('#react-root');
        const nexus = (window as typeof window & {
          __nexus?: {
            listenerTypes(target: EventTarget): string[];
            waitForQuiescence(timeout: number): Promise<boolean>;
          };
        }).__nexus;
        if (root === null || nexus === undefined) throw new Error('Missing runtime.');
        return {
          listeners: nexus.listenerTypes(root),
          addSource: EventTarget.prototype.addEventListener.toString(),
          settled: await nexus.waitForQuiescence(1_000),
        };
      });
      expect(runtime.listeners).toEqual(['click', 'keydown']);
      expect(runtime.addSource).toContain('[native code]');
      expect(runtime.settled).toBe(true);

      await page.goto(new URL('shadow-nested.html', baseUrl).href);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      expect(artifact.actions.find(({ label }) => label === 'Closed shadow action')?.shadowPath)
        .toEqual(['#outer-host', '#inner-host']);
    } finally {
      await page.close();
    }
  });

  it('keeps duplicate controller ids scoped to each nested shadow root', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      const document = `
        <x-shadow-menu id="alpha-component"></x-shadow-menu>
        <x-shadow-menu id="beta-component"></x-shadow-menu>
        <script>
          customElements.define('x-shadow-menu', class extends HTMLElement {
            connectedCallback() {
              const name = this.id.startsWith('alpha') ? 'Alpha' : 'Beta';
              const outer = this.attachShadow({ mode: 'open' });
              outer.innerHTML = '<div id="inner-host"></div>';
              const inner = outer.querySelector('#inner-host').attachShadow({ mode: 'closed' });
              inner.innerHTML = [
                '<button id="trigger" aria-controls="menu" aria-expanded="false">' + name + ' tools</button>',
                '<div id="menu" role="menu" aria-label="' + name + ' menu">',
                '  <button id="item" role="menuitem">' + name + ' profile</button>',
                '</div>'
              ].join('');
            }
          });
        </script>
      `;
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });

      for (const [name, host] of [
        ['Alpha', '#alpha-component'],
        ['Beta', '#beta-component'],
      ] as const) {
        const controller = artifact.actions.find(({ label }) => label === `${name} tools`);
        const item = artifact.actions.find(({ label }) => label === `${name} profile`);
        const group = artifact.groups.find(({ label }) => label === `${name} menu`);
        const expectedPath = [host, '#inner-host'];

        expect(controller?.shadowPath, `${name}: controller path`).toEqual(expectedPath);
        expect(item?.shadowPath, `${name}: item path`).toEqual(expectedPath);
        expect(item?.parentAction, `${name}: item controller`).toBe(controller?.id);
        expect(group?.parentAction, `${name}: group controller`).toBe(controller?.id);
        expect(group?.actions, `${name}: group membership`).toContain(item?.id);
      }

      const alpha = artifact.actions.find(({ label }) => label === 'Alpha tools');
      const beta = artifact.actions.find(({ label }) => label === 'Beta tools');
      expect(alpha?.id).not.toBe(beta?.id);
    } finally {
      await page.close();
    }
  });

  it('classifies native details and popover reveals as reversible', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <details>
          <summary>Advanced filters</summary>
          <button type="button">Apply advanced filter</button>
        </details>
        <button type="button" popovertarget="help-menu">Popover options</button>
        <div id="help-menu" popover role="menu" aria-label="Help menu">
          <button type="button" role="menuitem">Documentation</button>
        </div>
      `);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      expect(artifact.actions.find(({ label }) => label === 'Advanced filters')).toMatchObject({
        kind: 'expand',
        risk: 'reversible',
        state: { expanded: false },
      });
      expect(artifact.actions.find(({ label }) => label === 'Popover options')).toMatchObject({
        kind: 'open',
        risk: 'reversible',
      });
      expect(artifact.groups.find(({ label }) => label === 'Help menu')).toMatchObject({
        kind: 'menu',
        conditional: true,
      });
    } finally {
      await page.close();
    }
  });

  it('classifies a generic Toggle menu opener as a safe recon reveal', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`<!doctype html><button id="odoo-menu">Toggle menu</button>`);
      const artifact = await scanState(page, { personaId: 'anonymous', buildId: 'test' });
      expect(artifact.actions.find(({ label }) => label === 'Toggle menu')).toMatchObject({
        kind: 'open',
        risk: 'reversible',
        visible: true,
      });
    } finally {
      await page.close();
    }
  });

  it('preserves a SauceDemo-shaped semantic tree and keeps sort choices in one control', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Swag Labs</title>
            <style>
              body { margin: 0; font: 16px sans-serif; }
              .header_container, .inventory_container { padding: 16px; }
              .primary_header, .header_secondary_container {
                display: flex; align-items: center; justify-content: space-between; min-height: 48px;
              }
              .inventory_list { display: flex; flex-direction: column; gap: 12px; }
              .inventory_item { display: flex; min-height: 120px; gap: 12px; }
              .inventory_item img { width: 100px; height: 100px; }
              .inventory_item_description { flex: 1; }
              select, button, a { min-width: 100px; min-height: 32px; }
            </style>
          </head>
          <body>
            <div id="root">
              <div class="header_container" data-test="header-container">
                <div class="primary_header">
                  <button id="react-burger-menu-btn" type="button">Open Menu</button>
                  <div class="app_logo">Swag Labs</div>
                  <a class="shopping_cart_link" data-test="shopping-cart-link" href="#cart">
                    <span class="shopping_cart_badge" data-test="shopping-cart-badge">1</span>
                  </a>
                </div>
                <div class="header_secondary_container">
                  <span class="title" data-test="title">Products</span>
                  <span class="select_container">
                    <select class="product_sort_container" data-test="product-sort-container">
                      <option value="az">Name (A to Z)</option>
                      <option value="za">Name (Z to A)</option>
                      <option value="lohi">Price (low to high)</option>
                      <option value="hilo">Price (high to low)</option>
                    </select>
                  </span>
                </div>
              </div>
              <div class="inventory_container" data-test="inventory-container">
                <div class="inventory_list" data-test="inventory-list">
                  ${[
                    ['4', 'Sauce Labs Backpack', '$29.99'],
                    ['0', 'Sauce Labs Bike Light', '$9.99'],
                    ['1', 'Sauce Labs Bolt T-Shirt', '$15.99'],
                  ].map(([id, name, price]) => `
                    <div class="inventory_item" data-test="inventory-item">
                      <a data-test="item-${id}-img-link" href="#item-${id}">
                        <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
                          alt="${name}" />
                      </a>
                      <div class="inventory_item_description">
                        <a data-test="item-${id}-title-link" href="#item-${id}">
                          <div class="inventory_item_name" data-test="inventory-item-name">${name}</div>
                        </a>
                        <div class="inventory_item_desc" role="status" aria-live="polite">Description for ${name}</div>
                        <div class="inventory_item_price">${price}</div>
                        <button data-test="add-to-cart-${id}" type="button">Add to cart</button>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            </div>
          </body>
        </html>
      `);

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const root = artifact.groups.find((group) =>
        group.kind === 'region' && group.parentGroup === undefined,
      );
      const header = artifact.groups.find(({ label }) => label === 'Header');
      const products = artifact.groups.find((group) =>
        group.kind === 'toolbar' && group.label === 'Products',
      );
      const inventory = artifact.groups.find(({ label }) => label === 'Inventory container');
      expect(root).toBeDefined();
      expect(header).toMatchObject({
        parentGroup: root?.id,
        conditional: false,
        global: true,
      });
      expect(products).toMatchObject({ parentGroup: header?.id, conditional: false });
      expect(inventory).toMatchObject({
        kind: 'main',
        parentGroup: root?.id,
        conditional: false,
      });

      const cart = artifact.actions.find(({ label }) => label === 'Shopping cart');
      expect(cart).toMatchObject({
        type: 'navigation',
        kind: 'navigate',
        risk: 'safe',
        region: header?.id,
        observedDestination: expect.stringMatching(/#cart$/u),
      });
      expect(cart?.locators).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'testid',
          value: '[data-test="shopping-cart-link"]',
        }),
      ]));
      expect(cart?.evidence).toEqual(expect.arrayContaining(['native_tag', 'ax_role']));
      expect(artifact.observables).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: 'Shopping cart badge', currentValue: '1' }),
      ]));

      const sort = artifact.actions.find(({ label }) => label === 'Product sort');
      expect(sort).toMatchObject({
        type: 'input',
        kind: 'select',
        value: 'Name (A to Z)',
        region: products?.id,
      });
      const choices = artifact.actions.filter(({ parentAction }) => parentAction === sort?.id);
      expect(choices.map(({ label }) => label)).toEqual([
        'Name (A to Z)',
        'Name (Z to A)',
        'Price (low to high)',
        'Price (high to low)',
      ]);
      expect(artifact.collections.some(({ anchors }) =>
        anchors.includes('Name (Z to A)') || anchors.includes('Price (low to high)'),
      )).toBe(false);

      const collection = artifact.collections.find(({ label }) => label === 'Inventory list');
      expect(collection?.anchors).toEqual([
        'Sauce Labs Backpack',
        'Sauce Labs Bike Light',
        'Sauce Labs Bolt T-Shirt',
      ]);
      expect(new Set(collection?.rows?.map(({ rowKey }) => rowKey)).size).toBe(3);
      expect(collection?.rows?.map(({ anchor }) => anchor)).not.toContain('');
      expect(artifact.groups.find(({ id }) => id === collection?.groupId)).toMatchObject({
        kind: 'collection',
        parentGroup: inventory?.id,
      });
      for (const row of collection?.rows ?? []) {
        const anchorAction = artifact.actions.find(({ id }) => id === row.anchorActionId);
        expect(anchorAction?.label).toBe(row.anchor);
        expect(row.cells).toEqual(expect.arrayContaining([
          expect.objectContaining({ column: 'Price', type: 'observable', value: expect.stringMatching(/^\$\d/u) }),
          expect.objectContaining({ column: 'Action', type: 'action', value: 'Add to cart' }),
          expect.objectContaining({ column: 'Image', type: 'image', value: row.anchor }),
        ]));
        expect(row.cells).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ column: 'Description' }),
        ]));
      }
    } finally {
      await page.close();
    }
  });

  it('marks accessibility- and geometry-hidden menus and their items conditional', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <div role="menu" aria-label="Opacity menu" style="opacity:0">
          <button role="menuitem">Opacity item</button>
        </div>
        <div role="menu" aria-label="ARIA hidden menu" aria-hidden="true">
          <button role="menuitem">ARIA hidden item</button>
        </div>
        <div role="menu" aria-label="Inert menu" inert>
          <button role="menuitem">Inert item</button>
        </div>
        <div role="menu" aria-label="Zero area menu"
          style="width:0;height:0;overflow:hidden">
          <button role="menuitem">Zero area item</button>
        </div>
      `);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      for (const name of ['Opacity', 'ARIA hidden', 'Inert', 'Zero area']) {
        expect(
          artifact.groups.find(({ label }) => label === `${name} menu`),
          `${name}: group`,
        ).toMatchObject({ kind: 'menu', conditional: true });
        expect(
          artifact.actions.find(({ label }) => label === `${name} item`)?.visible,
          `${name}: item visibility`,
        ).toBe(false);
      }
    } finally {
      await page.close();
    }
  });

  it('retains hidden and zero-area controls across nested open and closed roots', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <main>
          <button id="display-none" style="display:none">Display dormant</button>
          <button id="visibility-hidden" style="visibility:hidden">Visibility dormant</button>
          <div id="zero-area" role="button" tabindex="0"
            style="display:block;width:0;height:0;overflow:hidden">Zero area dormant</div>
          <section id="outer-dormant"></section>
        </main>
        <script>
          const outer = document.querySelector('#outer-dormant').attachShadow({ mode: 'open' });
          outer.innerHTML = '<div id="inner-dormant"></div>';
          const closed = outer.querySelector('#inner-dormant').attachShadow({ mode: 'closed' });
          closed.innerHTML = '<button id="closed-dormant" hidden>Closed dormant</button>';
        </script>
      `);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      for (const label of [
        'Display dormant',
        'Visibility dormant',
        'Zero area dormant',
        'Closed dormant',
      ]) {
        const action = artifact.actions.find((candidate) => candidate.label === label);
        expect(action, label).toBeDefined();
        expect(action?.visible, label).toBe(false);
      }
      expect(artifact.actions.find(({ label }) => label === 'Closed dormant')?.shadowPath)
        .toEqual(['#outer-dormant', '#inner-dormant']);
    } finally {
      await page.close();
    }
  });

  it('assigns all action prefixes independently in document order', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <main>
          <button type="button">First button</button>
          <a href="#destination">Destination</a>
          <label>Email <input type="email" /></label>
          <label>Password <input type="password" /></label>
          <label>Country
            <select><option>India</option><option>Japan</option></select>
          </label>
          <label>Updates <input type="checkbox" /></label>
          <label>Plan <input type="radio" name="plan" /></label>
          <div role="switch" aria-label="Dark mode" aria-checked="false" tabindex="0"></div>
          <div contenteditable="true" aria-label="Notes"></div>
          <label>Attachment <input type="file" /></label>
          <button type="button">Second button</button>
          <input type="text" aria-label="Search" />
          <output aria-label="Result count">3</output>
        </main>
      `);

      const first = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const second = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const idFor = (label: string) => first.actions.find((action) => action.label === label)?.id;

      expect(idFor('First button')).toBe('btn1');
      expect(idFor('Second button')).toBe('btn2');
      expect(idFor('Destination')).toBe('lnk1');
      expect(idFor('Email')).toBe('inp1');
      expect(idFor('Search')).toBe('inp2');
      expect(idFor('Password')).toBe('pwd1');
      expect(first.actions.find((action) =>
        action.kind === 'select' && action.parentAction === undefined,
      )?.id).toBe('sel1');
      expect(idFor('Updates')).toBe('chk1');
      expect(idFor('Plan')).toBe('rad1');
      expect(idFor('Dark mode')).toBe('tog1');
      expect(idFor('Notes')).toBe('txt1');
      expect(idFor('Attachment')).toBe('upl1');
      expect(first.observables.find(({ label }) => label === 'Result count')?.id).toBe('obs1');

      expect(first.actions.every(({ id }) => isActionElementId(id))).toBe(true);
      const idsByPrefix = new Map<string, number[]>();
      for (const { id } of first.actions) {
        const parsed = parseElementId(id);
        expect(parsed, id).not.toBeNull();
        if (parsed === null) continue;
        const indices = idsByPrefix.get(parsed.prefix) ?? [];
        indices.push(parsed.index);
        idsByPrefix.set(parsed.prefix, indices);
      }
      for (const indices of idsByPrefix.values()) {
        expect(indices).toEqual(indices.map((_, index) => index + 1));
      }

      // Local ordinals and hashes are both deterministic, but are independent
      // contracts: changing the public ID scheme never changes stableId.
      expect(second.actions.map(({ id, stableId }) => ({ id, stableId }))).toEqual(
        first.actions.map(({ id, stableId }) => ({ id, stableId })),
      );
    } finally {
      await page.close();
    }
  });

  it('records password values and distinguishes changes between them', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <label>Password <input id="password" type="password" value="do-not-persist" /></label>
      `);
      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const password = artifact.actions.find(({ label }) => label === 'Password');
      expect(password).toBeDefined();
      expect(password).toHaveProperty('value', 'do-not-persist');
      expect(JSON.stringify(artifact)).toContain('do-not-persist');
      const passwordDigests = await page.evaluate(() => {
        const scoped = window as typeof window & {
          __nexus: { semanticSurfaceDigest(): NexusSemanticSurface };
        };
        const field = document.querySelector<HTMLInputElement>('#password');
        if (field === null) throw new Error('Missing password field.');
        field.value = '';
        const empty = scoped.__nexus.semanticSurfaceDigest().digest;
        field.value = 'first-private-value';
        const first = scoped.__nexus.semanticSurfaceDigest().digest;
        field.value = 'different-private-value';
        const second = scoped.__nexus.semanticSurfaceDigest().digest;
        return { empty, first, second };
      });
      expect(passwordDigests.first).not.toBe(passwordDigests.empty);
      expect(passwordDigests.second).not.toBe(passwordDigests.first);
    } finally {
      await page.close();
    }
  });

  it('settles network-only activity without advancing or notifying a material epoch', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(new URL('observables.html', baseUrl).href, { waitUntil: 'load' });
      await page.evaluate(async () => {
        const runtime = (window as typeof window & {
          __nexus: { waitForQuiescence(timeout: number): Promise<boolean> };
        }).__nexus;
        await runtime.waitForQuiescence(1_000);
        (window as typeof window & {
          materialNotifications: NexusSettledNotification[];
        }).materialNotifications = [];
        window.addEventListener('nexus:settled', ((event: CustomEvent<NexusSettledNotification>) => {
          (window as typeof window & {
            materialNotifications: NexusSettledNotification[];
          }).materialNotifications.push(event.detail);
        }) as EventListener);
      });

      const before = await page.evaluate(() => {
        const runtime = (window as typeof window & {
          __nexus: {
            quiescent(): NexusQuiescence;
            semanticSurfaceDigest(): NexusSemanticSurface;
          };
        }).__nexus;
        return { state: runtime.quiescent(), surface: runtime.semanticSurfaceDigest() };
      });
      const settled = await page.evaluate(async () => {
        const runtime = (window as typeof window & {
          __nexus: { waitForQuiescence(timeout: number): Promise<boolean> };
        }).__nexus;
        await fetch('/network-only-does-not-exist.json');
        return runtime.waitForQuiescence(1_000);
      });
      expect(settled).toBe(true);
      await page.waitForTimeout(quietAfterTestWindowMs);

      const after = await page.evaluate(() => {
        const scoped = window as typeof window & {
          __nexus: {
            quiescent(): NexusQuiescence;
            semanticSurfaceDigest(): NexusSemanticSurface;
          };
          materialNotifications: NexusSettledNotification[];
        };
        return {
          state: scoped.__nexus.quiescent(),
          surface: scoped.__nexus.semanticSurfaceDigest(),
          notifications: scoped.materialNotifications,
        };
      });
      expect(after.notifications).toEqual([]);
      expect(after.state.epoch).toBe(before.state.epoch);
      expect(after.state.causes).toEqual([]);
      expect(after.surface).toEqual(before.surface);
    } finally {
      await page.close();
    }
  });

  it('separates quantized presentation movement and signals viewport layout changes', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <div style="height: 240px"></div>
        <button id="target" type="button">Continue</button>
        <div style="height: 1600px"></div>
      `)}`);
      const baseline = await page.evaluate(async () => {
        const scoped = window as typeof window & {
          __nexus: {
            waitForQuiescence(timeout: number): Promise<boolean>;
            semanticSurfaceDigest(): NexusSemanticSurface;
          };
          materialNotifications: NexusSettledNotification[];
        };
        await scoped.__nexus.waitForQuiescence(1_000);
        scoped.materialNotifications = [];
        window.addEventListener('nexus:settled', ((event: CustomEvent<NexusSettledNotification>) => {
          scoped.materialNotifications.push(event.detail);
        }) as EventListener);
        return scoped.__nexus.semanticSurfaceDigest();
      });

      await page.evaluate(() => {
        window.scrollTo(0, 40);
        // Headless Chromium can coalesce the native event with setContent's
        // initial layout; dispatching the equivalent root event makes the
        // instrumentation contract deterministic without changing geometry.
        window.dispatchEvent(new Event('scroll'));
      });
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { materialNotifications: NexusSettledNotification[] }
      ).materialNotifications.length)).toBe(1);
      const afterScroll = await page.evaluate(() => {
        const scoped = window as typeof window & {
          __nexus: { semanticSurfaceDigest(): NexusSemanticSurface };
          materialNotifications: NexusSettledNotification[];
        };
        return {
          surface: scoped.__nexus.semanticSurfaceDigest(),
          notification: scoped.materialNotifications[0],
        };
      });
      expect(afterScroll.surface.digest).toBe(baseline.digest);
      expect(afterScroll.surface.presentationDigest).not.toBe(baseline.presentationDigest);
      expect(afterScroll.notification?.causes).toContain('scroll');

      await page.evaluate(() => {
        const scoped = window as typeof window & {
          materialNotifications: NexusSettledNotification[];
        };
        scoped.materialNotifications = [];
        window.dispatchEvent(new Event('resize'));
        window.visualViewport?.dispatchEvent(new Event('resize'));
      });
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { materialNotifications: NexusSettledNotification[] }
      ).materialNotifications.length)).toBe(1);
      const viewportNotification = await page.evaluate(() => (
        window as typeof window & { materialNotifications: NexusSettledNotification[] }
      ).materialNotifications[0]);
      expect(viewportNotification?.causes).toContain('scroll');
      expect(viewportNotification?.surface.presentationDigest).toMatch(/^[a-f0-9]{16}$/u);
    } finally {
      await page.close();
    }
  });

  it('coalesces synchronous semantic signals into one epoch with aggregate causes', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <button id="menu" type="button" aria-expanded="false">Menu</button>
        <label>Search <input id="search" /></label>
      `)}`);
      const baselineEpoch = await page.evaluate(async () => {
        const scoped = window as typeof window & {
          __nexus: {
            quiescent(): NexusQuiescence;
            waitForQuiescence(timeout: number): Promise<boolean>;
          };
          materialNotifications: NexusSettledNotification[];
        };
        await scoped.__nexus.waitForQuiescence(1_000);
        scoped.materialNotifications = [];
        window.addEventListener('nexus:settled', ((event: CustomEvent<NexusSettledNotification>) => {
          scoped.materialNotifications.push(event.detail);
        }) as EventListener);
        return scoped.__nexus.quiescent().epoch;
      });

      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('#search');
        const menu = document.querySelector<HTMLButtonElement>('#menu');
        if (input === null || menu === null) throw new Error('Missing test controls.');
        input.value = 'member';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        menu.setAttribute('aria-expanded', 'true');
        menu.setAttribute('aria-controls', 'menu-items');
        history.replaceState({ menu: true }, '', '#menu');
      });

      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { materialNotifications: NexusSettledNotification[] }
      ).materialNotifications.length)).toBe(1);
      await page.waitForTimeout(quietAfterTestWindowMs);
      const notifications = await page.evaluate(() => (
        window as typeof window & { materialNotifications: NexusSettledNotification[] }
      ).materialNotifications);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        settled: true,
        inflight: 0,
        epoch: baselineEpoch + 1,
      });
      expect(notifications[0]?.causes).toEqual(['dom', 'history', 'value']);
      expect(notifications[0]?.surface.actions).toBeGreaterThanOrEqual(2);
      expect(notifications[0]?.surface.digest).toMatch(/^[a-f0-9]{16}$/u);
    } finally {
      await page.close();
    }
  });

  it('signals quiescence for property-only input, checkbox, scroll, and closed-shadow changes', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      const document = `
        <input id="text" />
        <input id="check" type="checkbox" />
        <div style="height:2000px"></div>
        <section id="signal-shadow"></section>
        <script>
          const root = document.querySelector('#signal-shadow').attachShadow({ mode: 'closed' });
          root.innerHTML = '<span>Initial</span>';
          window.signalRoot = root;
          window.settledSignals = 0;
          window.addEventListener('nexus:settled', () => { window.settledSignals += 1; });
        </script>
      `;
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
      await page.evaluate(async () => {
        await (window as typeof window & {
          __nexus: { waitForQuiescence(timeout: number): Promise<boolean> };
        }).__nexus.waitForQuiescence(1_000);
        (window as typeof window & { settledSignals: number }).settledSignals = 0;
      });

      await page.locator('#text').fill('member');
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { settledSignals: number }
      ).settledSignals)).toBeGreaterThan(0);

      await page.evaluate(() => { (window as typeof window & { settledSignals: number }).settledSignals = 0; });
      await page.locator('#check').check();
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.evaluate(() => {
        const root = (window as typeof window & { signalRoot: ShadowRoot }).signalRoot;
        root.querySelector('span')?.replaceChildren('Updated');
      });
      await expect.poll(() => page.evaluate(() => (
        window as typeof window & { settledSignals: number }
      ).settledSignals)).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  it('emits honest phase/group hooks and stable state fingerprints', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.goto(new URL('observables.html', baseUrl).href);
      const phases: ExtractionPhase[] = [];
      const streamedGroups: string[] = [];
      const first = await scanState(page, {
        quiescenceTimeoutMs: 1_000,
        onPhase: (phase) => {
          phases.push(phase);
        },
        onGroup: ({ group }) => {
          streamedGroups.push(group.id);
        },
      });
      const second = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      expect(phases).toEqual([
        'injecting',
        'settling',
        'walking',
        'classifying',
        'grouping',
        'observing',
      ]);
      expect(streamedGroups).toEqual(first.groups.map(({ id }) => id));
      expect(second.stateId).toBe(first.stateId);
      expect(normalizeRoute('https://example.test/users/847?sessionId=x&tab=billing'))
        .toBe('https://example.test/users/847?sessionId=x&tab=billing');
    } finally {
      await page.close();
    }
  });

  it('ignores React container handlers and classifies native input buttons', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Native input buttons</title>
            <style>
              main { padding: 24px; }
              input, [tabindex] { display: block; margin: 8px; width: 180px; height: 32px; }
            </style>
          </head>
          <body>
            <main aria-label="Login surface">
              <form aria-label="Account sign in">
                <label>Username <input name="username" type="text" /></label>
                <input data-test="login-button" type="submit" value="Login" />
                <input data-test="preview-button" type="button" value="Preview" />
                <input data-test="reset-button" type="reset" value="Clear form" />
                <input
                  alt="Sign in visually"
                  data-test="image-button"
                  height="32"
                  src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='32'%3E%3C/svg%3E"
                  type="image"
                  width="180"
                />
              </form>
              <button id="plain-menu" type="button">Menu</button>
              <div id="react-card" tabindex="0">Open help</div>
            </main>
          </body>
        </html>
      `);
      await page.evaluate(() => {
        const defineReactProps = (selector: string, props: Record<string, unknown>) => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`Missing ${selector}.`);
          Object.defineProperty(element, '__reactProps$regression', {
            configurable: true,
            value: props,
          });
        };
        defineReactProps('main', { onMouseEnter() {} });
        defineReactProps('form', { onClick() {}, onSubmit() {} });
        defineReactProps('#react-card', { onClick() {} });
      });

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const byTestId = (testId: string) => artifact.actions.find(({ locators }) =>
        locators.some(({ kind, value }) =>
          kind === 'testid' && value === `[data-test="${testId}"]`,
        ),
      );

      expect(artifact.actions.map(({ label }) => label)).not.toContain('Login surface');
      expect(artifact.actions.map(({ label }) => label)).not.toContain('Account sign in');
      expect(artifact.actions).toContainEqual(expect.objectContaining({
        label: 'Open help',
        type: 'button',
        kind: 'unknown',
        evidence: expect.arrayContaining(['react_props']),
      }));
      expect(artifact.actions).toContainEqual(expect.objectContaining({
        label: 'Menu',
        type: 'button',
        kind: 'open',
        risk: 'reversible',
      }));
      expect(byTestId('login-button')).toMatchObject({
        label: 'Login',
        type: 'button',
        kind: 'submit',
      });
      expect(byTestId('preview-button')).toMatchObject({
        label: 'Preview',
        type: 'button',
        kind: 'unknown',
      });
      expect(byTestId('reset-button')).toMatchObject({
        label: 'Clear form',
        type: 'button',
        kind: 'unknown',
      });
      expect(byTestId('image-button')).toMatchObject({
        label: 'Sign in visually',
        type: 'button',
        kind: 'submit',
      });
    } finally {
      await page.close();
    }
  });

  it('does not promote styled field labels into duplicate buttons', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Field labels are not actions</title>
            <style>
              .field-label, #recovery-caption, .loose-caption { cursor: pointer; display: block; }
              .field-label:hover, #recovery-caption:hover, .loose-caption:hover { opacity: .99; }
              input, [role="button"] { display:block; width:220px; height:32px; margin:8px; }
            </style>
          </head>
          <body>
            <form aria-label="Account details">
              <label class="field-label" for="email">Email</label>
              <input id="email" name="email" type="email" />
              <span id="recovery-caption">Recovery email</span>
              <input aria-labelledby="recovery-caption" id="recovery" type="email" />
              <div class="loose-caption">Billing email</div>
              <input id="billing-email" placeholder="Billing email" type="email" />
              <div id="custom-help" role="button" tabindex="0">Email help</div>
            </form>
            <a href="/support" id="support-link">
              <img alt="Support center" width="32" height="32"
                src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" />
            </a>
          </body>
        </html>
      `);
      await page.evaluate(() => {
        document.querySelector('.field-label')?.addEventListener('click', () => undefined);
        document.querySelector('#recovery-caption')?.addEventListener('click', () => undefined);
        const help = document.querySelector('#custom-help');
        if (help === null) throw new Error('Missing custom help control.');
        Object.defineProperty(help, '__reactProps$labelRegression', {
          configurable: true,
          value: { onClick() {} },
        });
      });

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      expect(artifact.actions.filter(({ label }) => label === 'Email')).toHaveLength(1);
      expect(artifact.actions.find(({ label }) => label === 'Email')).toMatchObject({
        type: 'input',
        kind: 'input',
      });
      expect(artifact.actions.filter(({ label }) => label === 'Recovery email')).toEqual([
        expect.objectContaining({ type: 'input', kind: 'input' }),
      ]);
      expect(artifact.actions.filter(({ label }) => label === 'Billing email')).toEqual([
        expect.objectContaining({ type: 'input', kind: 'input' }),
      ]);
      expect(artifact.actions).toContainEqual(expect.objectContaining({
        label: 'Email help',
        type: 'button',
        evidence: expect.arrayContaining(['aria_role', 'react_props']),
      }));
      expect(artifact.actions.filter(({ label }) => label === 'Support center')).toEqual([
        expect.objectContaining({ type: 'navigation', kind: 'navigate' }),
      ]);
    } finally {
      await page.close();
    }
  });

  it('models Odoo-style app tiles as concrete composite collection rows', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <!doctype html>
        <html lang="en">
          <head>
            <title>Odoo app launcher</title>
            <style>
              .o_apps { display:grid; grid-template-columns:repeat(4, 160px); gap:12px; }
              .o_app { display:grid; justify-items:center; padding:16px; min-height:120px; }
              .o_app svg, .o_app img, .o_app_icon { display:block; width:64px; height:64px; }
            </style>
          </head>
          <body>
            <main>
              <h1>Home</h1>
              <nav aria-label="Application launcher">
                <div class="o_apps">
                  <a class="o_app" href="/discuss"><svg><circle cx="32" cy="32" r="30" /></svg><span>Discuss</span></a>
                  <a class="o_app" href="/calendar"><svg role="img" aria-label="Calendar logo"><circle cx="32" cy="32" r="30" /></svg><span>Calendar</span></a>
                  <a class="o_app featured" href="/contacts"><span class="o_app_icon" style="background-image:url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E')"></span><span>Contacts</span></a>
                  <a class="o_app is-disabled" href="/crm"><img alt="CRM logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" /><span>CRM</span></a>
                </div>
              </nav>
              <table>
                <caption>Customer details</caption>
                <thead><tr><th>Customer</th><th>Email</th><th>Phone</th></tr></thead>
                <tbody>
                  <tr><td><a href="/customer/acme">Acme</a></td><td>ops@acme.test</td><td>+1 555 0101</td></tr>
                  <tr><td><a href="/customer/globex">Globex</a></td><td>hello@globex.test</td><td>+1 555 0102</td></tr>
                  <tr><td><a href="/customer/initech">Initech</a></td><td>team@initech.test</td><td>+1 555 0103</td></tr>
                </tbody>
              </table>
              <section aria-label="Quarterly balances">
                <div aria-label="Customer summaries" style="display:grid">
                  <div class="summary-row"><span class="customer">Acme</span><span class="plan">Gold</span></div>
                  <div class="summary-row"><span class="customer">Globex</span><span class="plan">Silver</span></div>
                  <div class="summary-row"><span class="customer">Initech</span><span class="plan">Bronze</span></div>
                </div>
              </section>
            </main>
          </body>
        </html>
      `);

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const collection = artifact.collections.find(({ label }) => label === 'Apps');
      expect(collection).toBeDefined();
      expect(collection?.id).toBe('col1');
      expect(collection).toMatchObject({
        instancesObserved: 4,
        anchors: ['Discuss', 'Calendar', 'Contacts', 'CRM'],
      });
      expect(collection?.itemActions.map(({ label }) => label)).toEqual(['Open app']);
      expect(collection?.groupId).toMatch(/^g\d+$/u);
      expect(collection?.rows).toHaveLength(4);
      expect(artifact.actions.map(({ label }) => label)).not.toEqual(
        expect.arrayContaining(['Discuss logo', 'Calendar logo', 'Contacts logo', 'CRM logo']),
      );

      for (const row of collection?.rows ?? []) {
        const anchorAction = artifact.actions.find(({ id }) => id === row.anchorActionId);
        expect(anchorAction, row.anchor).toMatchObject({
          label: row.anchor,
          type: 'navigation',
          rect: row.rect,
        });
        expect(row.cells.filter(({ type }) => type === 'action')).toHaveLength(0);
        expect(row.cells).toContainEqual(expect.objectContaining({
          type: 'image',
          value: ['Calendar', 'CRM'].includes(row.anchor) ? `${row.anchor} logo` : 'Image',
        }));
        expect(JSON.stringify(row.cells)).not.toContain('data:image');
        if (row.anchor === 'Contacts') {
          expect(row.cells).toContainEqual(expect.objectContaining({
            column: 'Logo',
            type: 'image',
          }));
        }
        expect(row.cells.filter(({ type }) => type === 'text')).toHaveLength(0);
      }

      const collectionGroup = artifact.groups.find(({ id }) => id === collection?.groupId);
      expect(collectionGroup?.kind).toBe('collection');
      expect(collectionGroup?.actions).toEqual(
        expect.arrayContaining((collection?.rows ?? []).map(({ anchorActionId }) => anchorActionId)),
      );

      const customers = artifact.collections.find(({ label }) => label === 'Customer details');
      expect(artifact.collections.filter(({ label }) => label === 'Customer details')).toHaveLength(1);
      expect(customers?.anchors).toEqual(['Acme', 'Globex', 'Initech']);
      expect(customers?.instancesObserved).toBe(3);
      expect(customers?.itemActions.map(({ label }) => label)).toEqual(['Open customer']);
      expect(customers?.rows?.[0]?.cells).toEqual(expect.arrayContaining([
        expect.objectContaining({
          column: 'Title link',
          type: 'action',
          value: 'Acme',
        }),
        expect.objectContaining({
          column: 'Email',
          type: 'text',
          value: 'ops@acme.test',
        }),
        expect.objectContaining({
          column: 'Phone',
          type: 'text',
          value: '+1 555 0101',
        }),
      ]));

      const summaries = artifact.collections.find(({ label }) => label === 'Customer summaries');
      expect(summaries?.rows).toHaveLength(3);
      const summariesGroup = artifact.groups.find(({ id }) => id === summaries?.groupId);
      expect(summariesGroup).toMatchObject({ kind: 'collection', actions: [], observables: [] });
      expect(artifact.groups.find(({ id }) => id === summariesGroup?.parentGroup)?.label)
        .toBe('Quarterly balances');
      expectLocalElementReferencesToResolve(artifact);
    } finally {
      await page.close();
    }
  });

  it('keeps repeated collections isolated across duplicate closed-shadow selectors', async () => {
    const page = await browser.newPage();
    try {
      await installInstrumentation(page);
      await page.setContent(`
        <!doctype html>
        <html lang="en">
          <head><title>Shadow collection identity</title></head>
          <body><div id="alpha-host"></div><div id="beta-host"></div></body>
        </html>
      `);
      await page.evaluate(() => {
        for (const [hostId, prefix] of [
          ['alpha-host', 'Alpha'],
          ['beta-host', 'Beta'],
        ] as const) {
          const host = document.getElementById(hostId);
          if (host === null) throw new Error(`Missing ${hostId}.`);
          const root = host.attachShadow({ mode: 'closed' });
          root.innerHTML = `
            <style>
              #grid { display:grid; grid-template-columns:repeat(3, 120px); }
              .row { display:grid; min-height:90px; }
              img { width:40px; height:40px; }
            </style>
            <div id="grid" aria-label="${prefix} apps">
              ${[1, 2, 3].map((index) => `
                <a class="row" id="row-${index}" href="/${prefix.toLowerCase()}/${index}">
                  <img alt="${prefix} ${index} logo" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" />
                  <span>${prefix} ${index}</span>
                </a>
              `).join('')}
            </div>
          `;
        }
      });

      const artifact = await scanState(page, { quiescenceTimeoutMs: 1_000 });
      const alpha = artifact.collections.find(({ label }) => label === 'Alpha apps');
      const beta = artifact.collections.find(({ label }) => label === 'Beta apps');
      expect(alpha?.anchors).toEqual(['Alpha 1', 'Alpha 2', 'Alpha 3']);
      expect(beta?.anchors).toEqual(['Beta 1', 'Beta 2', 'Beta 3']);
      expect(alpha?.templateId).not.toBe(beta?.templateId);
      expect(new Set(alpha?.rows?.map(({ rowKey }) => rowKey)).size).toBe(3);
      expect(new Set(beta?.rows?.map(({ rowKey }) => rowKey)).size).toBe(3);
      expect(alpha?.rows?.every(({ rowKey }) => rowKey.includes('#alpha-host'))).toBe(true);
      expect(beta?.rows?.every(({ rowKey }) => rowKey.includes('#beta-host'))).toBe(true);
      expect(alpha?.rows?.some(({ rowKey }) =>
        beta?.rows?.some((candidate) => candidate.rowKey === rowKey),
      )).toBe(false);

      const alphaGroup = artifact.groups.find(({ id }) => id === alpha?.groupId);
      const betaGroup = artifact.groups.find(({ id }) => id === beta?.groupId);
      expect(alphaGroup?.actions.map((id) =>
        artifact.actions.find((action) => action.id === id)?.label,
      )).toEqual(['Alpha 1', 'Alpha 2', 'Alpha 3']);
      expect(betaGroup?.actions.map((id) =>
        artifact.actions.find((action) => action.id === id)?.label,
      )).toEqual(['Beta 1', 'Beta 2', 'Beta 3']);
    } finally {
      await page.close();
    }
  });
});
