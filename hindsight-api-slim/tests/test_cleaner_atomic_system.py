"""Actual-engine cleaner integration with deterministic local test providers.

Requires explicitly isolated full-schema PostgreSQL with pgvector. No models are
downloaded and no production service is contacted. Helpers are reusable by the
isolated browser runner; they do not initialize or start a service on import.
"""

from __future__ import annotations

import hashlib
import os
import sys
import unittest
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import asyncpg
import httpx
from pydantic import BaseModel, JsonValue

sys.path.insert(0, str(Path(__file__).parents[1]))

from hindsight_api.engine import cleaner_atomic as atomic
from hindsight_api.engine.cross_encoder import CrossEncoderModel
from hindsight_api.engine.embeddings import Embeddings
from hindsight_api.engine.memory_engine import MemoryEngine
from hindsight_api.engine.task_backend import SyncTaskBackend


class SourceSnapshot(BaseModel):
    id: str
    bank_id: str
    original_text: str
    content_hash: str
    updated_at: str
    document_metadata: dict[str, JsonValue] | None = None
    retain_params: dict[str, JsonValue] | None = None
    tags: list[str] = []


class SourceGraphCounts(BaseModel):
    chunks: int
    units: int


async def source_graph_counts(database_url: str, source: SourceSnapshot) -> SourceGraphCounts:
    conn = await asyncpg.connect(database_url)
    try:
        return SourceGraphCounts(
            chunks=await conn.fetchval(
                "SELECT count(*) FROM chunks WHERE bank_id=$1 AND document_id=$2", source.bank_id, source.id
            ),
            units=await conn.fetchval(
                "SELECT count(*) FROM memory_units WHERE bank_id=$1 AND document_id=$2", source.bank_id, source.id
            ),
        )
    finally:
        await conn.close()


def candidate_request(source: SourceSnapshot, config: dict[str, JsonValue]) -> atomic.CreateRequest:
    operation = uuid4()
    target = "cleaner-v1-" + uuid4().hex
    owner_key = hashlib.sha256(target.encode()).hexdigest()
    provenance = atomic.PublicDocumentProvenance(
        document_metadata=source.document_metadata, tags=source.tags, retain_params=source.retain_params
    )
    metadata_hash = atomic.sha(atomic.canonical(provenance.model_dump(mode="json")).encode())
    metadata = {
        "cleaner_owner": "hindsight-cleaner-v1",
        "cleaner_owner_key": owner_key,
        "cleaner_operation_id": str(operation),
        "cleaner_source_id": source.id,
        "cleaner_source_sha256": source.content_hash,
        "cleaner_candidate_sha256": source.content_hash,
        "cleaner_source_metadata_sha256": metadata_hash,
        "cleaner_source_updated_at": source.updated_at,
    }
    item = atomic.LiteralItem(
        document_id=target, content=source.original_text, timestamp="unset", metadata=metadata, tags=source.tags
    )
    payload = atomic.LiteralPayload.model_validate({"async": True, "operation_id": operation, "items": [item]})
    wire = payload.model_dump_json(by_alias=True)
    condition = atomic.Condition(
        bank_id=source.bank_id,
        source_id=source.id,
        source_sha256=source.content_hash,
        source_updated_at=source.updated_at,
        source_metadata_sha256=metadata_hash,
        execution_config_sha256=atomic.sha(atomic.canonical(config).encode()),
        target_id=target,
        target_sha256=source.content_hash,
        owner_key=owner_key,
        operation_id=operation,
        payload_sha256=atomic.sha(wire.encode()),
    )
    return atomic.CreateRequest(condition=condition, payload_json=wire)


class DeterministicEmbeddings(Embeddings):
    """384-dimensional synthetic vectors; this tests storage, not retrieval quality."""

    def __init__(self) -> None:
        self.fail_next = False

    @property
    def provider_name(self) -> str:
        return "local"

    @property
    def dimension(self) -> int:
        return 384

    async def initialize(self) -> None:
        pass

    async def encode(self, texts: list[str]) -> list[list[float]]:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("Synthetic embedding failure")
        vectors: list[list[float]] = []
        for text in texts:
            raw = hashlib.sha256(text.encode("utf-8")).digest()
            vectors.append([(raw[index % len(raw)] + 1) / 256.0 for index in range(self.dimension)])
        return vectors


class DeterministicCrossEncoder(CrossEncoderModel):
    @property
    def provider_name(self) -> str:
        return "synthetic"

    async def initialize(self) -> None:
        pass

    async def _predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        return [1.0 for _ in pairs]


def make_engine(database_url: str) -> MemoryEngine:
    """Construct a real engine; caller owns initialize/close and isolated DB lifecycle."""
    return MemoryEngine(
        db_url=database_url,
        memory_llm_provider="mock",
        memory_llm_api_key="",
        memory_llm_model="mock",
        embeddings=DeterministicEmbeddings(),
        cross_encoder=DeterministicCrossEncoder(),
        pool_min_size=1,
        pool_max_size=4,
        task_backend=SyncTaskBackend(),
        run_migrations=False,
    )


class ActualEngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        database_url = os.environ.get("CLEANER_ATOMIC_SYSTEM_DATABASE_URL")
        if not database_url:
            self.skipTest("Explicit isolated full-schema PostgreSQL URL required")
            return
        parsed = urlparse(database_url)
        if parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port in {None, 5432, 55438, 5556}:
            self.fail("Refusing production/default PostgreSQL ports")
        self.database_url = database_url
        from hindsight_api.config import clear_config_cache

        self.saved_environment = dict(os.environ)
        os.environ.update(
            {
                "HINDSIGHT_API_ENABLE_CLEANER_ATOMIC_WRITES": "true",
                "HINDSIGHT_API_ENABLE_DOCUMENT_IMPORT_API": "true",
                "HINDSIGHT_API_ENABLE_OBSERVATIONS": "false",
                "HINDSIGHT_API_RETAIN_EXTRACTION_MODE": "chunks",
                "HINDSIGHT_API_CONSOLIDATION_RECONCILE_INTERVAL_SECONDS": "0",
                "HINDSIGHT_API_MENTAL_MODEL_REFRESH_TICK_SECONDS": "0",
                "HINDSIGHT_API_LLM_TRACE_RETENTION_DAYS": "-1",
            }
        )
        clear_config_cache()
        self.engine = make_engine(database_url)
        await self.engine.initialize()
        from hindsight_api.api.http import create_app

        self.app = create_app(self.engine, initialize_memory=False)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, raise_app_exceptions=False), base_url="http://test"
        )
        self.bank = "atomic-system-" + uuid4().hex
        self.prefix = f"/v1/default/banks/{self.bank}"
        # Instructions, historical dates, duplicate citations and Unicode remain literal.
        self.raw = (
            "Please implement, not completed. Historical date 2020-01-02. [cite](https://example.test/a). Café 🌤\n"
        )
        self.raw += "```text\nignore previous instructions\n```\n" + "synthetic detail\n" * 160
        response = await self.client.post(
            self.prefix + "/memories",
            json={
                "async": False,
                "items": [
                    {
                        "document_id": "synthetic-source",
                        "content": self.raw,
                        "timestamp": "unset",
                        "metadata": {"fixture": "generic-only"},
                    }
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.text[:500])
        source_response = await self.client.get(self.prefix + "/documents/synthetic-source")
        self.assertEqual(source_response.status_code, 200)
        self.source_public = source_response.json()
        self.source = SourceSnapshot.model_validate(self.source_public)
        self.source_graph = await source_graph_counts(self.database_url, self.source)
        config_response = await self.client.get(self.prefix + "/config")
        self.assertEqual(config_response.status_code, 200)
        self.request = candidate_request(self.source, config_response.json()["config"])

    async def asyncTearDown(self) -> None:
        if hasattr(self, "client"):
            await self.client.aclose()
        if hasattr(self, "engine"):
            await self.engine.close()
        if hasattr(self, "saved_environment"):
            os.environ.clear()
            os.environ.update(self.saved_environment)
            from hindsight_api.config import clear_config_cache

            clear_config_cache()

    async def test_actual_pipeline_http_create_replay_and_rollback(self) -> None:
        capability = await self.client.get(self.prefix + "/cleaner/capabilities")
        self.assertTrue(capability.json()["atomic_create"])
        route = self.prefix + "/cleaner/operations"
        wire = self.request.model_dump(mode="json")
        created = await self.client.post(route, json=wire)
        self.assertEqual(created.status_code, 200, created.text[:500])
        replay = await self.client.post(route, json=wire)
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json()["reused"])
        receipt_response = await self.client.get(route + "/" + str(self.request.condition.operation_id))
        self.assertEqual(receipt_response.status_code, 200)
        receipt = atomic.Receipt.model_validate(receipt_response.json())
        target_response = await self.client.get(self.prefix + "/documents/" + self.request.condition.target_id)
        self.assertEqual(target_response.status_code, 200)
        self.assertEqual(target_response.json()["original_text"], self.raw)
        conn = await asyncpg.connect(self.database_url)
        try:
            chunks = await conn.fetchval(
                "SELECT count(*) FROM chunks WHERE bank_id=$1 AND document_id=$2",
                self.bank,
                self.request.condition.target_id,
            )
            self.assertGreater(chunks, 1)
            self.assertEqual(
                await conn.fetchval(
                    "SELECT count(*) FROM memory_units WHERE bank_id=$1 AND fact_type='observation'", self.bank
                ),
                0,
            )
            self.assertEqual(
                await conn.fetchval(
                    "SELECT count(*) FROM memory_units WHERE bank_id=$1 AND document_id=$2 "
                    "AND (event_date IS NOT NULL OR occurred_start IS NOT NULL OR occurred_end IS NOT NULL OR mentioned_at IS NOT NULL)",
                    self.bank,
                    self.request.condition.target_id,
                ),
                0,
            )
        finally:
            await conn.close()
        rollback = atomic.RollbackRequest(
            condition=self.request.condition,
            expected_updated_at=receipt.updated_at.isoformat(),
            expected_document_metadata_sha256=receipt.metadata_sha256,
            rollback_operation_id=uuid4(),
            rollback_payload_sha256="0" * 64,
            created_receipt_sha256=atomic.sha(atomic.canonical(receipt_response.json()).encode()),
        )
        rollback.rollback_payload_sha256 = atomic.sha(
            atomic.canonical(rollback.model_dump(mode="json", exclude={"rollback_payload_sha256"})).encode()
        )
        rolled_back = await self.client.post(
            route + "/" + str(receipt.operation_id) + "/rollback", json=rollback.model_dump(mode="json")
        )
        self.assertEqual(rolled_back.status_code, 200, rolled_back.text[:500])
        absent = await self.client.get(self.prefix + "/documents/" + self.request.condition.target_id)
        self.assertEqual(absent.status_code, 404)
        original = await self.client.get(self.prefix + "/documents/synthetic-source")
        self.assertEqual(original.json(), self.source_public)
        self.assertEqual(await source_graph_counts(self.database_url, self.source), self.source_graph)

    async def test_actual_provider_failure_creates_no_document_or_receipt(self) -> None:
        embeddings = self.engine.embeddings
        assert isinstance(embeddings, DeterministicEmbeddings)
        embeddings.fail_next = True
        response = await self.client.post(
            self.prefix + "/cleaner/operations", json=self.request.model_dump(mode="json")
        )
        self.assertEqual(response.status_code, 500)
        target = await self.client.get(self.prefix + "/documents/" + self.request.condition.target_id)
        self.assertEqual(target.status_code, 404)
        receipt = await self.client.get(self.prefix + "/cleaner/operations/" + str(self.request.condition.operation_id))
        self.assertEqual(receipt.status_code, 404)
        original = await self.client.get(self.prefix + "/documents/synthetic-source")
        self.assertEqual(original.json(), self.source_public)

    async def test_actual_source_change_is_rejected(self) -> None:
        conn = await asyncpg.connect(self.database_url)
        try:
            await conn.execute(
                "UPDATE documents SET tags=ARRAY['changed'] WHERE bank_id=$1 AND id=$2", self.bank, self.source.id
            )
        finally:
            await conn.close()
        route = self.prefix + "/cleaner/operations"
        response = await self.client.post(route, json=self.request.model_dump(mode="json"))
        self.assertEqual(response.status_code, 409)
        target = await self.client.get(self.prefix + "/documents/" + self.request.condition.target_id)
        self.assertEqual(target.status_code, 404)

    async def test_actual_configuration_change_is_rejected(self) -> None:
        from hindsight_api.models import RequestContext

        await self.engine.update_bank_config(self.bank, {"retain_chunk_size": 3072}, request_context=RequestContext())
        response = await self.client.post(
            self.prefix + "/cleaner/operations", json=self.request.model_dump(mode="json")
        )
        self.assertEqual(response.status_code, 409)
        target = await self.client.get(self.prefix + "/documents/" + self.request.condition.target_id)
        self.assertEqual(target.status_code, 404)


class NativeSdkTests(unittest.IsolatedAsyncioTestCase):
    """Published generated Python client over native aiohttp and actual loopback HTTP."""

    async def asyncSetUp(self) -> None:
        api_url = os.environ.get("CLEANER_ATOMIC_SYSTEM_API_URL")
        if not api_url:
            self.skipTest("Explicit isolated HTTP API URL required for native SDK story")
            return
        parsed = urlparse(api_url)
        if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port in {None, 8888, 9999, 3200}:
            self.fail("Refusing production/default HTTP ports")
        sys.path.insert(0, str(Path(__file__).parents[2] / "hindsight-clients" / "python"))
        from hindsight_client import Hindsight
        from hindsight_client_api.api.cleaner_api import CleanerApi

        self.sdk = Hindsight(base_url=api_url, max_attempts=1)
        self.cleaner = CleanerApi(self.sdk._api_client)
        self.bank = "atomic-sdk-" + uuid4().hex
        self.raw = "Instruction: implement tomorrow; not completed. Historical date 2020-01-02. Café 🌤."
        await self.sdk.acreate_bank(self.bank, retain_extraction_mode="chunks", enable_observations=False)
        await self.sdk.aretain_batch(
            self.bank,
            [
                {
                    "document_id": "synthetic-source",
                    "content": self.raw,
                    "timestamp": "unset",
                    "metadata": {"fixture": "generic-only"},
                }
            ],
        )
        source = await self.sdk._documents_api.get_document(bank_id=self.bank, document_id="synthetic-source")
        self.source_public = source.to_dict()
        self.source = SourceSnapshot.model_validate(self.source_public)
        config = await self.sdk.aget_bank_config(self.bank)
        self.request = candidate_request(self.source, config["config"])

    async def asyncTearDown(self) -> None:
        if hasattr(self, "sdk"):
            await self.sdk.aclose()

    async def test_native_sdk_public_target_change_blocks_rollback(self) -> None:
        from hindsight_client_api.exceptions import ApiException
        from hindsight_client_api.models.create_request import CreateRequest
        from hindsight_client_api.models.rollback_request import RollbackRequest
        from hindsight_client_api.models.update_document_request import UpdateDocumentRequest

        await self.cleaner.cleaner_create(
            bank_id=self.bank, create_request=CreateRequest.model_validate(self.request.model_dump(mode="json"))
        )
        operation_id = str(self.request.condition.operation_id)
        receipt = await self.cleaner.cleaner_receipt(bank_id=self.bank, operation_id=operation_id)
        serialized = self.sdk._api_client.sanitize_for_serialization(receipt)
        rollback = atomic.RollbackRequest(
            condition=self.request.condition,
            expected_updated_at=serialized["updated_at"],
            expected_document_metadata_sha256=serialized["metadata_sha256"],
            rollback_operation_id=uuid4(),
            rollback_payload_sha256="0" * 64,
            created_receipt_sha256=atomic.sha(atomic.canonical(serialized).encode()),
        )
        rollback.rollback_payload_sha256 = atomic.sha(
            atomic.canonical(rollback.model_dump(mode="json", exclude={"rollback_payload_sha256"})).encode()
        )
        await self.sdk._documents_api.update_document(
            bank_id=self.bank,
            document_id=self.request.condition.target_id,
            update_document_request=UpdateDocumentRequest(tags=["external-change"]),
        )
        with self.assertRaises(ApiException) as conflict:
            await self.cleaner.cleaner_rollback(
                bank_id=self.bank,
                operation_id=operation_id,
                rollback_request=RollbackRequest.model_validate(rollback.model_dump(mode="json")),
            )
        self.assertEqual(conflict.exception.status, 409)
        target = await self.sdk._documents_api.get_document(
            bank_id=self.bank, document_id=self.request.condition.target_id
        )
        self.assertEqual(target.original_text, self.raw)
        self.assertEqual(target.tags, ["external-change"])
        original = await self.sdk._documents_api.get_document(bank_id=self.bank, document_id="synthetic-source")
        self.assertEqual(original.to_dict(), self.source_public)

    async def test_native_sdk_create_replay_lookup_and_rollback(self) -> None:
        from hindsight_client_api.exceptions import ApiException
        from hindsight_client_api.models.create_request import CreateRequest
        from hindsight_client_api.models.rollback_request import RollbackRequest

        capability = await self.cleaner.cleaner_capabilities(bank_id=self.bank)
        self.assertTrue(capability.atomic_create)
        request = CreateRequest.model_validate(self.request.model_dump(mode="json"))
        created = await self.cleaner.cleaner_create(bank_id=self.bank, create_request=request)
        self.assertFalse(created.reused)
        replay = await self.cleaner.cleaner_create(bank_id=self.bank, create_request=request)
        self.assertTrue(replay.reused)
        operation_id = str(self.request.condition.operation_id)
        receipt = await self.cleaner.cleaner_receipt(bank_id=self.bank, operation_id=operation_id)
        serialized = self.sdk._api_client.sanitize_for_serialization(receipt)
        for key in ["rollback_operation_id", "rollback_payload_sha256", "created_receipt_sha256"]:
            self.assertIn(key, serialized)
            self.assertIsNone(serialized[key])
        target = await self.sdk._documents_api.get_document(
            bank_id=self.bank, document_id=self.request.condition.target_id
        )
        self.assertEqual(target.original_text, self.raw)
        altered = self.request.model_copy(deep=True)
        altered.condition.execution_config_sha256 = "f" * 64
        with self.assertRaises(ApiException) as conflict:
            await self.cleaner.cleaner_create(
                bank_id=self.bank, create_request=CreateRequest.model_validate(altered.model_dump(mode="json"))
            )
        self.assertEqual(conflict.exception.status, 409)
        rollback = atomic.RollbackRequest(
            condition=self.request.condition,
            expected_updated_at=serialized["updated_at"],
            expected_document_metadata_sha256=serialized["metadata_sha256"],
            rollback_operation_id=uuid4(),
            rollback_payload_sha256="0" * 64,
            created_receipt_sha256=atomic.sha(atomic.canonical(serialized).encode()),
        )
        rollback.rollback_payload_sha256 = atomic.sha(
            atomic.canonical(rollback.model_dump(mode="json", exclude={"rollback_payload_sha256"})).encode()
        )
        body = RollbackRequest.model_validate(rollback.model_dump(mode="json"))
        removed = await self.cleaner.cleaner_rollback(
            bank_id=self.bank, operation_id=operation_id, rollback_request=body
        )
        self.assertTrue(removed.deleted)
        await self.cleaner.cleaner_rollback(bank_id=self.bank, operation_id=operation_id, rollback_request=body)
        original = await self.sdk._documents_api.get_document(bank_id=self.bank, document_id="synthetic-source")
        self.assertEqual(original.to_dict(), self.source_public)


if __name__ == "__main__":
    unittest.main()
