"""Durable cleaner receipts and source-reference tombstones.

Revision ID: 6d90f17bc482
Revises: e5b1c7d3a902
"""

from collections.abc import Sequence

from alembic import context, op

from hindsight_api.alembic._dialect import run_for_dialect

revision: str = "6d90f17bc482"
down_revision: str | Sequence[str] | None = "e5b1c7d3a902"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _schema() -> str:
    schema = context.config.get_main_option("target_schema")
    return f'"{schema}".' if schema else ""


def _pg_upgrade() -> None:
    schema = _schema()
    op.execute(f"""CREATE TABLE {schema}cleaner_operations (
        bank_id TEXT NOT NULL REFERENCES {schema}banks(bank_id) ON DELETE CASCADE,
        operation_id UUID NOT NULL, payload_sha256 TEXT NOT NULL, receipt JSONB NOT NULL,
        PRIMARY KEY(bank_id,operation_id))""")
    # No FK to memory_units: ownership survives deletion as a denial tombstone.
    op.execute(f"""CREATE TABLE {schema}cleaner_unit_ownership (
        unit_id UUID PRIMARY KEY, bank_id TEXT NOT NULL, operation_id UUID NOT NULL,
        rolled_back BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY(bank_id,operation_id)
            REFERENCES {schema}cleaner_operations(bank_id,operation_id) ON DELETE CASCADE)""")
    op.execute(f"""CREATE FUNCTION {schema}cleaner_check_sources() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE owned RECORD;
    BEGIN
        IF NEW.source_memory_ids IS NOT NULL THEN
            FOR owned IN SELECT unit_id,rolled_back FROM {schema}cleaner_unit_ownership
                WHERE unit_id=ANY(NEW.source_memory_ids) ORDER BY unit_id FOR SHARE
            LOOP
                IF owned.rolled_back THEN
                    RAISE EXCEPTION 'Cleaner source was rolled back' USING ERRCODE='23503';
                END IF;
            END LOOP;
        END IF;
        RETURN NEW;
    END $$""")
    op.execute(f"""CREATE TRIGGER cleaner_source_liveness BEFORE INSERT OR UPDATE OF source_memory_ids
        ON {schema}memory_units FOR EACH ROW EXECUTE FUNCTION {schema}cleaner_check_sources()""")


def _pg_downgrade() -> None:
    # A downgrade must not silently remove tombstone protection with live receipts.
    schema = _schema()
    op.execute(f"""DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM {schema}cleaner_operations) THEN
            RAISE EXCEPTION 'Cleaner receipts exist; export and review before downgrade';
        END IF;
    END $$""")
    op.execute(f"DROP TRIGGER cleaner_source_liveness ON {schema}memory_units")
    op.execute(f"DROP FUNCTION {schema}cleaner_check_sources()")
    op.execute(f"DROP TABLE {schema}cleaner_unit_ownership")
    op.execute(f"DROP TABLE {schema}cleaner_operations")


def _oracle_upgrade() -> None:
    # Capability is explicitly PostgreSQL-only, never a silent unsafe fallback.
    pass


def _oracle_downgrade() -> None:
    pass


def upgrade() -> None:
    run_for_dialect(pg=_pg_upgrade, oracle=_oracle_upgrade)


def downgrade() -> None:
    run_for_dialect(pg=_pg_downgrade, oracle=_oracle_downgrade)
