# Observation journal

`ObservationJournal` validates and deduplicates document observations, assigns
session sequence numbers, publishes live events, and serializes append-only
writes to `observations.jsonl`. Captures record their covered sequence range as
state transitions. Browser-side mutation and event collection lives in
`../instrument/dom.ts`.
