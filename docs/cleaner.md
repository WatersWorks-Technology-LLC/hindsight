# Document cleaner

The cleaner stages deterministic candidate copies for review. It preserves source
IDs, citations, URLs, dates, code fences, and bank boundaries. It does not infer
completed work from instructions or historical dates from ingestion metadata.

Open a bank's **Document cleaner** tab. **Clean bank** reads a verified starting
inventory, processes each document separately, and shows actual progress. Cancel,
resume, and retry retain private source snapshots and completed candidate reports.
Review a candidate's provenance, source offsets, diff, and coverage before export.
Partial batches require separate acknowledgment.

Heading spacing outside code fences is normalized. Boilerplate, exact duplicates,
and section overlap are reported for review; they are not automatically removed or
merged. Huge compilations split only at safe boundaries. Unsplit large sections
remain flagged. Classifications are lexical hints, not authoritative conclusions.

Possible secrets are masked in review copies and quarantine the document. Detection
is heuristic. Raw snapshots and versioned outputs remain private under ignored
`runs/`; do not commit or publish them. Prompt injection in a source is inert data.

## Runtime

The Control Plane uses its existing Next.js/React dependencies. The reusable
Python core uses the standard library; the typed public integration requires Python 3.11 or newer. Configure
`CLEANER_ROOT` to this repository root and optionally `CLEANER_PYTHON` to the desired
Python executable. The local utility accepts only a validated loopback dataplane.
Existing server-side dataplane configuration and authentication must be used;
credentials must not be included in browser responses, logs, or exported reports.

```sh
python3 -m cleaner preview documents.json --bank example --project example --output runs/demo
python3 -m unittest discover -s tests -p 'test_cleaner.py'
```

Normalized JSON documents require `id`, `bank_id`, `project_id`, and
`original_text`. Markdown/text input requires explicit bank and project flags.
Schema-1 document transfer ZIPs contain a `manifest.json` and `documents/*.json`;
facts and observations are not treated as document originals. Input entries are
bounded and read without extracting an archive to the filesystem.

## Guarded import

The import UI selects eligible reviewed candidates, prepares a dry-run plan with
immutable backups and hashes, and requires explicit bank confirmation. Additive
candidate versions retain the original source documents. Quarantine, omissions,
stale provenance, conflicting versions, and bank mismatches block execution.

Stock Hindsight 0.10.2 lacks the required atomic create/source-version checks
and conditional rollback. Install and independently verify the default-off
`cleaner-atomic-v1` API extension before enabling the local Control Plane opt-in
`CLEANER_ENABLE_ATOMIC_IMPORTS=1`. The API flag is
`HINDSIGHT_API_ENABLE_CLEANER_ATOMIC_WRITES=true`; the service owner must coordinate
backups, migration, provider compatibility and activation. Merely enabling the
UI flag does not permit writes: verified bank-scoped capabilities are also required.
There is no fallback to ordinary retain or unconditional document deletion.

Review the complete dry-run diff and backup summary, type the exact bank, and
acknowledge the plan before confirming import. Rollback requires a fresh plan
and a separate confirmation, and can remove only unchanged versions created by
that import. It cannot delete originals or preexisting documents.

A lost response is reconciled through a durable receipt. If no receipt becomes
available, the request remains uncertain and is never blindly replayed. A
rolled-back deterministic operation remains tombstoned: this version has no
restore action to re-import the same unchanged candidate. Private candidate
backups remain available for inspection. Each candidate is limited to 50,000
Unicode code points as well as the pinned atomic payload byte limit. These bounds
are checked before confirmation and again by the transport and API. Huge sections
may need manual splitting. Database lock waits are bounded; a
contention failure requires a fresh state check rather than an unconditional retry.

The guarded workflow has been tested with synthetic sources on an isolated real
API and migrated PostgreSQL. This documentation does not authorize applying any
real candidate; each real batch still requires the user's explicit UI action.

## Publication boundaries

The code-only contribution excludes runtime snapshots, bank exports, source
indexes, logs, screenshots, local activation scripts, and data-derived fixtures.
Tests use newly constructed generic strings. Local deployment receipts and sample
measurements are not part of the public contribution. This fork is a source
contribution; no hosting, credentials, model download, or production deployment is
included.
