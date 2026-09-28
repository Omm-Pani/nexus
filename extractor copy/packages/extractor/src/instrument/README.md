# Instrumentation

`bootstrap.ts` discovers semantic controls, values, and collections.
`dom.ts` adds the unfiltered DOM inventory and passive observation journal.
`index.ts` composes both into one idempotent document-start script.

Closed roots retained at creation or recovered through CDP are registered with
both runtimes. Document and shadow-root observers never generate page gestures.
