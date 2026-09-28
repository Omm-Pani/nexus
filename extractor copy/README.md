# Nexus DOM Extractor

Nexus is a passive browser inspector. Load a page, interact with it yourself,
and inspect its elements, interactions, mutations, and captured states.
There are no model providers, scenario runners, automatic clicks, or probing.

## Run

```bash
pnpm install
pnpm --filter @nexus/orchestrator exec playwright install chromium
pnpm start
# Open http://127.0.0.1:4711

pnpm desktop
```

The desktop app embeds the page in a native browser view. The web app displays
its browser through a screencast and forwards your mouse and keyboard input.

Use **Reset history** beside Load & Extract to clear both inspection panes and
make a fresh snapshot of the current page the new initial state. It does not
reload or navigate the page, clear storage, or reset form values. Subsequent
actions start a new visible history; reconnecting retains this reset boundary.

## What is captured

- **Discovered Elements** shows named controls and content in semantic page
  sections, with type colors and tables for repeated collections. Each captured
  state shows its full semantic hierarchy. Select an element for technical details.
- Full DOM snapshots remain in the extraction artifacts, including static markup,
  hidden elements, template contents, SVG, and nested open or closed shadow roots.
  Raw HTML nodes are not listed in the semantic display.
- Elements retain document-local identities, parent links, frame and shadow
  paths, attributes, direct text, form/media state, listeners known to the
  instrumentation, visibility, and viewport geometry.
- **Interactions & changes** groups confirmed user actions and system changes
  into a numbered timeline. A field entry stays one step across spaces,
  punctuation, pauses, and multiple captures; its details include focus and
  unfocus. Click a step to inspect the corresponding state in the left panel.
  Interactions without a captured change are omitted, including pointer noise.
  Hover actions appear when they change the captured DOM. Synchronous effects
  retain their source event; independent updates appear as system steps.
- Mutation records preserve intermediate attribute/text values and transient
  added/removed subtrees even when several changes occur between snapshots.
- State fingerprints include DOM structure, attributes, text, and properties.
  Captures remain grouped by their exact page URL. Transitions record the
  observation sequence covered by each capture, including interactions that
  leave the state unchanged.

Instrumentation starts before navigation. Chromium's pierced DOM protocol
recovers declarative and pre-existing closed shadow roots. Frames are scanned
independently, including cross-origin frames. The desktop driver attaches
individual iframe targets without global target auto-attachment.

## Artifacts

Web sessions write to `.nexus/sessions/<sessionId>`. Desktop sessions use the
Electron application data directory's `sessions` folder.

- `states/<stateId>.json`: semantic inventory and full `dom` snapshots.
- `observations.jsonl`: ordered observation batches and state transitions.
- `manifest.json` and `warnings.json`: captured states and coverage diagnostics.

The journal retains the session's full received observation history; the UI
shows the grouped action timeline. Entered values, including passwords, are
recorded without redaction. The center browser keeps the page's own rendering.

```bash
pnpm nexus extract https://example.com --out ./.nexus
pnpm typecheck
pnpm test
```

The CLI produces a single snapshot. Use a live web or desktop session to record
interaction history. Tests drive fixture pages solely to verify extraction.

## Coverage boundaries

The inventory describes DOM that exists. Content mounted only after an
interaction appears when you perform that interaction. Browser-internal UI,
canvas pixels, and arbitrary application JavaScript state are not DOM elements.
Events that occur before instrumentation attaches to a document cannot be
recovered retroactively. CSS animation frames and arbitrary custom property
writes are not a complete application-state log.

Snapshots are coalesced to keep browsing responsive; the observation journal
retains the intervening records. Inaccessible or detached frames and bounded
semantic walks produce explicit warnings. A disconnected observation consumer
has a bounded in-page buffer; overflow is recorded as a coverage gap.

## Packages

- `@nexus/schema`: extraction and observation contracts.
- `@nexus/extractor`: instrumentation, DOM inventory, semantic grouping,
  identity, read-only browser drivers, and artifact persistence.
- `@nexus/orchestrator`: browser sessions, extraction scheduling, HTTP/WebSocket
  transport, manual input forwarding, and CLI.
- `@nexus/desktop`: Electron browser shell and live extraction.
- `@nexus/ui`: element/state inspection and the observation timeline.
