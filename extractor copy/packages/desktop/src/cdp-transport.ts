import type { Debugger, WebContents } from 'electron';

import type { CdpEventHandler, CdpTransport } from '@nexus/extractor';

/**
 * Adapts Electron's `webContents.debugger` to the driver's CDP transport.
 *
 * Electron delivers protocol events with the session id as a trailing
 * argument, which is exactly what flat auto-attach needs to reach
 * out-of-process iframes, so the shape lines up with no translation beyond
 * argument order.
 */
export class ElectronCdpTransport implements CdpTransport {
  readonly #debugger: Debugger;
  readonly #handlers = new Set<CdpEventHandler>();
  #attached = false;

  constructor(contents: WebContents) {
    if (contents.debugger === undefined) {
      throw new Error('This WebContents exposes no debugger; CDP is unavailable.');
    }
    this.#debugger = contents.debugger;
  }

  /**
   * Attach the protocol. Fails loudly when DevTools already holds the target:
   * only one debugger client is allowed per WebContents, and silently running
   * without one would look like extraction quietly finding nothing.
   */
  attach(): void {
    if (this.#attached) return;
    this.#debugger.attach('1.3');
    this.#attached = true;
    this.#debugger.on('message', (_event, method, params, sessionId) => {
      for (const handler of this.#handlers) {
        handler(method, (params ?? {}) as Record<string, unknown>, sessionId || undefined);
      }
    });
    this.#debugger.on('detach', () => {
      this.#attached = false;
    });
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    try { this.#debugger.detach(); } catch { /* already gone */ }
    this.#handlers.clear();
  }

  get attached(): boolean {
    return this.#attached;
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    return (await this.#debugger.sendCommand(method, params, sessionId)) as T;
  }

  on(handler: CdpEventHandler): void {
    this.#handlers.add(handler);
  }

  off(handler: CdpEventHandler): void {
    this.#handlers.delete(handler);
  }
}
