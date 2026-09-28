import type { Frame, Page } from 'playwright';

import { nexusBootstrap } from './bootstrap.js';
import { domBootstrap } from './dom.js';

/**
 * Source text of the in-page runtime.
 *
 * CDP can only carry a string across the boundary, so the driver port takes
 * source rather than a live function. Playwright serialises functions the same
 * way internally; making it explicit means both drivers install byte-identical
 * instrumentation.
 */
export const BOOTSTRAP_SOURCE: string = `() => { (${String(nexusBootstrap)})(); (${String(domBootstrap)})(); }`;

/**
 * Register Nexus before navigation and install it into every document that is
 * already attached. Calling this repeatedly is safe; the in-page bootstrap is
 * versioned and idempotent.
 */
export async function installInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(`(${BOOTSTRAP_SOURCE})()`);
  await Promise.all(
    page.frames().map(async (frame) => {
      await frame.evaluate(`(${BOOTSTRAP_SOURCE})()`).catch(() => undefined);
    }),
  );
}

export async function waitForFrameQuiescence(
  frame: Frame,
  timeoutMs = 8_000,
): Promise<boolean> {
  return frame.evaluate(async (timeout) => {
    const runtime = (
      window as typeof window & {
        __nexus?: { waitForQuiescence(value: number): Promise<boolean> };
      }
    ).__nexus;
    return runtime === undefined
      ? false
      : runtime.waitForQuiescence(timeout);
  }, timeoutMs);
}

export { nexusBootstrap } from './bootstrap.js';
export type {
  NexusMaterialCause,
  NexusQuiescence,
  NexusSemanticSurface,
  NexusSettledNotification,
} from './types.js';
