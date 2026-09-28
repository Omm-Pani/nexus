import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installInstrumentation, scanState } from '../src/index.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const shell = `<!doctype html>
  <html lang="en">
    <head><title>Identity fixture</title></head>
    <body>
      <main aria-label="Authentication">
        <h1>Sign in</h1>
        <form aria-label="Login form">
          <label>Email <input type="email"></label>
          <label>Password <input type="password"></label>
          <button type="submit">Login</button>
        </form>
      </main>
    </body>
  </html>`;

describe('real-browser state identity', () => {
  it('keeps reordered and repeated query values as separate exact page identities', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installInstrumentation(page);
    await context.route('https://identity.example.test/**', async (route) => {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell });
    });
    try {
      const firstUrl = 'https://identity.example.test/items?sort=name&filter=open&tag=b&tag=a#results';
      const secondUrl = 'https://identity.example.test/items?filter=open&sort=name&tag=a&tag=b#results';
      await page.goto(firstUrl);
      const first = await scanState(page);
      await page.goto(secondUrl);
      const second = await scanState(page);

      expect(first.url).toBe(firstUrl);
      expect(first.routeTemplate).toBe(firstUrl);
      expect(second.url).toBe(secondUrl);
      expect(second.routeTemplate).toBe(secondUrl);
      expect(second.stateId).not.toBe(first.stateId);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('retains distinct semantic views and an open menu as states under one URL', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installInstrumentation(page);
    await context.route('https://identity.example.test/**', async (route) => {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: shell });
    });
    try {
      const url = 'https://identity.example.test/app?tenant=acme';
      await page.goto(url);
      const login = await scanState(page);

      await page.locator('body').evaluate((body) => {
        body.innerHTML = `
          <header><button id="account" aria-controls="account-menu" aria-expanded="false">Account menu</button></header>
          <main aria-label="Operations dashboard"><h1>Dashboard</h1></main>`;
      });
      const dashboard = await scanState(page);

      await page.locator('body').evaluate((body) => {
        const button = body.querySelector<HTMLButtonElement>('#account');
        button?.setAttribute('aria-expanded', 'true');
        body.insertAdjacentHTML('beforeend', `
          <nav id="account-menu" role="menu" aria-label="Account menu">
            <a role="menuitem" href="#logout">Logout</a>
          </nav>`);
      });
      const menu = await scanState(page);

      expect([login.url, dashboard.url, menu.url]).toEqual([url, url, url]);
      expect(new Set([login.stateId, dashboard.stateId, menu.stateId]).size).toBe(3);
      expect(login.componentTree?.nodes.some(({ kind, label }) =>
        kind === 'component' && /login/iu.test(label),
      )).toBe(true);
      expect(dashboard.componentTree?.nodes.some(({ label }) => label === 'Operations dashboard'))
        .toBe(true);
      expect(menu.componentTree?.nodes.some(({ label }) => label === 'Account menu'))
        .toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps virtualized feed item identities stable when mounted rows reorder', async () => {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const page = await context.newPage();
    await installInstrumentation(page);
    await context.route('https://identity.example.test/**', async (route) => {
      await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html>
          <html lang="en"><head><title>Virtual feed</title>
            <style>#feed-scroll { max-height: 150px; overflow-y: auto; } article { min-height: 80px; }</style>
          </head><body><main aria-label="Media">
            <div id="feed-scroll"><div role="feed" aria-label="Recommended stream">
              <article aria-posinset="41" aria-setsize="500"><a href="#async">Async rendering explained</a></article>
              <div aria-busy="true">Loading more</div>
              <article aria-posinset="42" aria-setsize="500"><a href="#api">Designing resilient APIs</a></article>
              <article aria-posinset="43" aria-setsize="500"><a href="#state">State machines in practice</a></article>
            </div></div>
          </main></body></html>`,
      });
    });
    try {
      await page.goto('https://identity.example.test/feed');
      const first = await scanState(page);
      const firstCollection = first.collections.find(({ label }) => label === 'Recommended stream');
      expect(firstCollection).toMatchObject({
        instancesObserved: 3,
        instancesDeclared: 500,
        traversal: 'virtualized_scroll',
      });
      const itemIds = (artifact: typeof first) => new Map(
        (artifact.componentTree?.nodes ?? [])
          .filter(({ kind, anchor }) => kind === 'item' && anchor !== undefined)
          .map(({ anchor, stableId }) => [anchor as string, stableId]),
      );
      const before = itemIds(first);

      await page.locator('[role="feed"]').evaluate((feed) => {
        const rows = feed.querySelectorAll('article');
        if (rows.length > 1) feed.prepend(rows[rows.length - 1] as HTMLElement);
      });
      const second = await scanState(page);

      expect(itemIds(second)).toEqual(before);
      expect([...before.keys()]).toEqual(expect.arrayContaining([
        'Async rendering explained',
        'Designing resilient APIs',
        'State machines in practice',
      ]));
      expect(second.collections.find(({ label }) => label === 'Recommended stream')?.anchors)
        .not.toContain('Loading more');
      // DOM ordering is a state change; stable item identities are asserted above.
      expect(second.stateId).not.toBe(first.stateId);
    } finally {
      await context.close();
    }
  }, 60_000);
});
