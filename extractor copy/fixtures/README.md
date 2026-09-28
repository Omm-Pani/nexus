# Hand-labelled fixture corpus

`manifest.json` is the Phase 1 fixture index. Every entry points to a manually
authored expectation file containing semantic control, observable, and
collection matchers. These are intentionally not generated from extractor
output: they are the acceptance oracle for later phases.

Matchers use `selector` to identify the expected DOM facts. A control's `label`
is exact unless `labelPattern` is present; patterns apply to
whitespace-normalized accessible names. Observable `initialValue` and
`valuePattern` apply to text content. `minimumMatches` expresses template
expectations without enumerating every repeated row. Every control includes the
expected element type, action kind, and risk. Collection rejection is explicit
so a positive-only test cannot miss a false navigation collection.

The SauceDemo entry is live and documents its login/seed precondition. All other
fixtures are static and can be served from this directory. `iframe-composed.html`
derives a second origin by switching between `127.0.0.1` and `localhost` while
retaining the current port; serving through either hostname therefore exercises
both same-origin and cross-origin frames.

Phase 1 tests validate the corpus contract only. Extraction assertions begin
with instrumentation and walking in Phases 2 and 3.
