"""Typed records and validated JSON boundaries for the deterministic cleaner."""

from __future__ import annotations

import types
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from typing import (
    ForwardRef,
    TypeAlias,
    TypeVar,
    Union,
    cast,
    get_args,
    get_origin,
    get_type_hints,
)

JSONValue: TypeAlias = str | int | float | bool | None | list["JSONValue"] | dict[str, "JSONValue"]
T = TypeVar("T")


def _validate(value: object, expected: object) -> object:
    if expected == "JSONValue" or (isinstance(expected, ForwardRef) and expected.__forward_arg__ == "JSONValue"):
        expected = JSONValue
    origin = get_origin(expected)
    args = get_args(expected)
    if origin in (types.UnionType, Union):
        for choice in args:
            try:
                return _validate(value, choice)
            except ValueError:
                pass
        raise ValueError("Invalid JSON field type")
    if origin is list:
        if not isinstance(value, list):
            raise ValueError("Expected JSON array")
        return [_validate(item, args[0]) for item in value]
    if origin is dict:
        if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
            raise ValueError("Expected JSON object")
        return {key: _validate(item, args[1]) for key, item in value.items()}
    if isinstance(expected, type) and is_dataclass(expected):
        return parse_model(expected, value)
    if expected is type(None):
        if value is None:
            return value
    elif expected in (str, int, float, bool) and type(value) is expected:
        return value
    raise ValueError("Invalid JSON field type")


def parse_model(model: type[T], value: object) -> T:
    """Validate known fields recursively; ignore unknown exporter extension fields."""
    if not is_dataclass(model):
        raise ValueError("Expected dataclass model")
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object")  # noqa: TRY004 - boundary validation uses ValueError.
    annotations = get_type_hints(model)
    arguments = {
        item.name: _validate(value[item.name], annotations[item.name]) for item in fields(model) if item.name in value
    }
    try:
        return model(**arguments)
    except TypeError as exc:
        raise ValueError("Missing required JSON field") from exc


def to_json(model: object) -> JSONValue:
    if not is_dataclass(model) or isinstance(model, type):
        raise ValueError("Expected typed record")
    return cast(JSONValue, _validate(asdict(model), JSONValue))


@dataclass
class Document:
    bank_id: str
    project_id: str
    id: str
    original_text: str
    metadata: dict[str, JSONValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.bank_id or not self.project_id or not self.id:
            raise ValueError("Document identities must be nonempty")


@dataclass
class PreviewRequest:
    documents: list[Document]
    split_chars: int | None = None


@dataclass(frozen=True)
class Identity:
    project_id: str
    bank_id: str
    id: str


@dataclass(frozen=True)
class BankProject:
    bank_id: str
    project_id: str


@dataclass
class Offset:
    start: int
    end: int


@dataclass
class SecretFinding(Offset):
    kind: str


@dataclass
class Redaction:
    text: str
    findings: list[SecretFinding]


@dataclass
class Transformation(Offset):
    transform: str = "heading-spacing"


@dataclass
class Normalization:
    text: str
    changes: list[Transformation]


@dataclass
class Fence:
    character: str
    length: int


@dataclass
class PatternRule:
    name: str
    pattern: str


@dataclass
class BoilerplateProposal:
    sha256: str
    occurrences: int
    source_offsets: list[Offset]
    offsets_truncated: bool
    kind: str = "repeated-line-review"
    action: str = "proposal-only; retained unchanged"


@dataclass
class SourceSection:
    character_start: int
    character_end: int
    section_sha256: str
    section_id: JSONValue = None


@dataclass
class IndexedDocument:
    original_bank: str
    original_document_id: str
    original_sha256: str
    sections: list[SourceSection] = field(default_factory=list)


@dataclass
class SourceIndex:
    documents: list[IndexedDocument] = field(default_factory=list)
    schema: JSONValue = None


@dataclass
class SourcePoints:
    accepted: set[int]
    rejected: int


@dataclass
class TransferManifest:
    schema_version: int
    archive_type: str
    source_bank_id: str
    document_count: int


@dataclass
class TransferDocument:
    id: str
    original_text: str
    created_at: JSONValue = None
    retain_params: JSONValue = None
    tags: JSONValue = None
    facts: list[JSONValue] = field(default_factory=list)
    chunks: list[JSONValue] = field(default_factory=list)


@dataclass
class TransferMetadata:
    created_at: JSONValue
    retain_params: JSONValue
    tags: JSONValue
    fact_count: int
    chunk_count: int
    transfer_schema: int = 1


@dataclass
class LocalMetadata:
    source_filename: str


@dataclass
class Reference:
    bank_id: str
    project_id: str
    id: str


@dataclass
class SectionReference(Reference):
    start: int
    end: int


@dataclass
class SectionFingerprint(Offset):
    sha256: str


@dataclass
class Segment(Offset):
    id: str
    sha256: str
    text: str
    oversized: bool


@dataclass
class Omission:
    date_occurrences: int
    citation_occurrences: int
    reason: str = "secret-protection redaction; explicit review required"


@dataclass
class Coverage:
    source_characters_mapped: int
    dates_total: int
    dates_preserved: int
    citation_occurrences_total: int
    citation_occurrences_preserved: int
    omissions: list[Omission]
    audit_source_boundaries_reused: int
    audit_boundaries_rejected_inside_code_or_midline: int
    redacted_characters: int
    semantic_rewrite: bool = False


@dataclass
class Candidate(Reference):
    raw_sha256: str
    status: str
    flags: list[str]
    metadata: JSONValue
    raw_characters: int
    candidate_characters: int
    original_preview: str
    candidate_preview: str
    preview_truncated: bool
    diff: str
    diff_truncated: bool
    transformations: list[Transformation]
    boilerplate_proposals: list[BoilerplateProposal]
    segments: list[Segment]
    secret_findings: list[SecretFinding]
    section_inventory: list[SectionFingerprint]
    coverage: Coverage


@dataclass
class DuplicateGroup:
    sha256: str
    documents: list[Reference]
    cross_boundary: bool
    action: str = "report-only"


@dataclass
class OverlapGroup:
    sha256: str
    sources: list[SectionReference]
    cross_boundary: bool
    action: str = "report-only"


@dataclass
class Policy:
    live_apply: bool = False
    raw_export: bool = False
    classifications_authoritative: bool = False
    cross_boundary_merge: bool = False


@dataclass
class Summary:
    documents_processed: int = 0
    documents_requested: int = 0
    quarantined: int = 0
    segments: int = 0
    formatting_changes: int = 0
    raw_characters: int = 0
    duplicate_groups: int = 0
    overlap_groups: int = 0


@dataclass
class Report:
    batch_id: str
    engine_version: str
    schema_version: int = 1
    status: str = "completed"
    documents: list[Candidate] = field(default_factory=list)
    duplicates: list[DuplicateGroup] = field(default_factory=list)
    overlaps: list[OverlapGroup] = field(default_factory=list)
    summary: Summary = field(default_factory=Summary)
    policy: Policy = field(default_factory=Policy)


@dataclass
class Receipt:
    batch_id: str
    report_path: str


@dataclass
class ErrorResponse:
    error_type: str
    status: str = "error"
    message: str = "Input rejected or local output unavailable; check format, boundaries, and permissions."
