import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { DomObservation } from '@nexus/schema';
import { installInstrumentation, scanState } from '../src/index.js';

let browser: Browser;
let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/child' ? '<html><body><span id="frame-static">Frame text</span><input id="frame-input"><div id="frame-shadow"><template shadowrootmode="closed"><button id="deep">Deep</button></template></div></body></html>' : `<!doctype html><html><head><title>Inventory</title></head><body>
      <h1>Everything</h1><div id="static" data-version="one">Static text</div><div hidden id="hidden"><span>Hidden text</span></div>
      <template id="template"><section id="template-child">Inert</section></template>
      <div id="declarative"><template shadowrootmode="closed"><button id="declarative-button">Closed declarative</button></template></div>
      <div id="imperative"></div><input id="input"><input type="password" id="password"><button id="button">Press</button>
      <iframe id="cross" src="${url?.replace('127.0.0.1', 'localhost')}/child"></iframe>
      <script>const root = document.querySelector('#imperative').attachShadow({mode:'closed'}); root.innerHTML='<span id="nested-host"></span>'; root.querySelector('span').attachShadow({mode:'closed'}).innerHTML='<button id="nested-button">Nested</button>';</script>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

it('inventories static, hidden, inert, nested closed, declarative closed and cross-origin DOM without gestures', async () => {
  const page = await browser.newPage();
  await installInstrumentation(page);
  await page.goto(url);
  const artifact = await scanState(page);
  const elements = artifact.dom!.flatMap((frame) => frame.elements);
  for (const target of ['static', 'hidden', 'template-child', 'declarative-button', 'nested-button', 'frame-static', 'deep']) {
    expect(elements.find((element) => element.attributes.id === target), target).toBeDefined();
  }
  expect(elements.find((element) => element.attributes.id === 'nested-button')?.shadowPath).toHaveLength(2);
  expect(elements.find((element) => element.attributes.id === 'deep')?.frame).toContain('iframe#cross');
  expect(new Set(elements.map((element) => element.id)).size).toBe(elements.length);
  expect(artifact.warnings.filter((warning) => warning.code === 'frame_inaccessible' || warning.code === 'shadow_root_unreachable')).toEqual([]);
  const changed = await page.evaluate(() => { document.querySelector('#static')!.setAttribute('data-version', 'two'); });
  const next = await scanState(page);
  expect(next.stateId).not.toBe(artifact.stateId);
  expect(next.dom![0]!.elements.find((element) => element.attributes.id === 'static')?.id).toBe(artifact.dom![0]!.elements.find((element) => element.attributes.id === 'static')?.id);
  await page.close();
});

it('recovers closed roots created before instrumentation attached', async () => {
  const page = await browser.newPage();
  await page.goto(url);
  const artifact = await scanState(page);
  const elements = artifact.dom!.flatMap((frame) => frame.elements);
  expect(elements.some((element) => element.attributes.id === 'nested-button')).toBe(true);
  expect(elements.some((element) => element.attributes.id === 'declarative-button')).toBe(true);
  await page.close();
});

it('journals interactions, rapid intermediate mutations, property-only changes and removed subtrees', async () => {
  const page = await browser.newPage();
  const observed: DomObservation[] = [];
  await page.exposeBinding('__nexusObserved', (_source, payload: string) => { observed.push(...JSON.parse(payload) as DomObservation[]); });
  await installInstrumentation(page);
  await page.goto(url);
  await scanState(page);
  await page.locator('#input').fill('hello');
  await page.locator('#password').fill('test_password with spaces');
  await page.locator('#button').click();
  await page.evaluate(() => {
    const item = document.querySelector('#static')!;
    item.setAttribute('data-version', 'two'); item.setAttribute('data-version', 'three');
    const transient = document.createElement('aside'); transient.id = 'transient'; transient.innerHTML = '<span>Brief</span>'; document.body.append(transient); transient.remove();
    (document.querySelector('#input') as HTMLInputElement).value = 'assigned';
    const runtime = (window as any).__nexus;
    runtime.shadowRoot(runtime.shadowRoot(document.querySelector('#imperative')).querySelector('#nested-host')).querySelector('button').click();
  });
  await page.waitForTimeout(100);
  expect(observed.some((entry) => entry.type === 'click')).toBe(true);
  expect(observed.some((entry) => entry.kind === 'property' && entry.detail.after === 'assigned')).toBe(true);
  expect(observed.some((entry) => entry.detail.before === 'one' && entry.detail.after === 'two')).toBe(true);
  expect(observed.some((entry) => entry.detail.before === 'two' && entry.detail.after === 'three')).toBe(true);
  expect(observed.some((entry) => entry.removed?.some((element) => element.attributes.id === 'transient'))).toBe(true);
  const final = await scanState(page);
  const nested = final.dom!.flatMap((frame) => frame.elements).find((element) => element.attributes.id === 'nested-button')!;
  expect(observed.some((entry) => entry.type === 'click' && entry.targetId === nested.id)).toBe(true);
  expect(JSON.stringify(observed)).toContain('test_password with spaces');
  expect(JSON.stringify(final.dom)).toContain('test_password with spaces');
  await page.close();
});
