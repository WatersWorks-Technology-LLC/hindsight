# Guarded additive cleaner imports

Implemented protocol: `cleaner-atomic-v1`. Disabled by default via
`HINDSIGHT_API_ENABLE_CLEANER_ATOMIC_WRITES=false`. Enable only after the owner
reviews the migration and verifies the installed engine and clients. PostgreSQL
SQL-owned document stores and an already configured local/ONNX embedding
provider are required. No model is selected or downloaded by this feature.

The bank-scoped cleaner endpoints create one new literal candidate version per
operation. Originals are never replaced. Requests bind exact backed-up UTF-8
payload bytes, a source body/version/provenance digest, expected execution
configuration, a new target ID, ownership and a stable operation UUID. Source
checks, a create-only INSERT and a durable server-owned receipt commit together.
A matching replay returns the same operation; a changed binding is conflict.

The normal retain/import/DELETE routes are not fallbacks. In particular, the
existing transfer `skip` check is outside the subsequent replace transaction.

Payloads contain exactly one item, with `timestamp="unset"`. Each candidate is
limited to 50,000 Unicode code points (astral characters count once), independently
of the 8 MiB UTF-8 payload-byte limit. Oversize candidates are rejected before
embedding or persistence; split large compilations before planning an import.
These are per-request admission bounds, not a global semaphore for concurrent
embedding calls. The local utility submits candidates sequentially; another
client can issue concurrent requests. Owner admission and provider capacity still
matter before enabling this API.

Candidate text is
stored as literal chunks and searchable literal units without an LLM extraction
call, semantic links or entity inference. Candidate units are marked ineligible
for automatic consolidation. No historical date is derived from ingestion time.
Existing source-quote insight safeguards and original records remain untouched.

Rollback requires a separate user confirmation in the client, an immutable
created receipt hash, target metadata and update version, plus a new bound
rollback UUID/payload hash. It checks the complete target graph and rejects any
change, observation reference, semantic link or entity posting. It removes only
exact versions created by this operation; it does not invalidate external
observations. A durable tombstone reconciles a lost response. A missing target
alone never proves rollback success.

PostgreSQL observations store source UUID arrays without foreign keys. The
migration therefore adds cleaner-owned unit tombstones and a trigger that
serializes source-array writers against rollback and rejects delayed references
after rollback commits. This trigger affects only cleaner-owned UUIDs. Rollback
also takes bounded table locks; under concurrent load it can fail closed after
three seconds per contested lock rather than perform a partial deletion. The
request does not promise a three-second total deadline: uncontested queries and
provider preparation have their own runtime costs. A real two-connection
contention regression checks that a blocked rollback fails near three seconds
with documents, ownership tombstones and the receipt unchanged. The owner must assess this
locking cost before enabling writes.

Receipts and tombstones are registered with native admin backup/restore.
Document/whole-bank transfer replays documents and is not an operation receipt
restore; do not promise receipt-backed rollback after such a transfer.

## Contract hashing

Object keys sort by Unicode code point. JSON uses UTF-8 without insignificant
whitespace. Null and empty objects are distinct. Integers and integer-valued
floats use JSON/JavaScript numeric rendering. Source and expected target timestamp
strings are preserved in request digests and compared as timezone-aware instants.
The initial receipt contains required nullable rollback fields. Hash the complete
received initial receipt, including those nulls. The rollback payload digest
covers all rollback request fields except `rollback_payload_sha256` itself.

## Verification and remaining gates

`tests/test_cleaner_atomic.py` uses generic generated fixtures, two real database
connections and the exact migration SQL in a disposable PostgreSQL schema. It
requires an explicit `CLEANER_ATOMIC_TEST_DATABASE_URL`, rejects known production
ports, and never starts or uses the configured application database. Execute it
directly with Python to avoid the repository's shared database pytest fixtures.

Persistence tests cover source mutation/deletion, target collision, replay,
wrong-bank binding, cancellation, changed targets, rollback hash/UUID binding and
a reference writer blocked until after rollback. The full-schema system suite
executes actual chunk and fact storage with a deterministic synthetic local
embedding provider. The published Python SDK story runs over real loopback HTTP:
create, replay, receipt serialization, rollback and changed-target rejection.
The standard blackbox story in
`hindsight-system-tests/tests/test_96_cleaner_atomic.py` uses only the public
Python SDK and normal real-server/provider fixtures. Its configured local
SentenceTransformer provider loads a generated deterministic BoW fixture without
pretrained weights or network downloads. The worker and unscripted LLM guards
stay active; two worker poll intervals verify no extraction/consolidation call.
The story covers discarded acknowledgement receipt recovery, exact replay,
stale-source rejection, rollback/replay and changed-target protection.
Original public document projection and chunk/unit counts are checked unchanged;
candidate historical date columns remain unset. No model quality claim is made.

The isolated implementation passed 28 primitive/boundary tests and six full
engine/native SDK tests in the earlier integration snapshot. The current
resource-limit snapshot passed two standard real-server public SDK stories,
including exact 50,000-codepoint acceptance and 50,001 rejection before a target
or receipt exists, plus the blocked rollback regression. Independent review,
Ruff and type checks cover the changed source. OpenAPI and
Python/TypeScript/Go clients were regenerated; TypeScript build/typecheck and Rust
build passed. Rust generates from OpenAPI at build time. OpenAPI Generator 7.10.0
boolean-constant Python validators require the reproducible postprocessing in
scripts/generate-clients.sh. Test runners must specify isolated API URLs; never
use application defaults for development tests.

Owner-coordinated backup, migration, installed-runtime validation and activation
remain required. Writes stay disabled by default. No installed API capability is
claimed by this source patch. Native receipt-aware backups can restore operation
identity; document transfers do not preserve that identity. Missing receipts
leave outcomes uncertain and never justify deletion or retry with a fresh UUID.
