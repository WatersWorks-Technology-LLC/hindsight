"""Guarded cleaner operations through the published SDK and a real server.

The local BoW encoder is a deterministic synthetic fixture, not downloaded model
weights. The standard provider rulebook and its unscripted-call guards stay on.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from hindsight_client import Hindsight
from hindsight_client_api.exceptions import ApiException
from hindsight_client_api.models.create_request import CreateRequest
from hindsight_client_api.models.document_response import DocumentResponse
from hindsight_client_api.models.receipt import Receipt
from hindsight_client_api.models.rollback_request import RollbackRequest
from hindsight_client_api.models.update_document_request import UpdateDocumentRequest

from hindsight_system_tests import start_hindsight_server

pytestmark = pytest.mark.asyncio
TEXT = "Instruction: implement tomorrow; not completed. Historical date 2020-01-02. Café 🌤.\n" * 40


def canonical(value: Any) -> str:
    """Protocol JSON for this fixture's finite, integral configuration values."""
    if isinstance(value, dict):
        return (
            "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in sorted(value)) + "}"
        )
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def proposal(source: DocumentResponse, config: dict) -> CreateRequest:
    operation = str(uuid4())
    target = "cleaner-v1-" + operation
    raw = source.original_text
    assert raw is not None
    body_hash = digest(raw)
    metadata_hash = digest(
        canonical(
            {
                "document_metadata": source.document_metadata,
                "tags": source.tags or [],
                "retain_params": source.retain_params,
            }
        )
    )
    owner = digest(target)
    metadata = {
        "cleaner_owner": "hindsight-cleaner-v1",
        "cleaner_owner_key": owner,
        "cleaner_operation_id": operation,
        "cleaner_source_id": source.id,
        "cleaner_source_sha256": body_hash,
        "cleaner_candidate_sha256": body_hash,
        "cleaner_source_metadata_sha256": metadata_hash,
        "cleaner_source_updated_at": source.updated_at,
    }
    payload = canonical(
        {
            "async": True,
            "operation_id": operation,
            "items": [
                {
                    "document_id": target,
                    "content": raw,
                    "timestamp": "unset",
                    "metadata": metadata,
                    "tags": source.tags or [],
                }
            ],
        }
    )
    return CreateRequest.model_validate(
        {
            "condition": {
                "bank_id": source.bank_id,
                "source_id": source.id,
                "source_sha256": body_hash,
                "source_updated_at": source.updated_at,
                "source_metadata_sha256": metadata_hash,
                "execution_config_sha256": digest(canonical(config)),
                "target_id": target,
                "target_sha256": body_hash,
                "owner_key": owner,
                "operation_id": operation,
                "payload_sha256": digest(payload),
            },
            "payload_json": payload,
        }
    )


def rollback(request: CreateRequest, receipt: Receipt) -> RollbackRequest:
    # Public JSON projection must retain explicit nulls and the public +00:00 date.
    wire = receipt.to_dict()
    for key in ("rollback_operation_id", "rollback_payload_sha256", "created_receipt_sha256"):
        wire[key] = None
    body = {
        "condition": request.condition.to_dict(),
        "expected_updated_at": wire["updated_at"],
        "expected_document_metadata_sha256": receipt.metadata_sha256,
        "rollback_operation_id": str(uuid4()),
        "created_receipt_sha256": digest(canonical(wire)),
    }
    body["rollback_payload_sha256"] = digest(canonical(body))
    return RollbackRequest.model_validate(body)


@pytest.fixture(scope="session")
def cleaner_server(stub_server, tmp_path_factory):
    from sentence_transformers import SentenceTransformer
    from sentence_transformers.sentence_transformer.modules.bow import BoW

    root: Path = tmp_path_factory.mktemp("cleaner-server")
    model = root / "bow"
    SentenceTransformer(
        modules=[BoW(["instruction", "implement", "historical", "date"] + [f"fixture{i}" for i in range(380)])]
    ).save(str(model))
    database_url = os.environ.get("CLEANER_SYSTEM_TEST_DATABASE_URL")
    if database_url:
        parsed = urlparse(database_url)
        assert parsed.hostname in {"localhost", "127.0.0.1"}
        assert parsed.port not in {None, 5432, 55438, 8888, 9999, 3200}
    server = start_hindsight_server(
        stub_url=stub_server.url,
        log_path=root / "server.log",
        command=[sys.executable, "-c", "from hindsight_api.main import main; main()"],
        database_url=database_url,
        extra_env={
            "HINDSIGHT_API_ENABLE_CLEANER_ATOMIC_WRITES": "true",
            "HINDSIGHT_API_EMBEDDINGS_PROVIDER": "local",
            "HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL": str(model),
            "HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU": "true",
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
        },
    )
    assert urlparse(server.url).port not in {8888, 9999, 3200}
    yield server
    server.stop()


@pytest.fixture
async def cleaner_client(cleaner_server):
    client = Hindsight(base_url=cleaner_server.url, max_attempts=1)
    yield client
    await client.aclose()


@pytest.fixture
async def cleaner_bank(cleaner_client):
    bank = "systest-cleaner-" + uuid4().hex
    await cleaner_client.acreate_bank(bank, retain_extraction_mode="chunks", enable_observations=False)
    yield bank
    await cleaner_client.banks.delete_bank(bank)


async def test_cleaner_literal_replay_receipt_stale_source_and_guarded_rollback(cleaner_client, cleaner_bank, llm):
    client, bank = cleaner_client, cleaner_bank
    await client.aretain(bank_id=bank, content=TEXT, document_id="source", timestamp="unset")
    original = await client.documents.get_document(bank, "source")
    original_wire = original.to_dict()
    source_chunks = await client.documents.list_document_chunks(bank, "source")
    config = (await client.aget_bank_config(bank))["config"]
    capability = await client.cleaner.cleaner_capabilities(bank)
    assert capability.atomic_create and capability.conditional_delete
    request = proposal(original, config)
    # Deliberately discard the create acknowledgement: the same operation UUID's
    # durable receipt, rather than a target GET or a new UUID, resolves uncertainty.
    await client.cleaner.cleaner_create(bank, request)
    receipt = await client.cleaner.cleaner_receipt(bank, request.condition.operation_id)
    assert receipt.created and receipt.status == "completed"
    replay = await client.cleaner.cleaner_create(bank, request)
    assert replay.reused
    target = await client.documents.get_document(bank, request.condition.target_id)
    assert target.original_text == TEXT
    chunks = await client.documents.list_document_chunks(bank, request.condition.target_id)
    assert "".join(c.chunk_text for c in sorted(chunks.items, key=lambda c: c.chunk_index)) == TEXT
    memories = await client.memory.list_memories(bank, document_id=request.condition.target_id, limit=100)
    assert memories.items
    for memory in memories.items:
        assert memory.mentioned_at is None and memory.occurred_start is None and memory.occurred_end is None
        assert memory.var_date in {None, ""}
    rollback_body = rollback(request, receipt)
    removed = await client.cleaner.cleaner_rollback(bank, request.condition.operation_id, rollback_body)
    assert (await client.cleaner.cleaner_rollback(bank, request.condition.operation_id, rollback_body)).deleted
    assert removed.deleted
    with pytest.raises(ApiException) as gone:
        await client.documents.get_document(bank, request.condition.target_id)
    assert gone.value.status == 404
    assert (await client.documents.get_document(bank, "source")).to_dict() == original_wire
    assert (await client.documents.list_document_chunks(bank, "source")).to_dict() == source_chunks.to_dict()

    stale = proposal(original, config)
    await client.documents.update_document(bank, "source", UpdateDocumentRequest(tags=["reviewed-change"]))
    with pytest.raises(ApiException) as conflict:
        await client.cleaner.cleaner_create(bank, stale)
    assert conflict.value.status == 409
    with pytest.raises(ApiException) as absent:
        await client.documents.get_document(bank, stale.condition.target_id)
    assert absent.value.status == 404

    changed_source = await client.documents.get_document(bank, "source")
    changed_wire = changed_source.to_dict()
    second = proposal(changed_source, config)
    await client.cleaner.cleaner_create(bank, second)
    second_receipt = await client.cleaner.cleaner_receipt(bank, second.condition.operation_id)
    await client.documents.update_document(
        bank, second.condition.target_id, UpdateDocumentRequest(tags=["external-change"])
    )
    with pytest.raises(ApiException) as protected:
        await client.cleaner.cleaner_rollback(bank, second.condition.operation_id, rollback(second, second_receipt))
    assert protected.value.status == 409
    assert (await client.documents.get_document(bank, second.condition.target_id)).original_text == TEXT
    assert (await client.documents.get_document(bank, "source")).to_dict() == changed_wire

    # Give the ordinary worker multiple poll intervals; the standard guards still
    # reject any unexpected provider call after the test.
    await asyncio.sleep(1.1)
    assert llm.prompts_for("extract_facts") == []
    assert llm.prompts_for("consolidate") == []


async def test_cleaner_character_admission_bound_is_codepoints(cleaner_client, cleaner_bank):
    client, bank = cleaner_client, cleaner_bank
    prefix = "instruction "
    text = prefix + "🙂" * (50_000 - len(prefix))
    assert len(text) == 50_000 and len(text.encode("utf-8")) > 50_000
    await client.aretain(bank_id=bank, content=text, document_id="source", timestamp="unset")
    source = await client.documents.get_document(bank, "source")
    config = (await client.aget_bank_config(bank))["config"]
    accepted = proposal(source, config)
    assert (await client.cleaner.cleaner_create(bank, accepted)).accepted
    target = await client.documents.get_document(bank, accepted.condition.target_id)
    assert target.original_text == text
    assert (await client.documents.get_document(bank, "source")).to_dict() == source.to_dict()

    rejected = proposal(source, config)
    payload = json.loads(rejected.payload_json)
    oversized = text + "🙂"
    payload["items"][0]["content"] = oversized
    payload["items"][0]["metadata"]["cleaner_candidate_sha256"] = digest(oversized)
    rejected.condition.target_sha256 = digest(oversized)
    rejected.payload_json = canonical(payload)
    rejected.condition.payload_sha256 = digest(rejected.payload_json)
    with pytest.raises(ApiException) as too_large:
        await client.cleaner.cleaner_create(bank, rejected)
    assert too_large.value.status == 422
    with pytest.raises(ApiException) as absent:
        await client.documents.get_document(bank, rejected.condition.target_id)
    assert absent.value.status == 404
    with pytest.raises(ApiException) as missing_receipt:
        await client.cleaner.cleaner_receipt(bank, rejected.condition.operation_id)
    assert missing_receipt.value.status == 404
    assert (await client.documents.get_document(bank, "source")).to_dict() == source.to_dict()
