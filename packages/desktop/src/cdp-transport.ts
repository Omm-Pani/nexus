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
  readonly #pending = new Set<{ method: string; sessionId: string | undefined; reject(error: Error): void }>();

  #cancelPending(message: string, sessionId?: string, evaluationsOnly = false): void {
    for (const pending of this.#pending) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      if (evaluationsOnly && !['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(pending.method)) continue;
      pending.reject(new Error(message));
    }
  }

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
      if (method === 'Runtime.executionContextsCleared') {
        this.#cancelPending('The document changed during evaluation.', sessionId || undefined, true);
      }
      if (method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') {
        this.#cancelPending('The frame detached during extraction.', params.sessionId);
      }
      for (const handler of this.#handlers) {
        handler(method, (params ?? {}) as Record<string, unknown>, sessionId || undefined);
      }
    });
    this.#debugger.on('detach', () => {
      this.#cancelPending('The page debugger disconnected.');
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: { method: string; sessionId: string | undefined; reject(error: Error): void } | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      pending = { method, sessionId, reject };
      this.#pending.add(pending);
      timer = setTimeout(() => reject(new Error(`Page inspection timed out: ${method}`)), 12_000);
    });
    try {
      return await Promise.race([this.#debugger.sendCommand(method, params, sessionId), interrupted]) as T;
    } finally {
      clearTimeout(timer);
      if (pending !== undefined) this.#pending.delete(pending);
    }
  }

  on(handler: CdpEventHandler): void {
    this.#handlers.add(handler);
  }

  off(handler: CdpEventHandler): void {
    this.#handlers.delete(handler);
  }
}
