# Typed cleaner API

Python 3.11+ is required. The reusable API accepts `Document` dataclasses and returns a `Report`. Redaction, normalization, source offsets, coverage and receipts use named records. Dynamic caller metadata remains dynamic; fixed JSON schemas are validated before processing. The CLI JSON protocol and deterministic IDs are compatible with the original preview implementation.

Direct Python callers should use `parse_documents` and `to_json` to adapt JSON values. Output identities are validated before local writes. No runtime dependency was added. The boundary uses validated standard-library dataclasses; upstream normally prefers Pydantic for external JSON boundaries. This is a disclosed convention difference.

The contribution tests use generic strings and generated inputs. Optional compatibility cases run when `CLEANER_BASELINE` points to the earlier generic cleaner core; no bank fixture is used. Local verification covers Python 3.12 and 3.14, source syntax compatible with Python 3.11, Ruff and the upstream `ty` checker.
