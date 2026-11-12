import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { installInstrumentation } from '../src/index.js';

it('keeps boxes on live nodes across layout shifts, scroll, hidden inputs and closed shadows without observing its own overlays', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await installInstrumentation(page);
    await page.setContent(`<style>body{height:2000px}input{display:block;width:200px;height:30px}</style>
      <div id="spacer" style="height:30px"></div><input id="username"><input id="password"><div id="shadow"></div>`);
    await page.evaluate(() => {
      document.querySelector('#shadow')!.attachShadow({ mode: 'closed' }).innerHTML = '<button id="inside">Inside</button>';
      const runtime = (window as any).__nexus;
      runtime.highlight([...['#username', '#password'].map((selector) => ({ selector, x: 0, y: 0, w: 1, h: 1 })), { selector: '#inside', shadowPath: ['#shadow'], x: 0, y: 0, w: 1, h: 1 }]);
    });
    const boxes = () => page.evaluate(() => {
      const root = document.querySelector('[data-nexus-overlay]')!.shadowRoot!;
      return Array.from(root.querySelectorAll('i')).map((box) => ({ hidden: box.hidden, y: box.getBoundingClientRect().y, height: box.getBoundingClientRect().height }));
    });
    await page.evaluate(() => {
      (document.querySelector('#spacer') as HTMLElement).style.height = '200px';
      (document.querySelector('#password') as HTMLElement).style.display = 'none';
      window.scrollTo(0, 100);
    });
    await expect.poll(async () => (await boxes())[0]?.y).toBe(await page.locator('#username').evaluate((node) => node.getBoundingClientRect().y));
    expect((await boxes())[1]?.hidden).toBe(true);
    expect((await boxes())[2]?.height).toBeGreaterThan(0);
    // Geometry animation must never enter the journal or keep quiescence dirty.
    await page.evaluate(() => (window as any).__nexusDom.takeRecords());
    await page.waitForTimeout(250);
    const status = await page.evaluate(() => ({ quiet: (window as any).__nexus.quiescent().settled, records: (window as any).__nexusDom.takeRecords() }));
    expect(status.quiet).toBe(true);
    expect(status.records.filter((record: any) => record.kind === 'mutation')).toEqual([]);
    await page.locator('#username').evaluate((node) => node.remove());
    await expect.poll(async () => (await boxes())[0]?.hidden).toBe(true);
  } finally { await browser.close(); }
});
