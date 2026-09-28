import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StateArtifact } from '@nexus/schema';

import { installInstrumentation, scanState } from '../src/index.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

async function pageFor(html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installInstrumentation(page);
  await page.setContent(html);
  return page;
}

async function extract(page: Page): Promise<StateArtifact> {
  return scanState(page, { quiescenceTimeoutMs: 1_000 });
}

function expectReferencesToResolve(artifact: StateArtifact): void {
  const actionIds = new Set(artifact.actions.map(({ id }) => id));
  const groupIds = new Set(artifact.groups.map(({ id }) => id));
  expect(artifact.actions.every(({ region, parentAction }) =>
    groupIds.has(region) && (parentAction === undefined || actionIds.has(parentAction)),
  )).toBe(true);
  expect(artifact.groups.every(({ parentGroup, parentAction }) =>
    (parentGroup === undefined || groupIds.has(parentGroup))
    && (parentAction === undefined || actionIds.has(parentAction)),
  )).toBe(true);

  const tree = artifact.componentTree;
  expect(tree).toBeDefined();
  if (tree === undefined) return;
  const nodeIds = new Set(tree.nodes.map(({ id }) => id));
  expect(nodeIds.size).toBe(tree.nodes.length);
  expect(nodeIds.has(tree.root)).toBe(true);
  expect(tree.nodes.every(({ scope, children }) =>
    scope.frame !== '' && Array.isArray(scope.shadowPath)
    && children.every((child) => nodeIds.has(child)),
  )).toBe(true);
  const contained = tree.nodes.flatMap(({ children }) => children);
  expect(new Set(contained).size).toBe(contained.length);
  for (const id of [
    ...artifact.actions.map(({ id }) => id),
    ...artifact.observables.map(({ id }) => id),
    ...artifact.collections.map(({ id }) => id),
  ]) {
    expect(contained.filter((child) => child === id), `canonical owner for ${id}`)
      .toHaveLength(1);
  }
}

describe('cross-domain semantic hierarchy matrix', () => {
  it('separates SaaS landmarks, forms, tables, and component headers without false groups', async () => {
    const deep = (label: string) => `${'<div class="layout-layer">'.repeat(10)}
      <button id="duplicate-control" type="button">${label}</button>
      ${'</div>'.repeat(10)}`;
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Operations console</title>
          <style>
            body { margin: 0; font: 16px sans-serif; }
            .site-header, main, .main-content, .notifications-container { padding: 12px; }
            table { width: 700px; }
            .actions-container { display: flex; gap: 8px; }
            .notification { display: flex; gap: 8px; }
          </style>
        </head>
        <body>
          <div class="site-header"><button type="button">Account</button></div>
          <main aria-label="Workspace">
            <form aria-label="Invite member">
              <div class="card-header">Invite a teammate</div>
              <label>Email <input type="email" /></label>
              <div class="actions-container">
                <button type="button">Preview</button>
                <button type="reset">Clear</button>
                <button type="submit">Send invite</button>
              </div>
            </form>
            <table aria-label="Customer accounts">
              <thead><tr><th>Name</th><th>Plan</th><th>Action</th></tr></thead>
              <tbody>
                <tr><td>Acme</td><td>Pro</td><td><a href="#acme">Open Acme</a></td></tr>
                <tr><td>Globex</td><td>Team</td><td><a href="#globex">Open Globex</a></td></tr>
                <tr><td>Initech</td><td>Free</td><td><a href="#initech">Open Initech</a></td></tr>
              </tbody>
            </table>
            <section>${deep('First deep action')}</section>
            <section>${deep('Second deep action')}</section>
          </main>
          <div class="main-content">Supplemental content</div>
          <div class="notifications-container">
            <article class="notification"><strong>Build ready</strong><button>View</button></article>
            <article class="notification"><strong>Import done</strong><button>View</button></article>
            <article class="notification"><strong>Sync paused</strong><button>View</button></article>
          </div>
        </body>
      </html>
    `);
    try {
      const artifact = await extract(page);
      const roots = artifact.groups.filter(({ kind }) => kind === 'main');
      expect(roots).toHaveLength(1);
      expect(roots[0]?.label).toBe('Workspace');
      expect(artifact.groups.find(({ label }) => label === 'Header')).toMatchObject({
        global: true,
        conditional: false,
      });
      expect(artifact.groups.filter(({ label }) => label === 'Header')).toHaveLength(1);
      expect(artifact.groups.some(({ label }) => /card header/iu.test(label))).toBe(false);
      expect(artifact.collections.some(({ label }) => /actions/iu.test(label))).toBe(false);
      expect(artifact.collections.find(({ label }) => label === 'Customer accounts')).toMatchObject({
        instancesObserved: 3,
        traversal: 'static',
      });

      const deepActions = ['First deep action', 'Second deep action'].map((label) =>
        artifact.actions.find((action) => action.label === label),
      );
      expect(deepActions.every(Boolean)).toBe(true);
      expect(deepActions[0]?.locators.find(({ kind }) => kind === 'structural')?.value)
        .not.toBe('#duplicate-control');
      expect(deepActions[0]?.locators.find(({ kind }) => kind === 'structural')?.value)
        .not.toBe(deepActions[1]?.locators.find(({ kind }) => kind === 'structural')?.value);
      expectReferencesToResolve(artifact);
    } finally {
      await page.close();
    }
  });

  it('extracts closed-shadow ecommerce cards and keeps member identities stable through reorder', async () => {
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Storefront</title>
          <style>
            .catalog-container { padding: 16px; }
            #product-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
            catalog-card { display: block; min-height: 170px; border: 1px solid #ccc; }
          </style>
        </head>
        <body>
          <div class="catalog-container">
            <h1>Catalog</h1>
            <div id="product-grid" class="product-grid"></div>
          </div>
          <script>
            customElements.define('catalog-card', class extends HTMLElement {
              constructor() {
                super();
                this._root = this.attachShadow({ mode: 'closed' });
              }
              connectedCallback() {
                const name = this.getAttribute('name');
                const key = this.getAttribute('data-key');
                const price = this.getAttribute('price');
                this._root.innerHTML = \`
                  <article>
                    <img alt="\${name}" width="64" height="64"
                      src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />
                    <a class="item-title" href="#\${key}"><h2>\${name}</h2></a>
                    <span class="price">\${price}</span>
                    <button type="button">Add to basket</button>
                  </article>
                \`;
              }
            });
            const grid = document.querySelector('#product-grid');
            for (const [key, name, price] of [
              ['lamp', 'Beacon Lamp', '$48.00'],
              ['chair', 'Harbor Chair', '$85.00'],
              ['desk', 'Atlas Desk', '$210.00'],
            ]) {
              const card = document.createElement('catalog-card');
              card.setAttribute('data-key', key);
              card.setAttribute('name', name);
              card.setAttribute('price', price);
              grid.append(card);
            }
          </script>
        </body>
      </html>
    `);
    try {
      const first = await extract(page);
      const collection = first.collections.find(({ anchors }) =>
        anchors.includes('Beacon Lamp'),
      );
      expect(collection?.anchors).toEqual(['Beacon Lamp', 'Harbor Chair', 'Atlas Desk']);
      expect(collection?.rows?.every(({ cells }) =>
        cells.some(({ type }) => type === 'image'),
      )).toBe(true);
      const inferredMain = first.groups.find(({ kind }) => kind === 'main');
      expect(inferredMain?.label).toBe('Catalog');

      const memberState = (artifact: StateArtifact) => new Map(
        (artifact.collections.find(({ anchors }) => anchors.includes('Beacon Lamp'))?.rows ?? []).map((row) => {
          const actionIds = [row.anchorActionId, ...row.cells.map(({ actionId }) => actionId)]
            .filter((id): id is string => id !== undefined);
          return [row.anchor, {
            rowKey: row.rowKey,
            stableIds: actionIds.map((id) =>
              artifact.actions.find((action) => action.id === id)?.stableId,
            ).filter((id): id is string => id !== undefined).sort(),
          }];
        }),
      );
      const before = memberState(first);
      await page.evaluate(() => {
        const grid = document.querySelector('#product-grid');
        if (grid?.lastElementChild !== null && grid?.lastElementChild !== undefined) {
          grid.prepend(grid.lastElementChild);
        }
      });
      const second = await extract(page);
      expect(memberState(second)).toEqual(before);
      expectReferencesToResolve(second);
    } finally {
      await page.close();
    }
  });

  it('groups an interleaved recycled feed by aria set semantics without promoting sentinels', async () => {
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Media stream</title>
          <style>
            #feed-container { display: flex; flex-direction: column; gap: 8px; }
            #feed-scroll, #unknown-scroll { max-height: 140px; overflow-y: auto; }
            .stream-card { display: flex; min-height: 80px; gap: 8px; }
            .promo-shelf { min-height: 30px; }
            .unknown-event { display: flex; min-height: 70px; gap: 8px; }
          </style>
        </head>
        <body>
          <main aria-label="Stream">
            <div id="feed-scroll">
              <div id="feed-container" class="feed-container" aria-label="Recommended stream">
                <article class="stream-card" aria-posinset="41" aria-setsize="500">
                  <a href="#one"><h2>Async rendering explained</h2></a><span>12 minutes</span>
                </article>
                <aside class="promo-shelf">Sponsored shelf</aside>
                <article class="stream-card watched selected" aria-posinset="42" aria-setsize="500">
                  <a href="#two"><h2>Designing resilient APIs</h2></a><span>18 minutes</span>
                </article>
                <div class="loading-sentinel" aria-busy="true">Loading more</div>
                <article class="stream-card" aria-posinset="43" aria-setsize="500">
                  <a href="#three"><h2>State machines in practice</h2></a><span>9 minutes</span>
                </article>
              </div>
            </div>
            <media-feed aria-label="Following creators">
              <video-card><a href="#four"><h2>Shipping accessible components</h2></a></video-card>
              <channel-card><a href="#channel-one"><h2>Accessible Systems</h2></a></channel-card>
              <div class="ad-sentinel">Advertisement</div>
              <video-card class="watched"><a href="#five"><h2>Debugging event loops</h2></a></video-card>
              <channel-card class="subscribed"><a href="#channel-two"><h2>Runtime Weekly</h2></a></channel-card>
              <div class="loading-sentinel">Loading more creators</div>
              <video-card><a href="#six"><h2>Scaling local inference</h2></a></video-card>
              <channel-card><a href="#channel-three"><h2>Local Models Lab</h2></a></channel-card>
            </media-feed>
            <div id="unknown-scroll">
              <div role="feed" aria-label="Unknown activity">
                <article class="unknown-event" aria-posinset="21" aria-setsize="-1">
                  <a href="#event-one"><h2>Deployment started</h2></a>
                </article>
                <div class="loading-sentinel">Loading activity</div>
                <article class="unknown-event recent" aria-posinset="23" aria-setsize="-1">
                  <a href="#event-two"><h2>Checks completed</h2></a>
                </article>
                <article class="unknown-event" aria-posinset="24" aria-setsize="-1">
                  <a href="#event-three"><h2>Release promoted</h2></a>
                </article>
              </div>
            </div>
          </main>
        </body>
      </html>
    `);
    try {
      const artifact = await extract(page);
      const collection = artifact.collections.find(({ label }) => label === 'Recommended stream');
      expect(collection).toMatchObject({
        instancesObserved: 3,
        instancesDeclared: 500,
        traversal: 'virtualized_scroll',
        scrollContainer: '#feed-scroll',
      });
      expect(collection?.anchors).toEqual([
        'Async rendering explained',
        'Designing resilient APIs',
        'State machines in practice',
      ]);
      expect(collection?.anchors).not.toContain('Sponsored shelf');
      expect(collection?.anchors).not.toContain('Loading more');
      const following = artifact.collections.filter(({ label }) =>
        label.startsWith('Following creators · '),
      );
      expect(following).toHaveLength(2);
      expect(following.map(({ label }) => label).sort()).toEqual([
        'Following creators · Channel card',
        'Following creators · Video card',
      ]);
      expect(following.map(({ anchors }) => anchors)).toEqual(expect.arrayContaining([
        [
        'Shipping accessible components',
        'Debugging event loops',
        'Scaling local inference',
        ],
        ['Accessible Systems', 'Runtime Weekly', 'Local Models Lab'],
      ]));
      expect(new Set(following.map(({ templateId }) => templateId)).size).toBe(2);
      expect(following.every(({ instancesObserved, traversal }) =>
        instancesObserved === 3 && traversal === 'static',
      )).toBe(true);
      expect(following.flatMap(({ anchors }) => anchors)).not.toContain('Advertisement');
      expect(following.flatMap(({ anchors }) => anchors)).not.toContain('Loading more creators');

      const unknown = artifact.collections.find(({ label }) => label === 'Unknown activity');
      expect(unknown).toMatchObject({
        instancesObserved: 3,
        instancesDeclared: 3,
        traversal: 'virtualized_scroll',
        scrollContainer: '#unknown-scroll',
      });
      expect(unknown?.anchors).toEqual([
        'Deployment started',
        'Checks completed',
        'Release promoted',
      ]);
      expect(artifact.warnings).toContainEqual(expect.objectContaining({
        code: 'unknown_collection_size',
        ref: 'Unknown activity',
      }));
      expect(artifact.collections).toHaveLength(4);
      expectReferencesToResolve(artifact);
    } finally {
      await page.close();
    }
  });

  it('chooses one headed primary content region instead of an earlier notification rail', async () => {
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Overview</title>
          <style>
            .notifications-container { width: 260px; }
            .dashboard-panel { width: 900px; min-height: 500px; }
            .notice, .metric-card { display: flex; gap: 8px; }
          </style>
        </head>
        <body>
          <div class="notifications-container">
            <article class="notice">Import complete <button>View</button></article>
            <article class="notice">Report ready <button>View</button></article>
            <article class="notice">Sync paused <button>View</button></article>
          </div>
          <div class="dashboard-panel">
            <h1>Team overview</h1>
            <article class="metric-card"><strong>Revenue</strong><span>$8,200</span></article>
            <article class="metric-card"><strong>Pipeline</strong><span>$12,900</span></article>
            <article class="metric-card"><strong>Renewals</strong><span>84%</span></article>
          </div>
        </body>
      </html>
    `);
    try {
      const artifact = await extract(page);
      expect(artifact.groups.filter(({ kind }) => kind === 'main')).toHaveLength(1);
      expect(artifact.groups.find(({ kind }) => kind === 'main')?.label).toBe('Team overview');
      expect(artifact.groups.find(({ label }) => label === 'Notifications container')?.kind)
        .toBe('region');
      expectReferencesToResolve(artifact);
    } finally {
      await page.close();
    }
  });

  it('preserves nested closed-shadow and slotted hierarchy while owning grouped ARIA choices', async () => {
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Component workspace</title>
          <style>app-shell { display: block; min-height: 500px; }</style>
        </head>
        <body>
          <app-shell>
            <button slot="workspace" type="button">Refresh workspace</button>
          </app-shell>
          <script>
            customElements.define('nested-picker', class extends HTMLElement {
              constructor() {
                super();
                const root = this.attachShadow({ mode: 'closed' });
                root.innerHTML = \`
                  <div class="action-toolbar" aria-label="Record controls">
                    <button id="status-picker" role="combobox" aria-controls="status-list"
                      aria-expanded="true" type="button">Status</button>
                  </div>
                  <div id="status-list" role="listbox" aria-label="Status choices">
                    <div role="group" aria-label="Available statuses">
                      <div role="option" tabindex="0">Open</div>
                      <div role="option" tabindex="0">Paused</div>
                      <div role="option" tabindex="0">Closed</div>
                    </div>
                  </div>
                  <div role="combobox" aria-label="Priority" aria-expanded="true" tabindex="0">
                    <div id="priority-list" role="listbox" aria-label="Priority choices">
                      <div role="option" tabindex="0">Low</div>
                      <div role="option" tabindex="0">Normal</div>
                      <div role="option" tabindex="0">Urgent</div>
                    </div>
                  </div>
                \`;
              }
            });
            customElements.define('app-shell', class extends HTMLElement {
              constructor() {
                super();
                const root = this.attachShadow({ mode: 'closed' });
                root.innerHTML = \`
                  <div class="site-header"><button type="button">Profile</button></div>
                  <main aria-label="App main">
                    <nested-picker></nested-picker>
                    <slot name="workspace"></slot>
                  </main>
                  <div class="notifications-container">
                    <article><strong>One</strong><button>View one</button></article>
                    <article><strong>Two</strong><button>View two</button></article>
                    <article><strong>Three</strong><button>View three</button></article>
                  </div>
                \`;
              }
            });
          </script>
        </body>
      </html>
    `);
    try {
      const artifact = await extract(page);
      expect(artifact.groups.filter(({ kind }) => kind === 'main')).toHaveLength(1);
      const main = artifact.groups.find(({ kind }) => kind === 'main');
      expect(main?.label).toBe('App main');
      expect(artifact.groups.find(({ label }) => label === 'Header')).toMatchObject({ global: true });

      const refresh = artifact.actions.find(({ label }) => label === 'Refresh workspace');
      expect(refresh?.region).toBe(main?.id);
      const owner = artifact.actions.find(({ label }) => label === 'Status picker');
      expect(owner).toMatchObject({ kind: 'open', type: 'button' });
      const choices = artifact.actions.filter(({ parentAction }) => parentAction === owner?.id);
      expect(choices.map(({ label }) => label)).toEqual(['Open', 'Paused', 'Closed']);
      expect(choices.every(({ kind, type, risk }) =>
        kind === 'unknown' && type === 'button' && risk === 'reversible',
      )).toBe(true);
      const nestedOwner = artifact.actions.find(({ label }) => label === 'Priority');
      expect(nestedOwner).toMatchObject({ kind: 'open', type: 'button' });
      expect(artifact.actions.filter(({ parentAction }) => parentAction === nestedOwner?.id)
        .map(({ label }) => label)).toEqual(['Low', 'Normal', 'Urgent']);
      expect(artifact.actions.some(({ label }) => label === 'Status choices')).toBe(false);
      expect(artifact.actions.some(({ label }) => label === 'Priority choices')).toBe(false);
      expect(artifact.collections.some(({ anchors }) =>
        anchors.includes('Open')
        || anchors.includes('Paused')
        || anchors.includes('Closed')
        || anchors.includes('Low')
        || anchors.includes('Normal')
        || anchors.includes('Urgent'),
      )).toBe(false);
      expectReferencesToResolve(artifact);
    } finally {
      await page.close();
    }
  });

  it('keeps iframe and retained closed-shadow branches explicit in the canonical tree', async () => {
    const page = await pageFor(`
      <!doctype html>
      <html lang="en">
        <head><title>Scoped workspace</title></head>
        <body>
          <main aria-label="Host workspace">
            <secure-panel id="secure-panel"></secure-panel>
            <iframe id="settings-frame" title="Settings frame"
              srcdoc="<!doctype html><html><body><main aria-label='Frame workspace'><button id='frame-save'>Save frame settings</button></main></body></html>">
            </iframe>
          </main>
          <script>
            customElements.define('secure-panel', class extends HTMLElement {
              constructor() {
                super();
                const root = this.attachShadow({ mode: 'closed' });
                root.innerHTML = \`
                  <section aria-label="Private approvals">
                    <button id="private-approve">Approve privately</button>
                  </section>
                \`;
              }
            });
          </script>
        </body>
      </html>
    `);
    try {
      await page.frameLocator('#settings-frame').getByRole('button').waitFor();
      const artifact = await extract(page);
      expectReferencesToResolve(artifact);
      const tree = artifact.componentTree;
      expect(tree).toBeDefined();
      if (tree === undefined) return;
      const byId = new Map(tree.nodes.map((node) => [node.id, node]));
      const parent = new Map(tree.nodes.flatMap((node) =>
        node.children.map((child) => [child, node.id] as const),
      ));

      const privateAction = artifact.actions.find(({ label }) => label === 'Approve privately');
      const frameAction = artifact.actions.find(({ label }) => label === 'Save frame settings');
      expect(privateAction).toBeDefined();
      expect(frameAction).toBeDefined();
      expect(byId.get(privateAction?.id ?? '')?.scope).toMatchObject({
        frame: 'main',
        shadowPath: ['#secure-panel'],
      });
      expect(byId.get(parent.get(privateAction?.id ?? '') ?? '')?.scope.shadowPath)
        .toEqual(['#secure-panel']);
      expect(byId.get(frameAction?.id ?? '')?.scope.frame).toContain('iframe#settings-frame');
      expect(byId.get(parent.get(frameAction?.id ?? '') ?? '')?.scope.frame)
        .toContain('iframe#settings-frame');
    } finally {
      await page.close();
    }
  });
});
