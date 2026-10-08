"""Atomic, additive literal candidates. PostgreSQL SQL-owned stores only.

This path deliberately never calls retain's destructive document tracking.
Receipt authority lives in SQL, not in caller-forgeable metadata markers.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Awaitable, Callable
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_serializer, field_validator, model_validator

if TYPE_CHECKING:
    from hindsight_api.models import RequestContext

    from .db.base import DatabaseConnection
    from .memory_engine import MemoryEngine

CONTRACT_ID = "cleaner-atomic-v1"
MAX_BYTES = 8 * 1024 * 1024
MAX_CANDIDATE_CHARACTERS = 50_000


class CleanerConflict(Exception):
    """A reviewed version or operation binding no longer matches."""


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Condition(StrictModel):
    execution_config_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    bank_id: str = Field(min_length=1, max_length=256)
    source_id: str = Field(min_length=1, max_length=1024)
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_updated_at: str
    source_metadata_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    target_id: str = Field(min_length=1, max_length=1024)
    target_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    owner_key: str = Field(min_length=32, max_length=128)
    operation_id: UUID
    payload_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("source_updated_at", mode="before")
    @classmethod
    def source_date_text(cls, value: str | datetime) -> str:
        return value.isoformat() if isinstance(value, datetime) else value

    @model_validator(mode="after")
    def validate_scope(self) -> Condition:
        if self.source_id == self.target_id or parse_date(self.source_updated_at).tzinfo is None:
            raise ValueError("Separate target and timezone-aware source version required")
        return self


class LiteralItem(StrictModel):
    document_id: str
    content: str = Field(min_length=1, max_length=MAX_CANDIDATE_CHARACTERS)
    timestamp: Literal["unset"]
    metadata: dict[str, str]
    tags: list[str] = Field(default_factory=list, max_length=100)


class LiteralPayload(StrictModel):
    asynchronous: Literal[True] = Field(alias="async")
    operation_id: UUID
    items: list[LiteralItem] = Field(min_length=1, max_length=1)


class CreateRequest(StrictModel):
    condition: Condition
    # Preserve the exact backed-up wire bytes; reserialization is not a hash contract.
    payload_json: str = Field(min_length=1, max_length=MAX_BYTES)

    def validated_payload(self) -> LiteralPayload:
        raw = self.payload_json.encode("utf-8")
        if len(raw) > MAX_BYTES or sha(raw) != self.condition.payload_sha256:
            raise ValueError("Bounded payload hash mismatch")
        payload = LiteralPayload.model_validate_json(raw)
        item = payload.items[0]
        c = self.condition
        if payload.operation_id != c.operation_id or item.document_id != c.target_id:
            raise ValueError("Operation/target binding mismatch")
        if sha(item.content.encode("utf-8")) != c.target_sha256 or "\x00" in item.content:
            raise ValueError("Candidate body hash mismatch")
        required = {
            "cleaner_owner": "hindsight-cleaner-v1",
            "cleaner_owner_key": c.owner_key,
            "cleaner_operation_id": str(c.operation_id),
            "cleaner_source_sha256": c.source_sha256,
            "cleaner_source_id": c.source_id,
            "cleaner_source_metadata_sha256": c.source_metadata_sha256,
            "cleaner_candidate_sha256": c.target_sha256,
        }
        if not c.target_id.startswith("cleaner-v1-") or c.source_id.startswith("cleaner-v1-"):
            raise ValueError("Candidate namespace mismatch")
        metadata_updated_at = item.metadata.get("cleaner_source_updated_at")
        if metadata_updated_at is None or parse_date(metadata_updated_at) != parse_date(c.source_updated_at):
            raise ValueError("Source version provenance mismatch")
        if any(item.metadata.get(key) != value for key, value in required.items()):
            raise ValueError("Candidate provenance mismatch")
        return payload


class RollbackRequest(StrictModel):
    condition: Condition
    expected_updated_at: str
    rollback_operation_id: UUID
    rollback_payload_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    created_receipt_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_document_metadata_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("expected_updated_at", mode="before")
    @classmethod
    def target_date_text(cls, value: str | datetime) -> str:
        result = value.isoformat() if isinstance(value, datetime) else value
        if parse_date(result).tzinfo is None:
            raise ValueError("Timezone-aware target version required")
        return result


class DocumentVersion(StrictModel):
    id: str
    bank_id: str
    original_text: str | None
    content_hash: str | None
    retain_params: dict[str, JsonValue] | None
    tags: list[str]
    updated_at: datetime


class Receipt(StrictModel):
    condition_sha256: str
    operation_id: UUID
    payload_sha256: str
    target_id: str
    owner_key: str
    target_sha256: str
    metadata_sha256: str
    graph_sha256: str
    updated_at: datetime
    status: Literal["completed", "rolled_back"] = "completed"
    created: Literal[True] = True
    rollback_operation_id: UUID | None
    rollback_payload_sha256: str | None
    created_receipt_sha256: str | None

    @field_serializer("updated_at")
    def public_update_time(self, value: datetime) -> str:
        # Match the existing document GET's isoformat spelling for client guards.
        return value.isoformat()


class CreateResult(StrictModel):
    accepted: Literal[True] = True
    operation_id: UUID
    reused: bool = False


class DeleteResult(StrictModel):
    deleted: Literal[True] = True
    rollback_operation_id: UUID


def parse_date(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value: JsonValue) -> str:
    """Protocol JSON: UTF-8, sorted Unicode keys, no insignificant whitespace."""
    if isinstance(value, dict):
        return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in sorted(value)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite JSON number")
        if value == 0:
            return "0"
        if 1e-6 <= abs(value) < 1e21:
            fixed = format(Decimal(repr(value)), "f")
            return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
        mantissa, exponent = repr(value).lower().split("e")
        mantissa = mantissa.removesuffix(".0")
        number = int(exponent)
        return mantissa + "e" + ("+" if number >= 0 else "-") + str(abs(number))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class PublicDocumentProvenance(StrictModel):
    document_metadata: JsonValue
    tags: list[str]
    retain_params: dict[str, JsonValue] | None


def public_document_provenance(document: DocumentVersion) -> PublicDocumentProvenance:
    """Match get_document's public projection; canonical itself preserves {}."""
    params = document.retain_params
    metadata = (params or {}).get("metadata")
    return PublicDocumentProvenance(
        document_metadata=metadata or None,
        tags=document.tags,
        retain_params=params or None,
    )


def metadata_sha(document: DocumentVersion) -> str:
    return sha(canonical(public_document_provenance(document).model_dump(mode="json")).encode("utf-8"))


def _table(name: str) -> str:
    # Lazy import avoids the engine/retain import cycle and resolves tenant schema.
    from .memory_engine import fq_table

    return fq_table(name)


async def _document(conn: DatabaseConnection, bank: str, document: str) -> DocumentVersion | None:
    row = await conn.fetchrow(
        f"SELECT id,bank_id,original_text,content_hash,retain_params,tags,updated_at FROM {_table('documents')} "
        "WHERE bank_id=$1 AND id=$2 FOR UPDATE",
        bank,
        document,
    )
    if row is None:
        return None
    data = dict(row)
    if isinstance(data["retain_params"], str):
        data["retain_params"] = json.loads(data["retain_params"])
    data["tags"] = list(data["tags"] or [])
    return DocumentVersion.model_validate(data)


async def _receipt(conn: DatabaseConnection, condition: Condition) -> Receipt | None:
    raw = await conn.fetchval(
        f"SELECT receipt FROM {_table('cleaner_operations')} WHERE bank_id=$1 AND operation_id=$2 FOR UPDATE",
        condition.bank_id,
        condition.operation_id,
    )
    return None if raw is None else Receipt.model_validate_json(raw if isinstance(raw, str) else json.dumps(raw))


async def _graph_sha(conn: DatabaseConnection, bank: str, target: str) -> str:
    # Whole row snapshots include changes to timestamps, embeddings and lifecycle.
    chunks = await conn.fetchval(
        f"SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.chunk_id),'[]'::jsonb) "
        f"FROM {_table('chunks')} c WHERE bank_id=$1 AND document_id=$2",
        bank,
        target,
    )
    units = await conn.fetchval(
        f"SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.id),'[]'::jsonb) "
        f"FROM {_table('memory_units')} u WHERE bank_id=$1 AND document_id=$2",
        bank,
        target,
    )
    return sha(
        canonical(
            {
                "chunks": json.loads(chunks) if isinstance(chunks, str) else chunks,
                "units": json.loads(units) if isinstance(units, str) else units,
            }
        ).encode("utf-8")
    )


async def _bank_lock(conn: DatabaseConnection, bank: str) -> None:
    await conn.execute("SET LOCAL lock_timeout = '3s'")
    if not await conn.fetchval(f"SELECT bank_id FROM {_table('banks')} WHERE bank_id=$1 FOR NO KEY UPDATE", bank):
        raise CleanerConflict("Bank missing")


VerifyConfig = Callable[["DatabaseConnection", Condition], Awaitable[None]]


WriteLiteral = Callable[["DatabaseConnection", str, LiteralItem], Awaitable[None]]


async def create_on_connection(
    conn: DatabaseConnection,
    request: CreateRequest,
    write_literal: WriteLiteral,
    verify_config: VerifyConfig,
) -> CreateResult:
    """Commit exact source guard, create-only rows and durable receipt together."""
    payload = request.validated_payload()
    c = request.condition
    async with conn.transaction():
        await _bank_lock(conn, c.bank_id)
        await verify_config(conn, c)
        condition_sha256 = sha(canonical(c.model_dump(mode="json")).encode("utf-8"))
        prior = await _receipt(conn, c)
        if prior is not None:
            if (
                prior.condition_sha256 != condition_sha256
                or prior.payload_sha256 != c.payload_sha256
                or prior.target_id != c.target_id
                or prior.owner_key != c.owner_key
            ):
                raise CleanerConflict("Operation binding mismatch")
            if prior.status != "completed":
                raise CleanerConflict("Operation already rolled back")
            return CreateResult(operation_id=c.operation_id, reused=True)
        source = await _document(conn, c.bank_id, c.source_id)
        if (
            source is None
            or source.original_text is None
            or source.content_hash != c.source_sha256
            or sha(source.original_text.encode("utf-8")) != c.source_sha256
            or source.updated_at != parse_date(c.source_updated_at)
            or metadata_sha(source) != c.source_metadata_sha256
        ):
            raise CleanerConflict("Source version changed")
        source_metadata = (source.retain_params or {}).get("metadata")
        if isinstance(source_metadata, dict) and source_metadata.get("cleaner_owner") == "hindsight-cleaner-v1":
            raise CleanerConflict("Candidate cannot be an original source")
        # A plain insert, never tracking/upsert: competing target insertion cannot be replaced.
        item = payload.items[0]
        params = canonical({"metadata": item.metadata, "timestamp": "unset"})
        created = await conn.fetchval(
            f"INSERT INTO {_table('documents')} "
            "(id,bank_id,original_text,content_hash,retain_params,tags,created_at,updated_at) "
            "VALUES ($1,$2,$3,$4,$5::jsonb,$6,NOW(),NOW()) ON CONFLICT DO NOTHING RETURNING id",
            c.target_id,
            c.bank_id,
            item.content,
            c.target_sha256,
            params,
            item.tags,
        )
        if created is None:
            raise CleanerConflict("Target already exists")
        await write_literal(conn, c.bank_id, item)
        target = await _document(conn, c.bank_id, c.target_id)
        if target is None:
            raise CleanerConflict("Created document missing")
        receipt = Receipt(
            condition_sha256=condition_sha256,
            operation_id=c.operation_id,
            payload_sha256=c.payload_sha256,
            target_id=c.target_id,
            owner_key=c.owner_key,
            target_sha256=c.target_sha256,
            metadata_sha256=metadata_sha(target),
            graph_sha256=await _graph_sha(conn, c.bank_id, c.target_id),
            updated_at=target.updated_at,
            rollback_operation_id=None,
            rollback_payload_sha256=None,
            created_receipt_sha256=None,
        )
        await conn.execute(
            f"INSERT INTO {_table('cleaner_operations')} (bank_id,operation_id,payload_sha256,receipt) "
            "VALUES ($1,$2,$3,$4::jsonb)",
            c.bank_id,
            c.operation_id,
            c.payload_sha256,
            receipt.model_dump_json(),
        )
        await conn.execute(
            f"INSERT INTO {_table('cleaner_unit_ownership')} (unit_id,bank_id,operation_id,rolled_back) "
            f"SELECT id,bank_id,$3,false FROM {_table('memory_units')} WHERE bank_id=$1 AND document_id=$2",
            c.bank_id,
            c.target_id,
            c.operation_id,
        )
    return CreateResult(operation_id=c.operation_id)


async def rollback_on_connection(conn: DatabaseConnection, request: RollbackRequest) -> DeleteResult:
    """Remove only exact unchanged created rows, rejecting cross-document effects."""
    c = request.condition
    async with conn.transaction():
        await _bank_lock(conn, c.bank_id)
        receipt = await _receipt(conn, c)
        if (
            receipt is None
            or receipt.condition_sha256 != sha(canonical(c.model_dump(mode="json")).encode("utf-8"))
            or receipt.payload_sha256 != c.payload_sha256
            or receipt.target_id != c.target_id
            or receipt.owner_key != c.owner_key
            or receipt.target_sha256 != c.target_sha256
        ):
            raise CleanerConflict("Created receipt binding mismatch")
        rollback_binding = request.model_dump(mode="json", exclude={"rollback_payload_sha256"})
        if sha(canonical(rollback_binding).encode("utf-8")) != request.rollback_payload_sha256:
            raise CleanerConflict("Rollback payload binding mismatch")
        if receipt.status == "rolled_back":
            if (
                receipt.rollback_operation_id != request.rollback_operation_id
                or receipt.rollback_payload_sha256 != request.rollback_payload_sha256
                or receipt.created_receipt_sha256 != request.created_receipt_sha256
            ):
                raise CleanerConflict("Rollback operation binding mismatch")
            return DeleteResult(rollback_operation_id=request.rollback_operation_id)
        created_receipt_sha256 = sha(canonical(json.loads(receipt.model_dump_json())).encode("utf-8"))
        if created_receipt_sha256 != request.created_receipt_sha256 or receipt.updated_at != parse_date(
            request.expected_updated_at
        ):
            raise CleanerConflict("Created receipt changed")
        # PG observation source UUID arrays have no FK. Parent row locks alone cannot
        # prevent a concurrent new observation referring to a unit about to be deleted.
        # Bound lock_timeout and fail closed instead of invalidating that observation.
        for name in ("chunks", "memory_units", "memory_links", "unit_entities"):
            await conn.execute(f"LOCK TABLE {_table(name)} IN SHARE ROW EXCLUSIVE MODE")
        # Ownership rows serialize source-array writers after the table lock. The
        # database trigger rejects delayed writers after rollback has committed.
        await conn.fetch(
            f"SELECT unit_id FROM {_table('cleaner_unit_ownership')} "
            "WHERE bank_id=$1 AND operation_id=$2 ORDER BY unit_id FOR UPDATE",
            c.bank_id,
            c.operation_id,
        )
        target = await _document(conn, c.bank_id, c.target_id)
        if (
            target is None
            or target.original_text is None
            or target.content_hash != receipt.target_sha256
            or sha(target.original_text.encode("utf-8")) != receipt.target_sha256
            or target.updated_at != receipt.updated_at
            or metadata_sha(target) != receipt.metadata_sha256
            or metadata_sha(target) != request.expected_document_metadata_sha256
            or await _graph_sha(conn, c.bank_id, c.target_id) != receipt.graph_sha256
        ):
            raise CleanerConflict("Created target changed")
        ids = await conn.fetch(
            f"SELECT id FROM {_table('memory_units')} WHERE bank_id=$1 AND document_id=$2", c.bank_id, c.target_id
        )
        unit_ids = [row["id"] for row in ids]
        # Reject all graph references, including internally created links: this path
        # initially inserts only literal units and does not own any entity/link graphs.
        refs = await conn.fetchval(
            f"SELECT EXISTS(SELECT 1 FROM {_table('memory_units')} WHERE source_memory_ids && $1::uuid[]) "
            f"OR EXISTS(SELECT 1 FROM {_table('memory_links')} "
            "WHERE from_unit_id=ANY($1::uuid[]) OR to_unit_id=ANY($1::uuid[])) "
            f"OR EXISTS(SELECT 1 FROM {_table('unit_entities')} WHERE unit_id=ANY($1::uuid[]))",
            unit_ids,
        )
        if refs:
            raise CleanerConflict("Created units have graph references")
        await conn.execute(
            f"UPDATE {_table('cleaner_unit_ownership')} SET rolled_back=true WHERE bank_id=$1 AND operation_id=$2",
            c.bank_id,
            c.operation_id,
        )
        await conn.execute(
            f"DELETE FROM {_table('memory_units')} WHERE bank_id=$1 AND document_id=$2", c.bank_id, c.target_id
        )
        await conn.execute(
            f"DELETE FROM {_table('chunks')} WHERE bank_id=$1 AND document_id=$2", c.bank_id, c.target_id
        )
        await conn.execute(f"DELETE FROM {_table('documents')} WHERE bank_id=$1 AND id=$2", c.bank_id, c.target_id)
        receipt.status = "rolled_back"
        receipt.rollback_operation_id = request.rollback_operation_id
        receipt.rollback_payload_sha256 = request.rollback_payload_sha256
        receipt.created_receipt_sha256 = created_receipt_sha256
        await conn.execute(
            f"UPDATE {_table('cleaner_operations')} SET receipt=$3::jsonb WHERE bank_id=$1 AND operation_id=$2",
            c.bank_id,
            c.operation_id,
            receipt.model_dump_json(),
        )
    return DeleteResult(rollback_operation_id=request.rollback_operation_id)


class Capabilities(StrictModel):
    atomic_create: bool
    atomic_source_check: bool
    conditional_delete: bool
    contract_id: str = CONTRACT_ID
    reason: str | None = None


async def capabilities(engine: MemoryEngine, bank_id: str, context: RequestContext) -> Capabilities:
    """Authenticate and advertise only installed, supported persistence guards."""
    await engine.get_bank_config(bank_id, request_context=context)
    backend = await engine._get_backend()
    from ..config import _get_raw_config
    from .memories import get_memories
    from .memory_engine import acquire_with_retry

    supported = (
        backend.backend_type == "postgresql"
        and not get_memories().store_owned_for(bank_id)
        and _get_raw_config().enable_document_import_api
        and _get_raw_config().enable_cleaner_atomic_writes
        and getattr(engine.embeddings, "provider_name", None) in {"local", "onnx"}
    )
    if supported:
        async with acquire_with_retry(backend) as conn:
            supported = bool(
                await conn.fetchval(
                    "SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL "
                    "AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='cleaner_source_liveness' "
                    "AND tgrelid=to_regclass($3) AND tgenabled='O')",
                    _table("cleaner_operations"),
                    _table("cleaner_unit_ownership"),
                    _table("memory_units"),
                )
            )
    return Capabilities(
        atomic_create=supported,
        atomic_source_check=supported,
        conditional_delete=supported,
        reason=None if supported else "Atomic cleaner migration/local SQL-owned provider required",
    )


async def _authorize_write(engine: MemoryEngine, bank_id: str, context: RequestContext, rollback: bool) -> None:
    await engine._authenticate_tenant(context)
    from hindsight_api.extensions import BankWriteContext, BankWriteOperation

    if engine._operation_validator:
        operation = BankWriteOperation.CLEANER_ROLLBACK if rollback else BankWriteOperation.CLEANER_CREATE
        await engine._validate_operation(
            engine._operation_validator.validate_bank_write(
                BankWriteContext(bank_id=bank_id, operation=operation, request_context=context)
            )
        )
    if not (await capabilities(engine, bank_id, context)).atomic_create:
        raise CleanerConflict("Atomic cleaner persistence unavailable")


async def engine_create(engine: MemoryEngine, request: CreateRequest, context: RequestContext) -> CreateResult:
    """Prepare embeddings only; then invoke the guarded literal transaction."""
    await _authorize_write(engine, request.condition.bank_id, context, False)
    payload = request.validated_payload()
    item = payload.items[0]
    if engine._operation_validator:
        from hindsight_api.extensions import RetainContext

        content = item.model_dump(mode="json")
        reviewed_content = canonical(content)
        result = await engine._validate_operation(
            engine._operation_validator.validate_retain(
                RetainContext(
                    bank_id=request.condition.bank_id,
                    contents=[content],
                    request_context=context,
                    document_id=item.document_id,
                )
            )
        )
        if canonical(content) != reviewed_content or (
            result is not None
            and result.contents is not None
            and canonical(result.contents) != "[" + reviewed_content + "]"
        ):
            raise CleanerConflict("Validator changed the reviewed candidate; review a new plan")
    from .memory_engine import acquire_with_retry
    from .retain import chunk_storage, embedding_processing, fact_storage
    from .retain.types import ChunkMetadata, ProcessedFact, pack_embedding

    # Fixed literal slicing has complete coverage and does not invoke extraction.
    texts = [item.content[index : index + 2048] for index in range(0, len(item.content), 2048)]
    vectors = await embedding_processing.generate_embeddings_batch(engine.embeddings, texts)
    if len(vectors) != len(texts):
        raise CleanerConflict("Embedding coverage mismatch")
    backend = await engine._get_backend()

    async def verify_config(conn: DatabaseConnection, condition: Condition) -> None:
        # The bank row is already locked. This uncached resolution matches the
        # public bank-config response; persistent config writers must update it.
        config = await engine._config_resolver.get_bank_config(condition.bank_id, context, cached=False)
        if (
            sha(canonical(config).encode("utf-8")) != condition.execution_config_sha256
            or config.get("retain_extraction_mode") != "chunks"
            or config.get("enable_observations") is not False
            or config.get("retain_default_strategy")
        ):
            raise CleanerConflict("Execution config changed")

    async def write_literal(conn: DatabaseConnection, bank: str, literal: LiteralItem) -> None:
        chunks = [
            ChunkMetadata(chunk_text=text, fact_count=1, content_index=0, chunk_index=index)
            for index, text in enumerate(texts)
        ]
        mapping = await chunk_storage.store_chunks_batch(
            conn, bank, literal.document_id, chunks, ops=backend.ops, store_document_text=True
        )
        facts = [
            ProcessedFact(
                fact_text=text,
                fact_type="world",
                embedding=pack_embedding(vector),
                occurred_start=None,
                occurred_end=None,
                mentioned_at=None,
                context="Unverified literal source candidate",
                metadata=literal.metadata,
                tags=literal.tags,
                chunk_id=mapping[index],
                document_id=literal.document_id,
            )
            for index, (text, vector) in enumerate(zip(texts, vectors, strict=True))
        ]
        await fact_storage.insert_facts_batch(conn, bank, facts, document_id=literal.document_id, ops=backend.ops)
        # These literal copies are not eligible for later semantic consolidation.
        # This does not alter the existing source-quote insight guard or originals.
        await conn.execute(
            f"UPDATE {_table('memory_units')} SET consolidated_at=NOW() WHERE bank_id=$1 AND document_id=$2",
            bank,
            literal.document_id,
        )

    async with acquire_with_retry(backend) as conn:
        return await create_on_connection(conn, request, write_literal, verify_config)


async def engine_rollback(engine: MemoryEngine, request: RollbackRequest, context: RequestContext) -> DeleteResult:
    await _authorize_write(engine, request.condition.bank_id, context, True)
    from .memory_engine import acquire_with_retry

    async with acquire_with_retry(await engine._get_backend()) as conn:
        return await rollback_on_connection(conn, request)


async def engine_receipt(engine: MemoryEngine, bank: str, operation: UUID, context: RequestContext) -> Receipt | None:
    # Bank config read performs tenant and bank read authorization.
    await engine.get_bank_config(bank, request_context=context)
    from .memory_engine import acquire_with_retry

    async with acquire_with_retry(await engine._get_backend()) as conn:
        raw = await conn.fetchval(
            f"SELECT receipt FROM {_table('cleaner_operations')} WHERE bank_id=$1 AND operation_id=$2", bank, operation
        )
        return None if raw is None else Receipt.model_validate_json(raw if isinstance(raw, str) else json.dumps(raw))
