# Extractor transfer bundle

Copy this entire `extractor copy` folder to the destination machine or project.
It is a self-contained source workspace with the original package layout and
dependency lockfile. No source files outside this folder are required.
Dependencies and browser binaries must be installed before running it.

## What is included

| Path | Responsibility | Needed for |
| --- | --- | --- |
| `packages/schema` | Element, group, collection, state, and observation contracts | All integrations |
| `packages/extractor` | Instrumentation, DOM snapshots, semantic labels and grouping, identity, iframe/shadow traversal, browser drivers, and observation journal | All integrations |
| `packages/orchestrator` | Playwright sessions, continuous capture scheduling, state history, HTTP/WebSocket server, and snapshot CLI | Node/browser service integration |
| `packages/desktop` | Electron session integration and CDP transport, plus a runnable desktop shell | Electron integration |
| `packages/ui` | Named controls, semantic groups, collection tables, type colors, highlighting, and interaction timeline | Replicating the current display |
| `fixtures` and package `test` folders | Example pages and regression tests | Understanding and checking behavior |

The engine and schema are the minimum extraction packages. The other packages
are included so the receiving app has working examples of the live lifecycle
and semantic display, rather than just a snapshot function.

## Run this workspace

Requirements: Node.js 20 or newer and pnpm 10.15.1 (declared in `package.json`).

From this folder:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nexus/orchestrator exec playwright install chromium
pnpm build
pnpm serve
```

Open `http://127.0.0.1:4711` for the web app. Use `pnpm desktop` for Electron.
If pnpm reports blocked dependency build scripts, approve the required Electron
and esbuild scripts with `pnpm approve-builds`, then run `pnpm rebuild`.

Verification commands:

```sh
pnpm typecheck
pnpm test
```

These tests use fixture pages to exercise extraction; they do not introduce an
automation/enactor feature into the product.

## Integrate into another app

Keep this workspace separate initially so its relative paths and package names
continue to work. Do not overwrite an existing app's package.json or lockfile.
If moving packages into that app's workspace, merge their dependencies and
adapt `workspace:*`, TypeScript references, and root configuration paths.

### Extraction API

Read `packages/extractor/src/index.ts` first. Its public exports include
`installInstrumentation`, `scanState`, `ObservationJournal`, `CdpDriver`, and
artifact-writing helpers. The engine is Node-based; it is not a browser-only
React library.

The single-snapshot lifecycle is:

1. Obtain a Playwright page or supported browser driver.
2. Install instrumentation before navigating to the target page.
3. Navigate and call `scanState(pageOrDriver)`.
4. Consume the returned `StateArtifact`.

For a runnable snapshot command in this workspace:

```sh
pnpm nexus extract https://example.com --out ./.nexus
```

### Continuous interactions and state changes

A snapshot call alone does not provide the complete live session behavior.
Adapt one of the included host implementations:

- Playwright: `packages/orchestrator/src/session-manager.ts`, with its
  `protocol.ts` types. Copy the whole orchestrator package for the HTTP/WebSocket API.
- Electron: `packages/desktop/src/session.ts` and
  `packages/desktop/src/cdp-transport.ts`.

Preserve the host wiring for observation delivery, document/frame lifecycle,
capture scheduling, state comparison, journal commits, and cleanup. The journal
stores intervening observations even when multiple events share one snapshot.

### Semantic display

Render `StateArtifact.groups`, `actions`, `observables`, `collections`, and
`componentTree` for named controls such as Username and Password, meaningful
page sections, and repeated-item tables. Keep complete semantic groups visible
in each state, including unchanged controls.

`StateArtifact.dom` is the exhaustive underlying DOM capture. It is not the
source for a raw HTML-tag list in Discovered Elements.

The current display is implemented by `packages/ui/src/App.tsx`,
`component-tree.ts`, `semantic-tree.ts`, `collection-table.ts`, `styles.css`,
`hover-target.ts`, `interaction-timeline.ts`, and `activity-panel.tsx`. Adapt `transport.ts` to connect your
app's backend. Rendering can be rewritten in another UI framework while keeping
the same semantic artifact contracts.

## Implementation map

- `extractor/src/instrument/bootstrap.ts`: semantic discovery, naming,
  classification, grouping, collection detection, and browser instrumentation.
- `extractor/src/instrument/dom.ts`: exhaustive DOM capture and passive
  interaction/mutation/property observation.
- `extractor/src/instrument/index.ts`: combined document-start instrumentation.
- `extractor/src/component-tree/index.ts`: semantic hierarchy construction.
- `extractor/src/driver/`: Playwright/CDP access, frames, and shadow-root recovery.
- `extractor/src/identity/` and `ids.ts`: state and element identities.
- `extractor/src/observe/journal.ts`: ordered observations and state transitions.
- `extractor/src/artifact/`: snapshot and manifest persistence.
- `schema/src/index.ts`: shared contracts.

Paths above are relative to `packages/` unless already prefixed with it.
The `group/`, `classify/`, `walk/`, and `locator/` directories contain explanatory
READMEs; copying those directories alone does not transfer their implementation.

## Boundaries to preserve

Browser privileges matter: cross-origin frames and closed shadow-root recovery
use the supplied browser/CDP integrations. A plain script pasted into another
website does not have equivalent access. Install instrumentation before page
startup to observe subsequent events. Full coverage is bounded by attached
documents, available DOM, traversal limits, and observation buffers; retain the
coverage warnings and gap records. Entered values, including passwords, are recorded without redaction. See `README.md` for the existing coverage limits.

No installed dependencies, generated build output, browser binaries, saved
sessions, credentials, or machine-specific app data are included.
