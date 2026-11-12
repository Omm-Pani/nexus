import type { OrchestratorEvent, StateArtifact } from '@nexus/schema';

/**
 * How the observer UI reaches the browser it is inspecting.
 *
 * The web build talks to the orchestrator over HTTP and a WebSocket. The
 * desktop build talks to the Electron main process over IPC and does not
 * stream frames at all, because the page is a native view composited under the
 * centre pane. Naming the seam keeps that difference in one file instead of
 * spread through the component tree.
 */
export interface NexusTransport {
  readonly mode: 'web' | 'desktop';
  createSession(url: string): Promise<string>;
  goto(sessionId: string, url: string): Promise<void>;
  resetHistory(sessionId: string): Promise<Extract<OrchestratorEvent, { t: 'history.reset' }>>;
  pageNames(sessionId: string): Promise<Record<string, string>>;
  renamePage(sessionId: string, url: string, name: string | null): Promise<Record<string, string>>;
  states(sessionId: string): Promise<unknown>;
  state(sessionId: string, stateId: string): Promise<StateArtifact>;
  sendInput(sessionId: string, payload: unknown): Promise<void>;
  subscribe(sessionId: string, onEvent: (event: OrchestratorEvent) => void, onStatus: (status: 'live' | 'offline') => void): () => void;
  /**
   * Desktop only: report where the page should be drawn, in CSS pixels
   * relative to the window. The native view cannot be positioned by the DOM,
   * so the renderer has to tell the main process where the hole is.
   */
  setViewBounds?(bounds: { x: number; y: number; width: number; height: number } | null): void;
  /** Desktop only: whether the page view currently has an active document. */
  readonly rendersNatively: boolean;
  /**
   * Desktop only: draw highlight boxes inside the page. A native view sits
   * above the renderer's DOM, so the boxes cannot be drawn from here.
   */
  highlight?(sessionId: string, items: HighlightBox[]): Promise<void>;
}

export interface HighlightBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  tone?: string;
  primary?: boolean;
  frame?: string;
  selector?: string;
  shadowPath?: string[];
}

export interface DesktopBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  subscribe(handler: (event: OrchestratorEvent) => void): () => void;
  setViewBounds(bounds: { x: number; y: number; width: number; height: number } | null): void;
}

declare global {
  interface Window {
    nexus?: DesktopBridge;
  }
}

async function parse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length === 0) return null;
  try { return JSON.parse(body) as unknown; } catch { return body; }
}

function messageFrom(payload: unknown, fallback: string, seen = new Set<unknown>()): string {
  if (typeof payload === 'string') return payload.trim() === '' ? fallback : payload.trim();
  if (typeof payload !== 'object' || payload === null || seen.has(payload)) return fallback;
  seen.add(payload);
  const record = payload as Record<string, unknown>;
  for (const key of ['message', 'detail', 'error', 'cause', 'reason']) {
    if (record[key] !== undefined) {
      const nested = messageFrom(record[key], fallback, seen);
      if (nested !== fallback) return nested;
    }
  }
  return fallback;
}

export class HttpTransport implements NexusTransport {
  readonly mode = 'web' as const;
  readonly rendersNatively = false;

  readonly #base: string;

  constructor(base: string) {
    this.#base = base.replace(/\/$/, '');
  }

  #url(path: string): string { return `${this.#base}${path}`; }

  async #request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(this.#url(path), init);
    const payload = await parse(response);
    if (!response.ok) {
      throw new Error(messageFrom(payload, `Request failed (${response.status}).`));
    }
    return payload;
  }

  async createSession(url: string): Promise<string> {
    const payload = await this.#request('/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId !== 'string') throw new Error('The backend did not return a session ID.');
    return sessionId;
  }

  async goto(sessionId: string, url: string): Promise<void> {
    await this.#request(`/session/${encodeURIComponent(sessionId)}/goto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  }

  async pageNames(sessionId: string): Promise<Record<string, string>> {
    return await this.#request(`/session/${encodeURIComponent(sessionId)}/page-names`) as Record<string, string>;
  }

  async renamePage(sessionId: string, url: string, name: string | null): Promise<Record<string, string>> {
    return await this.#request(`/session/${encodeURIComponent(sessionId)}/page-names`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, name }),
    }) as Record<string, string>;
  }

  async states(sessionId: string): Promise<unknown> {
    return this.#request(`/session/${encodeURIComponent(sessionId)}/states`);
  }

  async resetHistory(sessionId: string): Promise<Extract<OrchestratorEvent, { t: 'history.reset' }>> {
    return await this.#request(`/session/${encodeURIComponent(sessionId)}/reset-history`, { method: 'POST' }) as Extract<OrchestratorEvent, { t: 'history.reset' }>;
  }

  async state(sessionId: string, stateId: string): Promise<StateArtifact> {
    return (await this.#request(
      `/session/${encodeURIComponent(sessionId)}/state/${encodeURIComponent(stateId)}`,
    )) as StateArtifact;
  }

  async sendInput(sessionId: string, payload: unknown): Promise<void> {
    await this.#request(`/session/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  subscribe(
    sessionId: string,
    onEvent: (event: OrchestratorEvent) => void,
    onStatus: (status: 'live' | 'offline') => void,
  ): () => void {
    const target = new URL(this.#url(`/session/${encodeURIComponent(sessionId)}/stream`), window.location.href);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(target.href);
    socket.addEventListener('open', () => onStatus('live'));
    socket.addEventListener('close', () => onStatus('offline'));
    socket.addEventListener('error', () => onStatus('offline'));
    socket.addEventListener('message', (message) => {
      try { onEvent(JSON.parse(String(message.data)) as OrchestratorEvent); } catch { /* ignore malformed frames */ }
    });
    return () => socket.close();
  }
}

/** Talks to the Electron main process. No frames: the page is a native view. */
export class DesktopTransport implements NexusTransport {
  readonly mode = 'desktop' as const;
  readonly rendersNatively = true;

  readonly #bridge: DesktopBridge;

  constructor(bridge: DesktopBridge) {
    this.#bridge = bridge;
  }

  async createSession(url: string): Promise<string> {
    return (await this.#bridge.invoke('session.create', { url })) as string;
  }

  async goto(sessionId: string, url: string): Promise<void> {
    await this.#bridge.invoke('session.goto', { sessionId, url });
  }

  async resetHistory(sessionId: string): Promise<Extract<OrchestratorEvent, { t: 'history.reset' }>> {
    return await this.#bridge.invoke('session.resetHistory', { sessionId }) as Extract<OrchestratorEvent, { t: 'history.reset' }>;
  }

  async pageNames(sessionId: string): Promise<Record<string, string>> {
    return await this.#bridge.invoke('session.pageNames', { sessionId }) as Record<string, string>;
  }

  async renamePage(sessionId: string, url: string, name: string | null): Promise<Record<string, string>> {
    return await this.#bridge.invoke('session.renamePage', { sessionId, url, name }) as Record<string, string>;
  }

  async states(sessionId: string): Promise<unknown> {
    return this.#bridge.invoke('session.states', { sessionId });
  }

  async state(sessionId: string, stateId: string): Promise<StateArtifact> {
    return (await this.#bridge.invoke('session.state', { sessionId, stateId })) as StateArtifact;
  }

  async sendInput(sessionId: string, payload: unknown): Promise<void> {
    await this.#bridge.invoke('session.input', { sessionId, payload });
  }

  subscribe(
    _sessionId: string,
    onEvent: (event: OrchestratorEvent) => void,
    onStatus: (status: 'live' | 'offline') => void,
  ): () => void {
    onStatus('live');
    return this.#bridge.subscribe(onEvent);
  }

  setViewBounds(bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.#bridge.setViewBounds(bounds);
  }

  async highlight(_sessionId: string, items: HighlightBox[]): Promise<void> {
    await this.#bridge.invoke(
      items.length === 0 ? 'view.clearHighlight' : 'view.highlight',
      { items },
    );
  }
}

export function createTransport(apiBase: string): NexusTransport {
  const bridge = typeof window === 'undefined' ? undefined : window.nexus;
  return bridge === undefined ? new HttpTransport(apiBase) : new DesktopTransport(bridge);
}
