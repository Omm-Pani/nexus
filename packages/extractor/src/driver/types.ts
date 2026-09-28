/**
 * The browser surface the extractor actually needs.
 *
 * Passive extraction only ever does six things: read the address and title,
 * install a document-start script, enumerate frames, evaluate a function inside
 * a frame, and evaluate a function against a frame's owning <iframe> element.
 * Naming that set explicitly is what lets the same extractor run against a
 * Playwright page in a container and against an Electron WebContentsView on the
 * desktop, with no branching inside the extractor itself.
 */
export interface DriverFrame {
  /** Driver-internal handle. Opaque to callers. */
  id: string;
  /**
   * Stable path used as the `frame` field on every extracted element:
   * `main`, `main/iframe#checkout`, `main/iframe:nth-of-type(2)`.
   */
  path: string;
  url: string;
  parentId: string | null;
}

export interface PageDriver {
  /** Identifies the backing implementation, for diagnostics and warnings. */
  readonly kind: 'playwright' | 'cdp';

  /** Current main-frame address. Synchronous: callers use it inside loops. */
  url(): string;

  title(): Promise<string>;
  prepareDom?(): Promise<void>;

  /**
   * Register a script to run before any page script in every document, present
   * and future. The extractor's instrumentation must win the race against
   * application startup or delegated listeners and closed shadow roots are
   * already lost by the time it installs.
   */
  addInitScript(source: string): Promise<void>;

  /** Attached frames, main frame first, with paths already resolved. */
  frames(): Promise<DriverFrame[]>;

  /**
   * Evaluate `fnSource` — the source text of a single function — inside the
   * frame's main world, with `arg` as its only parameter.
   *
   * Source text rather than a live function because CDP can only take a string
   * across the boundary. Playwright would accept the function directly, but a
   * port that admitted both would let callers write code only one driver runs.
   */
  evaluate<T>(frame: DriverFrame, fnSource: string, arg?: unknown): Promise<T>;

  /**
   * Measure and identify a frame's owning <iframe> element, from the parent
   * document.
   *
   * A semantic operation rather than a generic "evaluate against the owner",
   * because the generic form would have to ship function source into the page
   * and `eval` it — which any application with a strict CSP forbids, and those
   * are exactly the applications worth extracting. Each driver implements this
   * with whatever its own transport already allows.
   */
  frameOwner(frame: DriverFrame): Promise<FrameOwner>;
}

export interface FrameOwner {
  /** Path segment identifying this frame within its parent: `iframe#checkout`. */
  segment: string;
  /** Content-box origin and size in the parent's viewport coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isPageDriver(value: unknown): value is PageDriver {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<PageDriver>;
  return typeof candidate.kind === 'string'
    && typeof candidate.frames === 'function'
    && typeof candidate.evaluate === 'function'
    && typeof candidate.addInitScript === 'function';
}
