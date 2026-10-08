"""Atomic cleaner persistence tests against an explicitly isolated PostgreSQL.

Run directly with Python (no upstream conftest, models, or live service needed).
Set CLEANER_ATOMIC_TEST_DATABASE_URL to a disposable local cluster. The fixture
creates a random schema and drops only that schema after each test.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import time
import unittest
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse
from uuid import uuid4

import asyncpg

# Isolate this module from the engine's provider initialization and test conftest.
module_path = Path(__file__).parents[1] / "hindsight_api" / "engine" / "cleaner_atomic.py"
sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location("hindsight_api.engine.cleaner_atomic", module_path)
assert spec is not None and spec.loader is not None
atomic = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = atomic
spec.loader.exec_module(atomic)


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class CanonicalTests(unittest.TestCase):
    def test_javascript_number_and_unicode_serialization(self) -> None:
        self.assertEqual(
            atomic.canonical([1.0, 1e-6, 1e-7, 1e20, 1e21, -0.0]), "[1,0.000001,1e-7,100000000000000000000,1e+21,0]"
        )
        self.assertEqual(atomic.canonical({"é": "🌤", "a": {}, "中": None}), '{"a":{},"é":"🌤","中":null}')
        self.assertNotEqual(atomic.canonical({}), atomic.canonical(None))

    def test_candidate_character_boundaries(self) -> None:
        for character in ["x", "界", "🙂"]:
            for size, allowed in [(0, False), (1, True), (50_000, True), (50_001, False)]:
                with self.subTest(character_width=len(character.encode("utf-8")), size=size):
                    if allowed:
                        item = atomic.LiteralItem(
                            document_id="synthetic", content=character * size, timestamp="unset", metadata={}
                        )
                        self.assertEqual(len(item.content), size)
                    else:
                        with self.assertRaises(ValueError):
                            atomic.LiteralItem(
                                document_id="synthetic", content=character * size, timestamp="unset", metadata={}
                            )

    def test_nonfinite_numbers_rejected(self) -> None:
        for number in [float("nan"), float("inf"), float("-inf")]:
            with self.assertRaises(ValueError):
                atomic.canonical(number)

    def test_public_get_empty_provenance_projection(self) -> None:
        source = atomic.DocumentVersion(
            id="source",
            bank_id="synthetic",
            original_text="text",
            content_hash=digest("text"),
            retain_params={},
            tags=[],
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        public_shape = {"document_metadata": None, "tags": [], "retain_params": None}
        self.assertEqual(atomic.public_document_provenance(source).model_dump(mode="json"), public_shape)
        self.assertEqual(atomic.metadata_sha(source), digest(atomic.canonical(public_shape)))
        source.retain_params = {"metadata": {}}
        public_shape["retain_params"] = {"metadata": {}}
        self.assertEqual(atomic.public_document_provenance(source).model_dump(mode="json"), public_shape)

    def test_source_updated_metadata_mismatch_rejected(self) -> None:
        fixture = SimpleNamespace(
            bank="synthetic-bank", source_text="synthetic source", source_time=datetime(2026, 1, 1, tzinfo=UTC)
        )
        request = AtomicPersistenceTests.request(fixture)
        payload = json.loads(request.payload_json)
        payload["items"][0]["metadata"]["cleaner_source_updated_at"] = "2025-01-01T00:00:00+00:00"
        request.payload_json = canonical(payload)
        request.condition.payload_sha256 = digest(request.payload_json)
        with self.assertRaisesRegex(ValueError, "Source version provenance mismatch"):
            request.validated_payload()


class EngineBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_and_both_validators_precede_config_guard(self) -> None:
        from hindsight_api.engine import memory_engine
        from hindsight_api.engine.retain import embedding_processing
        from hindsight_api.models import RequestContext

        fixture = SimpleNamespace(
            bank="synthetic-bank", source_text="synthetic source", source_time=datetime(2026, 1, 1, tzinfo=UTC)
        )
        request = AtomicPersistenceTests.request(fixture)
        context = RequestContext()
        validator = SimpleNamespace(
            validate_bank_write=AsyncMock(return_value=None), validate_retain=AsyncMock(return_value=None)
        )

        async def validate(operation: Any) -> Any:
            return await operation

        engine = SimpleNamespace(
            _authenticate_tenant=AsyncMock(),
            _operation_validator=validator,
            _validate_operation=AsyncMock(side_effect=validate),
            embeddings=object(),
            _get_backend=AsyncMock(return_value=object()),
            _config_resolver=SimpleNamespace(
                get_bank_config=AsyncMock(
                    return_value={
                        "retain_extraction_mode": "chunks",
                        "enable_observations": False,
                    }
                )
            ),
        )

        @asynccontextmanager
        async def connection(backend: Any) -> Any:
            yield object()

        async def guarded(conn: Any, bound: Any, writer: Any, verify: Any) -> Any:
            await verify(conn, bound.condition)
            self.fail("Mismatched execution config reached a literal write")

        with (
            patch.object(
                atomic,
                "capabilities",
                AsyncMock(
                    return_value=atomic.Capabilities(
                        atomic_create=True, atomic_source_check=True, conditional_delete=True
                    )
                ),
            ),
            patch.object(embedding_processing, "generate_embeddings_batch", AsyncMock(return_value=[[0.0]])),
            patch.object(memory_engine, "acquire_with_retry", connection),
            patch.object(atomic, "create_on_connection", guarded),
        ):
            with self.assertRaisesRegex(atomic.CleanerConflict, "Execution config changed"):
                await atomic.engine_create(engine, request, context)
        engine._authenticate_tenant.assert_awaited_once_with(context)
        validator.validate_bank_write.assert_awaited_once()
        validator.validate_retain.assert_awaited_once()
        self.assertEqual(validator.validate_bank_write.call_args.args[0].bank_id, "synthetic-bank")
        self.assertEqual(validator.validate_retain.call_args.args[0].bank_id, "synthetic-bank")
        engine._config_resolver.get_bank_config.assert_awaited_once_with("synthetic-bank", context, cached=False)

    async def test_receipt_http_keeps_nullable_hash_fields(self) -> None:
        import httpx
        from fastapi import FastAPI

        from hindsight_api.api.http import ExcludeNoneRoute

        receipt = atomic.Receipt(
            condition_sha256="0" * 64,
            operation_id=uuid4(),
            payload_sha256="a" * 64,
            target_id="cleaner-v1-generic",
            owner_key="b" * 64,
            target_sha256="c" * 64,
            metadata_sha256="d" * 64,
            graph_sha256="e" * 64,
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
            rollback_operation_id=None,
            rollback_payload_sha256=None,
            created_receipt_sha256=None,
        )
        app = FastAPI()
        app.router.route_class = ExcludeNoneRoute

        @app.get("/receipt", response_model=atomic.Receipt)
        async def receipt_response() -> Any:
            return receipt

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/receipt")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        for name in ["rollback_operation_id", "rollback_payload_sha256", "created_receipt_sha256"]:
            self.assertIn(name, body)
            self.assertIsNone(body[name])
        self.assertEqual(
            digest(atomic.canonical(body)), digest(atomic.canonical(json.loads(receipt.model_dump_json())))
        )


class AtomicPersistenceTests(unittest.IsolatedAsyncioTestCase):
    """Use two real connections rather than mocks for transactional races."""

    async def asyncSetUp(self) -> None:
        database_url = os.environ.get("CLEANER_ATOMIC_TEST_DATABASE_URL")
        if not database_url:
            self.skipTest("Set CLEANER_ATOMIC_TEST_DATABASE_URL to an isolated disposable PostgreSQL")
        location = urlparse(database_url)
        if location.hostname not in {"127.0.0.1", "localhost"} or location.port in {None, 5432, 55438, 5556}:
            self.fail("Tests require an explicit non-service loopback port")
        self.conn = await asyncpg.connect(database_url)
        self.other = await asyncpg.connect(database_url)
        self.schema = "cleaner_test_" + uuid4().hex
        await self.conn.execute(f'CREATE SCHEMA "{self.schema}"')
        for connection in [self.conn, self.other]:
            await connection.execute(f'SET search_path TO "{self.schema}"')
        await self.conn.execute("""
            CREATE TABLE banks(bank_id TEXT PRIMARY KEY);
            CREATE TABLE documents(
                id TEXT NOT NULL, bank_id TEXT NOT NULL REFERENCES banks(bank_id),
                original_text TEXT, content_hash TEXT, metadata JSONB DEFAULT '{}',
                retain_params JSONB DEFAULT '{}', tags TEXT[] DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
                PRIMARY KEY(id,bank_id));
            CREATE TABLE chunks(
                chunk_id TEXT PRIMARY KEY, document_id TEXT, bank_id TEXT,
                chunk_index INTEGER, content TEXT, content_hash TEXT,
                FOREIGN KEY(document_id,bank_id) REFERENCES documents(id,bank_id) ON DELETE CASCADE);
            CREATE TABLE memory_units(
                id UUID PRIMARY KEY, bank_id TEXT, document_id TEXT, chunk_id TEXT,
                text TEXT, source_memory_ids UUID[],
                FOREIGN KEY(document_id,bank_id) REFERENCES documents(id,bank_id) ON DELETE CASCADE);
            CREATE TABLE memory_links(from_unit_id UUID, to_unit_id UUID, bank_id TEXT);
            CREATE TABLE unit_entities(unit_id UUID, entity_id UUID);
            INSERT INTO banks VALUES ('synthetic-bank');
        """)
        migration_path = module_path.parents[1] / "alembic" / "versions" / "6d90f17bc482_cleaner_atomic_receipts.py"
        migration_spec = importlib.util.spec_from_file_location("cleaner_migration_under_test", migration_path)
        assert migration_spec is not None and migration_spec.loader is not None
        migration = importlib.util.module_from_spec(migration_spec)
        migration_spec.loader.exec_module(migration)
        statements: list[str] = []
        with (
            patch.object(migration, "_schema", return_value=f'"{self.schema}".'),
            patch.object(migration.op, "execute", side_effect=statements.append),
        ):
            migration._pg_upgrade()
        for statement in statements:
            await self.conn.execute(statement)
        self.bank = "synthetic-bank"
        self.source_text = "Please implement the change. Historical event: 2020-01-02. Café 🌤."
        self.source_time = datetime(2026, 1, 1, tzinfo=UTC)
        self.table_patch = patch.object(atomic, "_table", lambda name: f'"{self.schema}".{name}')
        self.table_patch.start()
        await self.conn.execute(
            "INSERT INTO documents(id,bank_id,original_text,content_hash,metadata,retain_params,tags,updated_at) "
            "VALUES ('source',$1,$2,$3,'{}','{}','{}',$4)",
            self.bank,
            self.source_text,
            digest(self.source_text),
            self.source_time,
        )

    async def asyncTearDown(self) -> None:
        if hasattr(self, "conn"):
            self.table_patch.stop()
            await self.other.close()
            await self.conn.execute(f'DROP SCHEMA "{self.schema}" CASCADE')
            await self.conn.close()

    def request(self, target: str = "cleaner-v1-candidate") -> Any:
        operation_id = uuid4()
        content = "Please implement the change. Historical event: 2020-01-02. Café 🌤."
        owner_key = "a" * 64
        payload = {
            "async": True,
            "operation_id": str(operation_id),
            "items": [
                {
                    "document_id": target,
                    "content": content,
                    "timestamp": "unset",
                    "tags": [],
                    "metadata": {
                        "cleaner_owner": "hindsight-cleaner-v1",
                        "cleaner_owner_key": owner_key,
                        "cleaner_operation_id": str(operation_id),
                        "cleaner_source_sha256": digest(self.source_text),
                        "cleaner_source_id": "source",
                        "cleaner_source_metadata_sha256": digest(
                            canonical(
                                {
                                    "document_metadata": None,
                                    "tags": [],
                                    "retain_params": None,
                                }
                            )
                        ),
                        "cleaner_candidate_sha256": digest(content),
                        "cleaner_source_updated_at": self.source_time.isoformat(),
                    },
                }
            ],
        }
        payload_json = canonical(payload)
        return atomic.CreateRequest(
            condition=atomic.Condition(
                bank_id=self.bank,
                source_id="source",
                source_sha256=digest(self.source_text),
                source_updated_at=self.source_time,
                execution_config_sha256="b" * 64,
                source_metadata_sha256=digest(
                    canonical({"document_metadata": None, "tags": [], "retain_params": None})
                ),
                target_id=target,
                target_sha256=digest(content),
                owner_key=owner_key,
                operation_id=operation_id,
                payload_sha256=digest(payload_json),
            ),
            payload_json=payload_json,
        )

    async def verify_config(self, conn: Any, condition: Any) -> None:
        """No execution config exists in this persistence-only schema."""

    async def write_literal(self, conn: Any, bank: str, item: Any) -> None:
        chunk_id = item.document_id + "-chunk"
        await conn.execute(
            "INSERT INTO chunks(chunk_id,document_id,bank_id,chunk_index,content,content_hash) "
            "VALUES($1,$2,$3,0,$4,$5)",
            chunk_id,
            item.document_id,
            bank,
            item.content,
            digest(item.content),
        )
        await conn.execute(
            "INSERT INTO memory_units(id,bank_id,document_id,chunk_id,text) VALUES($1,$2,$3,$4,$5)",
            uuid4(),
            bank,
            item.document_id,
            chunk_id,
            item.content,
        )

    async def rollback_request(self, request: Any) -> Any:
        target = await atomic._document(self.conn, self.bank, request.condition.target_id)
        receipt = await atomic._receipt(self.conn, request.condition)
        rollback = atomic.RollbackRequest(
            condition=request.condition,
            expected_updated_at=target.updated_at,
            expected_document_metadata_sha256=atomic.metadata_sha(target),
            rollback_operation_id=uuid4(),
            rollback_payload_sha256="0" * 64,
            created_receipt_sha256=digest(canonical(json.loads(receipt.model_dump_json()))),
        )
        rollback.rollback_payload_sha256 = digest(
            canonical(rollback.model_dump(mode="json", exclude={"rollback_payload_sha256"}))
        )
        return rollback

    async def test_create_replay_and_rollback_preserve_source(self) -> None:
        request = self.request()
        created = await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        replay = await atomic.create_on_connection(self.other, request, self.write_literal, self.verify_config)
        self.assertFalse(created.reused)
        self.assertTrue(replay.reused)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM memory_units"), 1)
        rollback = await self.rollback_request(request)
        await atomic.rollback_on_connection(self.conn, rollback)
        await atomic.rollback_on_connection(self.other, rollback)
        self.assertEqual(
            await self.conn.fetchval("SELECT original_text FROM documents WHERE id='source'"), self.source_text
        )
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 1)
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)

    async def test_bank_deletion_cascades_receipts_and_tombstones(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        await atomic.rollback_on_connection(self.conn, await self.rollback_request(request))
        await self.conn.execute("DELETE FROM documents WHERE bank_id=$1", self.bank)
        await self.conn.execute("DELETE FROM banks WHERE bank_id=$1", self.bank)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_unit_ownership"), 0)

    async def test_same_operation_different_payload_rejected(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        changed = request.model_copy(deep=True)
        payload = json.loads(changed.payload_json)
        payload["items"][0]["tags"] = ["different"]
        changed.payload_json = canonical(payload)
        changed.condition.payload_sha256 = digest(changed.payload_json)
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.create_on_connection(self.other, changed, self.write_literal, self.verify_config)

    async def test_create_replay_rejects_changed_config_condition(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        changed = request.model_copy(deep=True)
        changed.condition.execution_config_sha256 = "f" * 64
        with self.assertRaisesRegex(atomic.CleanerConflict, "Operation binding mismatch"):
            await atomic.create_on_connection(self.other, changed, self.write_literal, self.verify_config)

    async def test_rollback_rejects_changed_source_condition(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        changed = await self.rollback_request(request)
        changed.condition.source_sha256 = "f" * 64
        changed.rollback_payload_sha256 = digest(
            atomic.canonical(changed.model_dump(mode="json", exclude={"rollback_payload_sha256"}))
        )
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.rollback_on_connection(self.other, changed)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 2)

    async def test_rollback_replay_rejects_different_operation(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        result = await atomic.rollback_on_connection(self.conn, rollback)
        self.assertEqual(result.rollback_operation_id, rollback.rollback_operation_id)
        changed = rollback.model_copy(deep=True)
        changed.rollback_operation_id = uuid4()
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.rollback_on_connection(self.other, changed)

    async def test_rollback_replay_revalidates_declared_payload_hash(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        await atomic.rollback_on_connection(self.conn, rollback)
        await atomic.rollback_on_connection(self.other, rollback)
        for field, value in [
            ("expected_updated_at", "2025-01-01T00:00:00+00:00"),
            ("expected_document_metadata_sha256", "f" * 64),
        ]:
            changed = rollback.model_copy(deep=True)
            setattr(changed, field, value)
            with self.assertRaises(atomic.CleanerConflict):
                await atomic.rollback_on_connection(self.other, changed)

    async def test_rollback_rejects_wrong_hashes_without_deletion(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        for field in ["created_receipt_sha256", "rollback_payload_sha256"]:
            changed = rollback.model_copy(deep=True)
            setattr(changed, field, "f" * 64)
            with self.assertRaises(atomic.CleanerConflict):
                await atomic.rollback_on_connection(self.other, changed)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 2)

    async def test_stale_source_rejected(self) -> None:
        request = self.request()
        await self.other.execute("UPDATE documents SET tags=ARRAY['changed'] WHERE id='source'")
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)

    async def test_target_collision_is_never_replaced(self) -> None:
        request = self.request()
        tx = self.other.transaction()
        await tx.start()
        await self.other.execute(
            "INSERT INTO documents(id,bank_id,original_text) VALUES('cleaner-v1-candidate',$1,'external')", self.bank
        )
        pending = asyncio.create_task(
            atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        )
        await asyncio.sleep(0.1)
        self.assertFalse(pending.done())
        await tx.commit()
        with self.assertRaises(atomic.CleanerConflict):
            await pending
        self.assertEqual(
            await self.conn.fetchval("SELECT original_text FROM documents WHERE id='cleaner-v1-candidate'"), "external"
        )
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)

    async def test_concurrent_source_replacement_revalidated(self) -> None:
        request = self.request()
        tx = self.other.transaction()
        await tx.start()
        await self.other.execute("UPDATE documents SET original_text='changed' WHERE id='source'")
        pending = asyncio.create_task(
            atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        )
        await asyncio.sleep(0.1)
        self.assertFalse(pending.done())
        await tx.commit()
        with self.assertRaises(atomic.CleanerConflict):
            await pending

    async def test_concurrent_source_deletion_revalidated(self) -> None:
        request = self.request()
        tx = self.other.transaction()
        await tx.start()
        await self.other.execute("DELETE FROM documents WHERE id='source'")
        pending = asyncio.create_task(
            atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        )
        await asyncio.sleep(0.1)
        self.assertFalse(pending.done())
        await tx.commit()
        with self.assertRaises(atomic.CleanerConflict):
            await pending
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)

    async def test_wrong_bank_has_no_write(self) -> None:
        request = self.request()
        request.condition.bank_id = "different-bank"
        await self.conn.execute("INSERT INTO banks VALUES('different-bank')")
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 1)

    async def test_cancellation_before_commit_leaves_no_candidate(self) -> None:
        entered = asyncio.Event()
        resume = asyncio.Event()

        async def paused_writer(conn: Any, bank: str, item: Any) -> None:
            await self.write_literal(conn, bank, item)
            entered.set()
            await resume.wait()

        pending = asyncio.create_task(
            atomic.create_on_connection(self.conn, self.request(), paused_writer, self.verify_config)
        )
        await asyncio.wait_for(entered.wait(), timeout=2)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 1)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM memory_units"), 0)

    async def test_failed_literal_write_rolls_back_document_and_receipt(self) -> None:
        async def failing(conn: Any, bank: str, item: Any) -> None:
            await self.write_literal(conn, bank, item)
            raise RuntimeError("synthetic failure")

        with self.assertRaises(RuntimeError):
            await atomic.create_on_connection(self.conn, self.request(), failing, self.verify_config)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 1)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM memory_units"), 0)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)

    async def test_oversize_candidate_rejected_before_writer_or_rows(self) -> None:
        request = self.request()
        payload = json.loads(request.payload_json)
        content = "🙂" * 50_001
        payload["items"][0]["content"] = content
        payload["items"][0]["metadata"]["cleaner_candidate_sha256"] = digest(content)
        request.condition.target_sha256 = digest(content)
        request.payload_json = canonical(payload)
        request.condition.payload_sha256 = digest(request.payload_json)
        writer = AsyncMock()
        with self.assertRaises(ValueError):
            await atomic.create_on_connection(self.conn, request, writer, self.verify_config)
        writer.assert_not_awaited()
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 1)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM cleaner_operations"), 0)

    async def test_bounded_rollback_contention_leaves_rows_and_receipt_unchanged(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        before_documents = await self.conn.fetch("SELECT * FROM documents ORDER BY id")
        before_receipt = await self.conn.fetchval("SELECT receipt FROM cleaner_operations")
        transaction = self.other.transaction()
        await transaction.start()
        try:
            await self.other.execute("LOCK TABLE memory_units IN ROW EXCLUSIVE MODE")
            started = time.monotonic()
            with self.assertRaises(asyncpg.LockNotAvailableError):
                await asyncio.wait_for(atomic.rollback_on_connection(self.conn, rollback), timeout=5)
            elapsed = time.monotonic() - started
            self.assertGreaterEqual(elapsed, 2.5)
            self.assertLess(elapsed, 5)
            self.assertEqual(await self.conn.fetch("SELECT * FROM documents ORDER BY id"), before_documents)
            self.assertEqual(await self.conn.fetchval("SELECT receipt FROM cleaner_operations"), before_receipt)
            self.assertFalse(await self.conn.fetchval("SELECT bool_or(rolled_back) FROM cleaner_unit_ownership"))
        finally:
            await transaction.rollback()

    async def test_changed_target_blocks_rollback(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        await self.other.execute("UPDATE chunks SET content='mutation' WHERE document_id='cleaner-v1-candidate'")
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.rollback_on_connection(self.conn, rollback)
        self.assertEqual(await self.conn.fetchval("SELECT count(*) FROM documents"), 2)

    async def test_external_observation_blocks_rollback(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        unit_id = await self.conn.fetchval("SELECT id FROM memory_units WHERE document_id='cleaner-v1-candidate'")
        observation = uuid4()
        await self.other.execute(
            "INSERT INTO memory_units(id,bank_id,text,source_memory_ids) VALUES($1,$2,'external observation',$3)",
            observation,
            self.bank,
            [unit_id],
        )
        with self.assertRaises(atomic.CleanerConflict):
            await atomic.rollback_on_connection(self.conn, rollback)
        self.assertEqual(
            await self.conn.fetchval("SELECT text FROM memory_units WHERE id=$1", observation), "external observation"
        )

    async def test_concurrent_external_observation_blocks_rollback(self) -> None:
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        unit_id = await self.conn.fetchval("SELECT id FROM memory_units WHERE document_id='cleaner-v1-candidate'")
        tx = self.other.transaction()
        await tx.start()
        await self.other.execute(
            "INSERT INTO memory_units(id,bank_id,text,source_memory_ids) VALUES($1,$2,'external observation',$3)",
            uuid4(),
            self.bank,
            [unit_id],
        )
        pending = asyncio.create_task(atomic.rollback_on_connection(self.conn, rollback))
        await asyncio.sleep(0.1)
        self.assertFalse(pending.done())
        await tx.commit()
        with self.assertRaises(atomic.CleanerConflict):
            await pending

    async def test_reference_waiting_behind_rollback_cannot_become_dangling(self) -> None:
        """A table lock alone cannot protect a non-FK UUID array after commit."""
        request = self.request()
        await atomic.create_on_connection(self.conn, request, self.write_literal, self.verify_config)
        rollback = await self.rollback_request(request)
        unit_id = await self.conn.fetchval("SELECT id FROM memory_units WHERE document_id='cleaner-v1-candidate'")
        locked = asyncio.Event()
        release = asyncio.Event()
        original_graph_sha = atomic._graph_sha

        async def paused_graph(conn: Any, bank: str, target: str) -> str:
            result = await original_graph_sha(conn, bank, target)
            locked.set()
            await release.wait()
            return result

        with patch.object(atomic, "_graph_sha", paused_graph):
            deletion = asyncio.create_task(atomic.rollback_on_connection(self.conn, rollback))
            await asyncio.wait_for(locked.wait(), timeout=2)
            insertion = asyncio.create_task(
                self.other.execute(
                    "INSERT INTO memory_units(id,bank_id,text,source_memory_ids) VALUES($1,$2,'late observation',$3)",
                    uuid4(),
                    self.bank,
                    [unit_id],
                )
            )
            await asyncio.sleep(0.1)
            self.assertFalse(insertion.done())
            release.set()
            await deletion
            try:
                await insertion
            except asyncpg.PostgresError:
                pass  # Required: an enforced source-reference constraint rejects stale insertion.
            self.assertEqual(
                await self.conn.fetchval(
                    "SELECT count(*) FROM memory_units WHERE source_memory_ids && $1::uuid[]", [unit_id]
                ),
                0,
                "A resumed writer inserted an observation referencing deleted units",
            )


if __name__ == "__main__":
    unittest.main()
