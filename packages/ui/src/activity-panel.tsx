import { useMemo, useState } from 'react';
import { buildInteractionTimeline, type ActivityEvent, type TimelineState } from './interaction-timeline.js';

export function ActivityPanel({ events, states, selectedStateId, onSelectState }: {
  events: ActivityEvent[];
  states: TimelineState[];
  selectedStateId: string | null;
  onSelectState: (stateId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const steps = useMemo(() => buildInteractionTimeline(events, states), [events, states]);
  const activeStepId = steps.find((step) => step.id === selectedStepId && step.stateIds.includes(selectedStateId ?? ''))?.id
    ?? [...steps].reverse().find((step) => step.stateIds.includes(selectedStateId ?? ''))?.id;
  const started = Date.parse(steps[0]?.timestamp ?? '') || 0;
  const visible = steps.map((step, index) => ({ step, index })).filter(({ step }) => `${step.title} ${step.kind} ${step.value ?? ''} ${step.changes.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="activity-panel" aria-label="Action timeline">
    <div className="panel-heading"><h2>Interactions & changes</h2><p>User actions and system changes</p></div>
    <label className="activity-search"><span className="sr-only">Filter activity</span><input placeholder="Find an action or value…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
    <ol className="activity-list">
      {visible.length === 0 && <li className="zero-result">Actions appear here when they change the page.</li>}
      {visible.map(({ step, index }) => {
        const stateId = step.stateIds.at(-1)!;
        const selected = step.id === activeStepId;
        const elapsed = Math.max(0, ((Date.parse(step.timestamp) || started) - started) / 1000);
        return <li className={`activity-entry${selected ? ' is-selected' : ''}`} key={step.id}>
          <button className="activity-step" type="button" onClick={() => { setSelectedStepId(step.id); onSelectState(stateId); }} aria-pressed={selected}>
            <span className="activity-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="activity-content"><strong>{step.title}</strong><span className="activity-meta">{step.kind} · +{elapsed.toFixed(1)}s</span>
              {step.value !== undefined && <span className="activity-value">Value: {step.value === '' ? '(empty)' : step.value}</span>}
            </span>
          </button>
          {(step.lifecycle.length > 0 || step.changes.length > 0) && <details className="activity-details"><summary>Details</summary>
            {step.lifecycle.length > 0 && <ol>{step.lifecycle.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>}
            {step.changes.length > 0 && <p>System changes: {step.changes.join(' · ')}</p>}
          </details>}
        </li>;
      })}
    </ol>
  </section>;
}
