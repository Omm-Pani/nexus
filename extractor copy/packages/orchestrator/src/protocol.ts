import type {
  OrchestratorEvent,
  StateArtifact,
} from '@nexus/schema';

export interface SessionCredentials {
  username: string;
  password: string;
}

export interface CreateSessionRequest {
  url: string;
  credentials?: SessionCredentials;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface GotoRequest {
  url: string;
}

export type MouseInputType =
  | 'mousePressed'
  | 'mouseReleased'
  | 'mouseMoved'
  | 'mouseWheel';

export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';

export interface MouseInputCommand {
  kind: 'mouse';
  type: MouseInputType;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

export type KeyInputType = 'keyDown' | 'keyUp' | 'char';

export interface KeyInputCommand {
  kind: 'key';
  type: KeyInputType;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
}

/**
 * Raw CDP input remains useful to non-UI clients. It is deliberately limited
 * to the two Input-domain methods the normalized commands map to.
 */
export interface RawInputCommand {
  method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent';
  params: Record<string, unknown>;
}

export type InputCommand = MouseInputCommand | KeyInputCommand | RawInputCommand;

export type StateStatus = 'extracting' | 'ready' | 'stale' | 'error';

export interface SessionStateIndexEntry {
  stateId: string;
  url: string;
  title: string;
  capturedAt: string;
  status: StateStatus;
  parentStateId?: string;
  trigger?: string;
}

export interface SessionStateIndex {
  sessionId: string;
  currentStateId: string | null;
  states: SessionStateIndexEntry[];
  lastError: string | null;
}

export interface AcceptedResponse {
  accepted: true;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface SessionSnapshot {
  index: SessionStateIndex;
  artifacts: ReadonlyMap<string, StateArtifact>;
  events: readonly OrchestratorEvent[];
  latestFrame: Extract<OrchestratorEvent, { t: 'frame' }> | null;
}
