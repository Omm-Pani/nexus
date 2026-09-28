import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DomObservation, OrchestratorEvent, StateArtifact } from '@nexus/schema';

/** Durable, ordered observations independent of snapshot debounce and UI history. */
export class ObservationJournal {
  #sequence = 0;
  #committed = 0;
  #queue: Promise<void> = Promise.resolve();
  readonly #seen = new Map<string, number>();
  constructor(
    private readonly directory: string,
    private readonly publish: (event: OrchestratorEvent) => void,
    private readonly onError: (error: unknown) => void,
  ) {}
  get sequence(): number { return this.#sequence; }

  receive(payload: unknown, fromStateId: string | null): boolean {
    let value = payload;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return false; } }
    if (!Array.isArray(value)) return false;
    const observations: DomObservation[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const observation = entry as DomObservation;
      if (typeof observation.documentId !== 'string' || !Number.isSafeInteger(observation.sequence)
        || typeof observation.type !== 'string' || typeof observation.timestamp !== 'string'
        || typeof observation.url !== 'string' || !['interaction', 'mutation', 'property', 'navigation', 'gap'].includes(observation.kind)
        || (observation.targetId !== null && typeof observation.targetId !== 'string')
        || observation.detail === null || typeof observation.detail !== 'object') continue;
      if (observation.sequence <= (this.#seen.get(observation.documentId) ?? 0)) continue;
      this.#seen.set(observation.documentId, observation.sequence);
      observations.push(observation);
    }
    if (observations.length === 0) return false;
    const firstSequence = this.#sequence + 1;
    this.#sequence += observations.length;
    this.#emit({ t: 'dom.observed', batch: { fromStateId, firstSequence, lastSequence: this.#sequence, observations } });
    return true;
  }

  commit(fromStateId: string | null, toStateId: string, through: number, trigger: string): void {
    if (through <= this.#committed && fromStateId === toStateId) return;
    this.#emit({ t: 'state.transition', fromStateId, toStateId, firstSequence: this.#committed + 1, lastSequence: through, trigger, timestamp: new Date().toISOString() });
    this.#committed = Math.max(this.#committed, through);
  }

  reset(artifact: StateArtifact, throughSequence: number): Extract<OrchestratorEvent, { t: 'history.reset' }> {
    const event: Extract<OrchestratorEvent, { t: 'history.reset' }> = { t: 'history.reset', resetId: randomUUID(), artifact, throughSequence, timestamp: new Date().toISOString() };
    this.#committed = throughSequence;
    this.#emit(event);
    this.commit(null, artifact.stateId, throughSequence, 'history reset');
    return event;
  }

  #emit(event: OrchestratorEvent): void {
    this.publish(event);
    this.#queue = this.#queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await appendFile(join(this.directory, 'observations.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    }).catch(this.onError);
  }
  async close(): Promise<void> { await this.#queue; }
}
