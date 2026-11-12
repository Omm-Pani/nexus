import { useState } from 'react';
import { type TimelineStep } from './interaction-timeline.js';

export function ActivityPanel({ steps, selectedStateId, onSelectState }: {
  steps: TimelineStep[];
  selectedStateId: string | null;
  onSelectState: (stateId: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const activeStepId = steps.find((step) => step.id === selectedStepId && step.stateIds.includes(selectedStateId ?? ''))?.id
    ?? [...steps].reverse().find((step) => step.stateIds.includes(selectedStateId ?? ''))?.id;
  const started = Date.parse(steps[0]?.timestamp ?? '') || 0;
  const visible = steps.map((step, index) => ({ step, index })).filter(({ step }) => `${step.title} ${step.kind === 'User' ? 'User_event' : 'System_action'} ${step.value ?? ''} ${step.changes.join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="activity-panel" aria-label="Action timeline">
    <div className="panel-heading"><h2>Interactions & changes</h2><p>User actions and system changes</p></div>
    <label className="activity-search"><span className="sr-only">Filter activity</span><input placeholder="Find an action or value…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
    <ol className="activity-list">
      {visible.length === 0 && <li className="zero-result">Actions appear here when they change the page.</li>}
      {visible.map(({ step, index }) => {
        const stateId = step.stateIds.at(-1)!;
        const selected = step.id === activeStepId;
        const elapsed = Math.max(0, ((Date.parse(step.timestamp) || started) - started) / 1000);
        return <li className={`activity-entry ${step.kind === 'User' ? 'activity-user' : 'activity-system'}${selected ? ' is-selected' : ''}`} key={step.id}>
          <button className="activity-step" type="button" onClick={() => { setSelectedStepId(step.id); onSelectState(stateId); }} aria-pressed={selected}>
            <span className="activity-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="activity-content"><strong>{step.kind === 'System' && <svg className="activity-bot" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3v3m-2-3h4M4 11H2m20 0h-2" /><rect x="4" y="6" width="16" height="14" rx="4" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><path d="M9 16h6" /></svg>}{step.title}</strong><span className="activity-meta">{step.kind === 'User' ? 'User_event' : 'System_action'} · +{elapsed.toFixed(1)}s</span>
              {step.responseTo !== undefined && <span className="activity-response">Response to {steps.find((item) => item.id === step.responseTo)?.title ?? 'user action'}</span>}
              {step.value !== undefined && <span className="activity-value">Value: {step.value === '' ? '(empty)' : step.value}</span>}
            </span>
          </button>
          {(step.lifecycle.length > 0 || step.changes.length > 0) && <details className="activity-details"><summary>Details</summary>
            {step.lifecycle.length > 0 && <ol>{step.lifecycle.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>}
            {step.changes.length > 0 && <p>State changes: {step.changes.join(' · ')}</p>}
          </details>}
        </li>;
      })}
    </ol>
  </section>;
}
