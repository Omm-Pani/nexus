import { useEffect, useState, type ReactNode } from 'react';
import type { StateArtifact } from '@nexus/schema';

export interface Recording {
  id: string; name: string; url: string; createdAt: string; stoppedAt: string | null;
  status: 'recording' | 'stopped' | 'interrupted';
}
export interface SavedRecording { recording: Recording; artifacts: StateArtifact[] }
export async function recordingRequest<T>(channel: string, payload?: unknown): Promise<T> {
  if (!window.nexus) throw new Error('Recordings are available in the desktop app.');
  return await window.nexus.invoke(channel, payload) as T;
}

export function RecordingNameDialog({ onCancel, onStart }: {
  onCancel: () => void; onStart: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="recording-dialog-backdrop"><form role="dialog" aria-modal="true" aria-labelledby="recording-dialog-title" className="recording-dialog" onSubmit={(event) => {
    event.preventDefault(); setBusy(true); setError(null);
    void onStart(name.trim()).catch((error: unknown) => { setError(error instanceof Error ? error.message : 'Could not start recording.'); setBusy(false); });
  }} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onCancel();
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    } }}>
    <h2 id="recording-dialog-title">Name your recording</h2>
    <p>Save discovered elements, page groups, and states as you browse.</p>
    <label>Recording name<input autoFocus required maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="Checkout flow" /></label>
    {error && <p role="alert">{error}</p>}
    <div className="recording-actions"><button type="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" disabled={busy || !name.trim()}>{busy ? 'Starting…' : 'Start recording'}</button></div>
  </form></div>;
}

export function RecordingsPage({ onBack, renderDetails, activeRecordingId, onStop, stopping, recordingError }: {
  activeRecordingId: string | null; onStop: () => void; stopping: boolean; recordingError: string | null;
  onBack: () => void; renderDetails: (saved: SavedRecording) => ReactNode;
}) {
  const [items, setItems] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<SavedRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setLoading(true); setError(null);
    try {
      setItems(await recordingRequest<Recording[]>('recordings.list'));
      if (selected !== null) setSelected(await recordingRequest<SavedRecording>('recordings.read', { id: selected.recording.id }));
    }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not load recordings.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [activeRecordingId]);
  return <main className="recordings-page">
    <header className="recordings-header"><div><h1>Recordings</h1><p>Saved page groups, states, and discovered elements.</p></div><div className="recording-actions">{activeRecordingId !== null && <button type="button" disabled={stopping} onClick={onStop}>{stopping ? 'Saving…' : 'Stop recording'}</button>}<button type="button" onClick={() => void load()} disabled={loading || busy}>Refresh</button><button type="button" onClick={onBack}>Back to inspector</button></div></header>
    {(error || recordingError) && <p role="alert" className="recording-error">{error || recordingError}</p>}
    <div className="recordings-layout"><section className="recordings-list" aria-label="Saved recordings">
      {loading && <p>Loading recordings…</p>}
      {!loading && items.length === 0 && <p>No recordings yet. Use Load &amp; Extract to create one.</p>}
      {items.map((item) => <article className={`recording-card${selected?.recording.id === item.id ? ' is-selected' : ''}`} key={item.id}>
        <button type="button" className="recording-open" disabled={busy} onClick={() => {
          setBusy(true); setError(null);
          void recordingRequest<SavedRecording>('recordings.read', { id: item.id }).then(setSelected)
            .catch((error: unknown) => setError(error instanceof Error ? error.message : 'Could not open recording.')).finally(() => setBusy(false));
        }}><strong>{item.name}</strong><span>{item.url}</span><small>{new Date(item.createdAt).toLocaleString()} · {item.status}</small></button>
        {editing === item.id ? <form onSubmit={(event) => {
          event.preventDefault(); setBusy(true); setError(null);
          void recordingRequest<Recording>('recordings.rename', { id: item.id, name: name.trim() }).then((updated) => {
            setItems((current) => current.map((recording) => recording.id === updated.id ? updated : recording));
            setSelected((current) => current?.recording.id === updated.id ? { ...current, recording: updated } : current);
            setEditing(null);
          }).catch((error: unknown) => setError(error instanceof Error ? error.message : 'Could not rename recording.')).finally(() => setBusy(false));
        }}><label>Recording name<input autoFocus maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label><div className="recording-actions"><button disabled={busy || !name.trim()} type="submit">Save name</button><button disabled={busy} type="button" onClick={() => setEditing(null)}>Cancel</button></div></form>
          : <button type="button" disabled={busy} onClick={() => { setEditing(item.id); setName(item.name); }}>Rename recording</button>}
      </article>)}
    </section><section className="recording-detail" aria-label="Recording details">
      {selected ? <><h2>{selected.recording.name}</h2><p>{selected.artifacts.length} captured state{selected.artifacts.length === 1 ? '' : 's'}</p>{selected.artifacts.length ? renderDetails(selected) : <p>No states have been saved yet. Refresh and reopen after a capture finishes.</p>}</> : <p>Select a recording to inspect its saved page groups and states.</p>}
    </section></div>
  </main>;
}
