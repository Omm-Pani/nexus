import type { Frame, Page } from 'playwright';
import { recoverShadowRoots } from './shadow.js';

import type {
  DriverFrame,
  FrameOwner,
  PageDriver,
} from './types.js';

/**
 * The path segment identifying one <iframe> inside its parent document.
 * Shared verbatim with the CDP driver so both produce identical frame paths,
 * which is what makes an artifact from one comparable to the other.
 */
/**
 * Identify and measure an <iframe> from its own element.
 *
 * Shared between both drivers so frame paths and geometry are byte-identical
 * whichever one produced them; an artifact from the desktop app has to be
 * comparable to one from the container.
 */
export function readFrameOwner(element: Element): FrameOwner {
  const owner = element as HTMLIFrameElement;
  const tag = owner.localName || 'iframe';
  let segment: string;
  if (owner.id !== '') {
    segment = `${tag}#${owner.id}`;
  } else if (owner.getAttribute('name')) {
    segment = `${tag}[name="${owner.getAttribute('name') ?? ''}"]`;
  } else if (owner.getAttribute('title')) {
    segment = `${tag}[title="${owner.getAttribute('title') ?? ''}"]`;
  } else {
    const siblings = owner.parentElement === null
      ? [owner as Element]
      : Array.from(owner.parentElement.children).filter(
        (sibling) => sibling.localName === owner.localName,
      );
    segment = `${tag}:nth-of-type(${siblings.indexOf(owner) + 1})`;
  }

  const bounds = owner.getBoundingClientRect();
  // The border box is what getBoundingClientRect reports; child coordinates are
  // relative to the content box, so the border has to come out.
  const borderScaleX = owner.offsetWidth > 0 ? bounds.width / owner.offsetWidth : 1;
  const borderScaleY = owner.offsetHeight > 0 ? bounds.height / owner.offsetHeight : 1;
  return {
    segment,
    x: bounds.left + owner.clientLeft * borderScaleX,
    y: bounds.top + owner.clientTop * borderScaleY,
    width: owner.clientWidth * borderScaleX,
    height: owner.clientHeight * borderScaleY,
  };
}

/** Source text of {@link readFrameOwner}, for drivers that can only send text. */
export const FRAME_OWNER_SOURCE: string = String(readFrameOwner);

/** Read-only extraction adapter for CLI and web sessions. */
export class PlaywrightDriver implements PageDriver {
  readonly kind = 'playwright' as const;

  readonly #page: Page;
  readonly #frames = new Map<string, Frame>();
  readonly #scripts = new Set<string>();

  constructor(page: Page) {
    this.#page = page;
  }

  get page(): Page {
    return this.#page;
  }

  url(): string {
    return this.#page.url();
  }

  async title(): Promise<string> {
    return this.#page.title().catch(() => '');
  }

  async addInitScript(source: string): Promise<void> {
    // Playwright evaluates the string as a function body, so an IIFE keeps the
    // bootstrap's own top-level declarations out of the page's global scope.
    if (!this.#scripts.has(source)) {
      this.#scripts.add(source);
      await this.#page.addInitScript(`(${source})()`);
    }
    await Promise.all(
      this.#page.frames().map(async (frame) => {
        await frame.evaluate(`(${source})()`).catch(() => undefined);
      }),
    );
  }

  async prepareDom(): Promise<void> {
    // Each OOPIF needs its own protocol session. Same-process frames are pierced
    // by the parent's DOM tree; duplicate recovery is idempotent.
    for (const frame of this.#page.frames()) {
      const session = await this.#page.context().newCDPSession(frame).catch(() => null);
      if (session === null) continue;
      try { await recoverShadowRoots((method, params) => session.send(method as never, params as never)); }
      finally { await session.detach(); }
    }
  }

  async frames(): Promise<DriverFrame[]> {
    this.#frames.clear();
    const main = this.#page.mainFrame();
    const resolved: DriverFrame[] = [];
    let counter = 0;

    for (const frame of this.#page.frames()) {
      const id = `f${(counter += 1)}`;
      this.#frames.set(id, frame);
      resolved.push({
        id,
        path: await this.#pathFor(frame),
        url: frame.url(),
        parentId: null,
      });
    }
    // Parent links are assigned after every frame has an id.
    const idByFrame = new Map([...this.#frames].map(([id, frame]) => [frame, id]));
    for (const entry of resolved) {
      const frame = this.#frames.get(entry.id);
      const parent = frame?.parentFrame() ?? null;
      entry.parentId = parent === null ? null : idByFrame.get(parent) ?? null;
    }
    return resolved;
  }

  async evaluate<T>(frame: DriverFrame, fnSource: string, arg?: unknown): Promise<T> {
    return (await this.#frame(frame).evaluate(
      `(${fnSource})(${JSON.stringify(arg ?? null)})`,
    )) as T;
  }

  async frameOwner(frame: DriverFrame): Promise<FrameOwner> {
    const handle = await this.#frame(frame).frameElement();
    try {
      // Passed as a real function: Playwright silently drops arguments when
      // given function *source*, which is what a string here would be.
      return await handle.evaluate(readFrameOwner);
    } finally {
      await handle.dispose();
    }
  }

  #frame(frame: DriverFrame): Frame {
    const resolved = this.#frames.get(frame.id);
    if (resolved === undefined) throw new Error(`Unknown frame: ${frame.path}`);
    return resolved;
  }

  async #pathFor(frame: Frame): Promise<string> {
    if (frame === this.#page.mainFrame()) return 'main';
    const segments: string[] = [];
    let cursor: Frame | null = frame;
    while (cursor !== null && cursor !== this.#page.mainFrame()) {
      const handle = await cursor.frameElement();
      try {
        segments.unshift((await handle.evaluate(readFrameOwner)).segment);
      } finally {
        await handle.dispose();
      }
      cursor = cursor.parentFrame();
    }
    return ['main', ...segments].join('/');
  }
}

const drivers = new WeakMap<Page, PlaywrightDriver>();
export function fromPlaywrightPage(page: Page): PlaywrightDriver {
  let driver = drivers.get(page);
  if (driver === undefined) { driver = new PlaywrightDriver(page); drivers.set(page, driver); }
  return driver;
}
