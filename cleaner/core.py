"""No network, model calls, or source writes. Classifications remain review hints."""

from __future__ import annotations

import collections
import difflib
import hashlib
import itertools
import json
import os
import re
import shutil
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .models import (
    BankProject,
    BoilerplateProposal,
    Candidate,
    Coverage,
    Document,
    DuplicateGroup,
    Fence,
    Identity,
    JSONValue,
    LocalMetadata,
    Normalization,
    Offset,
    Omission,
    OverlapGroup,
    PatternRule,
    PreviewRequest,
    Receipt,
    Redaction,
    Reference,
    Report,
    SecretFinding,
    SectionFingerprint,
    SectionReference,
    Segment,
    SourceIndex,
    SourcePoints,
    SourceSection,
    Summary,
    TransferDocument,
    TransferManifest,
    TransferMetadata,
    Transformation,
    parse_model,
    to_json,
)

VERSION = "1.0.0"
MAX_BYTES = 256 * 1024 * 1024


@dataclass
class SecretPattern:
    name: str
    pattern: re.Pattern[str]


SECRET_PATTERNS = [
    SecretPattern(
        "authorization-value",
        re.compile("(?im)authorization\\s*[:=]\\s*(?:Bearer|Basic)\\s+([^\\r\\n]+)"),
    ),
    SecretPattern(
        "quoted-credential",
        re.compile(
            "(?im)(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)\\s*[:=]\\s*[\"\\']([^\"\\'\\r\\n]+)[\"\\']"
        ),
    ),
    SecretPattern(
        "url-query-credential",
        re.compile("(?i)[?&](?:api[_-]?key|access[_-]?token|token|password|secret|key)=([^&#\\s]+)"),
    ),
    SecretPattern(
        "private-key",
        re.compile("-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\\s\\S]*?(?:-----END [^\\n]*PRIVATE KEY-----|$)"),
    ),
    SecretPattern(
        "credential",
        re.compile(
            "(?im)(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)\\s*[:=]\\s*[\"\\']?([^\\s\"\\'`,;]{8,})"
        ),
    ),
    SecretPattern(
        "provider-token",
        re.compile("\\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\\b"),
    ),
    SecretPattern(
        "jwt",
        re.compile("\\beyJ[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b"),
    ),
    SecretPattern("url-credential", re.compile("https?://[^\\s/@:]+:[^\\s/@]+@[^\\s]+")),
]
DATE = re.compile("\\b\\d{4}-\\d{2}-\\d{2}(?:T[\\d:.+-]+Z?)?\\b")
CITATION = re.compile(
    "https?://[^\\s<>]+|\\[[^\\]\\n]+\\]\\([^\\)\\n]+\\)|\\[\\^[^\\]\\n]+\\]|(?:source[_ -]?id|document[_ -]?id)\\s*[:=]\\s*\\S+",
    re.IGNORECASE,
)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def redact(text: str) -> Redaction:
    spans: list[SecretFinding] = []
    for rule in SECRET_PATTERNS:
        for match in rule.pattern.finditer(text):
            span = (
                match.span(1)
                if rule.name
                in (
                    "credential",
                    "authorization-value",
                    "quoted-credential",
                    "url-query-credential",
                )
                else match.span()
            )
            spans.append(SecretFinding(span[0], span[1], rule.name))
    merged: list[SecretFinding] = []
    # Union overlapping matches so fragments of a credential never remain.
    for finding in sorted(spans, key=lambda item: (item.start, item.end, item.kind)):
        if merged and finding.start <= merged[-1].end:
            merged[-1].end = max(finding.end, merged[-1].end)
        else:
            merged.append(finding)
    result = text
    for finding in reversed(merged):
        result = result[: finding.start] + "[REDACTED: review required]" + result[finding.end :]
    return Redaction(result, merged)


def redact_slice(raw: str, start: int, end: int, secrets: list[SecretFinding]) -> str:
    text = raw[start:end]
    for finding in reversed(secrets):
        left = max(start, finding.start)
        right = min(end, finding.end)
        if left < right:
            text = text[: left - start] + "[REDACTED: review required]" + text[right - start :]
    return text


def safe_value(value: JSONValue) -> JSONValue:
    if isinstance(value, str):
        return redact(value).text
    if isinstance(value, list):
        return [safe_value(item) for item in value]
    if isinstance(value, dict):
        # Metadata keys are caller-defined. This is the only dynamic data map.
        return {
            redact(key).text: (
                "[REDACTED: review required]"
                if re.search(
                    r"(?i)(?:password|secret|api[_ -]?key|access[_ -]?token|authorization|(?:^|[_ -])token(?:$|[_ -]))",
                    key,
                )
                and item
                else safe_value(item)
            )
            for key, item in value.items()
        }
    return value


def _next_fence(line: str, marker: re.Match[str], fence: Fence | None) -> Fence | None:
    token = marker.group(1)
    if fence is None and (token[0] != "`" or "`" not in line[marker.end() :]):
        return Fence(token[0], len(token))
    if (
        fence is not None
        and token[0] == fence.character
        and len(token) >= fence.length
        and not line[marker.end() :].strip()
    ):
        return None
    return fence


def boundaries(text: str) -> list[int]:
    """Exact character offsets at headings/source labels outside fenced code."""
    points = [0]
    offset = 0
    fence: Fence | None = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            fence = _next_fence(line, marker, fence)
        elif (
            fence is None
            and (re.match(r"^\s{0,3}#{1,6}\s+\S", line) or re.match(r"^(?:Source|SOURCE|File|FILE):\s+\S", line))
            and offset
        ):
            points.append(offset)
        offset += len(line)
    return sorted(set(points + [len(text)]))


def normalize(text: str) -> Normalization:
    # No line removal, date repair, Unicode normalization, deduplication, or rewriting.
    out: list[str] = []
    changes: list[Transformation] = []
    fence: Fence | None = None
    offset = 0
    for line in text.splitlines(keepends=True):
        original = line
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            fence = _next_fence(line, marker, fence)
        elif fence is None:
            newline = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
            body = line[: -len(newline)] if newline else line
            # Markdown two-space hard breaks are semantic; preserve trailing whitespace.
            line = re.sub(r"^(#{1,6})[ \t]{2,}(?=\S)", r"\1 ", body) + newline
        if line != original:
            changes.append(Transformation(offset, offset + len(original)))
        out.append(line)
        offset += len(original)
    return Normalization("".join(out), changes)


def boilerplate_proposals(text: str) -> list[BoilerplateProposal]:
    """Repeated lines are hints only; never delete them or touch fenced code."""
    seen: dict[str, list[Offset]] = {}
    offset = 0
    fence: Fence | None = None
    for line in text.splitlines(keepends=True):
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            fence = _next_fence(line, marker, fence)
        elif fence is None and 15 <= len(line.strip()) <= 300:
            seen.setdefault(digest(line), []).append(Offset(offset, offset + len(line)))
        offset += len(line)
    return [
        BoilerplateProposal(sha, len(spans), spans[:100], len(spans) > 100)
        for sha, spans in seen.items()
        if len(spans) >= 3
    ][:100]


def hints(text: str) -> list[str]:
    flags = ["uncertain: classifications are lexical review hints, never authoritative"]
    checks = [
        PatternRule("instruction", r"(?im)\b(?:must|should|please|implement|TODO|do not)\b"),
        PatternRule("observation", r"(?im)\b(?:observed|found|measured|tested|screenshot)\b"),
        PatternRule("historical", r"(?im)\b(?:previous|historical|formerly|was|yesterday)\b"),
        PatternRule("current", r"(?im)\b(?:currently|current|now)\b"),
        PatternRule(
            "possible-conflict",
            r"(?im)\b(?:contradict\w*|conflict\w*|supersed\w*|deprecated|obsolete)\b",
        ),
    ]
    return flags + [rule.name for rule in checks if re.search(rule.pattern, text)]


def _check_section(raw: str, section: SourceSection) -> None:
    if not 0 <= section.character_start <= section.character_end <= len(raw) or (
        digest(raw[section.character_start : section.character_end]) != section.section_sha256
    ):
        raise ValueError("Section provenance mismatch")


def apply_source_index(documents: list[Document], index: SourceIndex) -> list[Document]:
    """Reuse generic verified section mappings; never load a project-specific index."""
    matches = {Identity("", entry.original_bank, entry.original_document_id): entry for entry in index.documents}
    for doc in documents:
        entry = matches.get(Identity("", doc.bank_id, doc.id))
        if entry is None:
            continue
        if entry.original_sha256 != digest(doc.original_text):
            raise ValueError("Audit source digest mismatch")
        for section in entry.sections:
            _check_section(doc.original_text, section)
        doc.metadata = {
            **doc.metadata,
            "source_sections": [to_json(section) for section in entry.sections],
            "audit_schema": index.schema,
        }
    return documents


def verified_source_points(raw: str, metadata: dict[str, JSONValue]) -> SourcePoints:
    entries = metadata.get("source_sections", [])
    if not isinstance(entries, list):
        raise ValueError("Expected source section array")  # noqa: TRY004 - preserve JSON validation error_type.
    requested: set[int] = set()
    for entry in entries:
        section = parse_model(SourceSection, entry)
        _check_section(raw, section)
        requested.update((section.character_start, section.character_end))
    accepted: set[int] = set()
    offset = 0
    fence: Fence | None = None
    for line in raw.splitlines(keepends=True):
        if offset in requested and fence is None:
            accepted.add(offset)
        marker = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if marker:
            fence = _next_fence(line, marker, fence)
        offset += len(line)
    if len(raw) in requested and fence is None:
        accepted.add(len(raw))
    return SourcePoints(accepted, len(requested - accepted))


def parse_documents(value: object) -> list[Document]:
    """Normalize JSON once, before any cleaner algorithm sees source data."""
    if isinstance(value, list):
        return [parse_model(Document, entry) for entry in value]
    return parse_model(PreviewRequest, value).documents


def _check_boundaries(documents: list[Document], bank_id: str | None, project_id: str | None) -> None:
    if any((bank_id and doc.bank_id != bank_id) or (project_id and doc.project_id != project_id) for doc in documents):
        raise ValueError("Selected JSON bank/project boundary mismatch")


def read_documents(path: str | Path, bank_id: str | None = None, project_id: str | None = None) -> list[Document]:
    path = Path(path)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Input exceeds 256 MiB limit")
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 10000 or sum(info.file_size for info in infos) > MAX_BYTES:
                raise ValueError("Archive exceeds bounded import limits")
            names = [info.filename for info in infos]
            if len(names) != len(set(names)):
                raise ValueError("Duplicate archive members")
            manifest = parse_model(TransferManifest, json.loads(archive.read("manifest.json")))
            if manifest.schema_version != 1 or manifest.archive_type != "documents":
                raise ValueError("Only Hindsight schema 1 document-transfer exports supported")
            bank = manifest.source_bank_id
            if not bank or (bank_id and bank_id != bank):
                raise ValueError("Transfer bank boundary mismatch")
            docs: list[Document] = []
            for name in sorted(names):
                if re.fullmatch(r"documents/\d+\.json", name):
                    doc = parse_model(TransferDocument, json.loads(archive.read(name)))
                    docs.append(
                        Document(
                            bank,
                            project_id or bank,
                            doc.id,
                            doc.original_text,
                            cast(
                                dict[str, JSONValue],
                                to_json(
                                    TransferMetadata(
                                        doc.created_at, doc.retain_params, doc.tags, len(doc.facts), len(doc.chunks)
                                    )
                                ),
                            ),
                        )
                    )
            if len(docs) != manifest.document_count:
                raise ValueError("Manifest document count mismatch")
            return docs
    if path.suffix.lower() == ".json":
        docs = parse_documents(json.loads(path.read_text("utf-8")))
        _check_boundaries(docs, bank_id, project_id)
        return docs
    if path.suffix.lower() not in (".md", ".markdown", ".txt"):
        raise ValueError("Supported inputs: JSON, document-transfer ZIP, Markdown, text")
    if not bank_id or not project_id:
        raise ValueError("Text inputs require explicit bank and project IDs")
    return [
        Document(
            bank_id,
            project_id,
            path.name,
            path.read_text("utf-8"),
            cast(dict[str, JSONValue], to_json(LocalMetadata(path.name))),
        )
    ]


def preview(
    documents: list[Document],
    split_chars: int = 120000,
    cancelled: Callable[[], bool] | None = None,
    preview_chars: int = 12000,
) -> Report:
    if len(documents) > 5000:
        raise ValueError("Expected at most 5000 documents")
    if not 100 <= split_chars <= MAX_BYTES:
        raise ValueError("Invalid split target")
    cancelled = cancelled or (lambda: False)
    identities: set[Identity] = set()
    for doc in documents:
        identity = Identity(doc.project_id, doc.bank_id, doc.id)
        if identity in identities:
            raise ValueError("Duplicate document identity")
        identities.add(identity)
    if sum(len(doc.original_text.encode()) for doc in documents) > MAX_BYTES:
        raise ValueError("Batch exceeds 256 MiB")
    # Preserve the original wire fingerprint exactly, including ordered positional fields.
    fingerprint = json.dumps(
        [
            [
                doc.project_id,
                doc.bank_id,
                doc.id,
                digest(doc.original_text),
                safe_value(doc.metadata),
            ]
            for doc in documents
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    batch_id = digest(VERSION + str(split_chars) + str(preview_chars) + fingerprint)[:24]
    result = Report(batch_id, VERSION)
    exact: dict[str, list[Reference]] = {}
    sections: dict[str, list[SectionReference]] = {}
    for doc in documents:
        if cancelled():
            result.status = "cancelled"
            break
        raw = doc.original_text
        normalized = normalize(raw)
        safe_raw = redact(raw)
        safe_candidate = redact(normalized.text).text
        source = verified_source_points(raw, doc.metadata)
        points = sorted(set(boundaries(raw)) | source.accepted)
        segments: list[Segment] = []
        ranges: list[Offset] = []
        start = previous = 0
        for end in points[1:]:
            if end - start > split_chars and previous > start:
                ranges.append(Offset(start, previous))
                start = previous
            if end - start >= split_chars or end == len(raw) or end in source.accepted:
                ranges.append(Offset(start, end))
                start = end
            previous = end
        for span in ranges:
            piece = raw[span.start : span.end]
            redacted = normalize(redact_slice(raw, span.start, span.end, safe_raw.findings)).text
            segment_id = digest(
                doc.project_id + "\0" + doc.bank_id + "\0" + doc.id + "\0" + str(span.start) + "\0" + digest(piece)
            )[:24]
            segments.append(
                Segment(
                    span.start,
                    span.end,
                    segment_id,
                    digest(piece),
                    redacted,
                    span.end - span.start > split_chars,
                )
            )
        if raw == "":
            segments = [Segment(0, 0, digest(doc.id + "empty")[:24], digest(""), "", False)]
        ref = Reference(redact(doc.bank_id).text, redact(doc.project_id).text, redact(doc.id).text)
        exact.setdefault(digest(raw), []).append(ref)
        inventory: list[SectionFingerprint] = []
        for a, b in itertools.pairwise(points):
            piece = raw[a:b]
            if len(piece.strip()) >= 80:
                sha = digest(piece)
                sections.setdefault(sha, []).append(SectionReference(ref.bank_id, ref.project_id, ref.id, a, b))
                inventory.append(SectionFingerprint(a, b, sha))
        dates = collections.Counter(DATE.findall(raw))
        cites = collections.Counter(CITATION.findall(raw))
        kept_dates = collections.Counter(DATE.findall(safe_candidate))
        kept_cites = collections.Counter(CITATION.findall(safe_candidate))
        omitted_dates = sum((dates - kept_dates).values())
        omitted_cites = sum((cites - kept_cites).values())
        omissions = [Omission(omitted_dates, omitted_cites)] if omitted_dates or omitted_cites else []
        flags = hints(raw)
        safe_metadata = safe_value(doc.metadata)
        metadata_secret = safe_metadata != doc.metadata or any(
            redact(value).findings for value in (doc.id, doc.bank_id, doc.project_id)
        )
        if safe_raw.findings or metadata_secret:
            flags.append("possible-secret: candidate quarantined; explicit review required")
        if any(segment.oversized for segment in segments):
            flags.append("oversized-section: safe boundary unavailable; retained intact")
        diff = "".join(
            difflib.unified_diff(
                safe_raw.text[:preview_chars].splitlines(True),
                safe_candidate[:preview_chars].splitlines(True),
                fromfile="original (redacted)",
                tofile="candidate (redacted)",
            )
        )
        truncated = len(safe_raw.text) > preview_chars or len(safe_candidate) > preview_chars
        result.documents.append(
            Candidate(
                bank_id=ref.bank_id,
                project_id=ref.project_id,
                id=ref.id,
                raw_sha256=digest(raw),
                status="quarantined" if safe_raw.findings or metadata_secret else "candidate",
                flags=flags,
                metadata=safe_metadata,
                raw_characters=len(raw),
                candidate_characters=len(safe_candidate),
                original_preview=safe_raw.text[:preview_chars],
                candidate_preview=safe_candidate[:preview_chars],
                preview_truncated=truncated,
                diff=diff,
                diff_truncated=truncated,
                transformations=normalized.changes,
                boilerplate_proposals=boilerplate_proposals(raw),
                segments=segments,
                secret_findings=safe_raw.findings,
                section_inventory=inventory,
                coverage=Coverage(
                    sum(segment.end - segment.start for segment in segments),
                    sum(dates.values()),
                    sum((dates & kept_dates).values()),
                    sum(cites.values()),
                    sum((cites & kept_cites).values()),
                    omissions,
                    len(source.accepted),
                    source.rejected,
                    sum(finding.end - finding.start for finding in safe_raw.findings),
                ),
            )
        )
        if cancelled():
            result.status = "cancelled"
            break
    for sha, refs in exact.items():
        if len(refs) > 1:
            result.duplicates.append(
                DuplicateGroup(
                    sha,
                    refs,
                    len({BankProject(ref.bank_id, ref.project_id) for ref in refs}) > 1,
                )
            )
    for sha, sources in sections.items():
        if len(sources) > 1:
            result.overlaps.append(
                OverlapGroup(
                    sha,
                    sources,
                    len({BankProject(ref.bank_id, ref.project_id) for ref in sources}) > 1,
                )
            )
    if result.status == "cancelled":
        result.batch_id = digest(batch_id + "cancelled" + str(len(result.documents)))[:24]
    result.summary = Summary(
        len(result.documents),
        len(documents),
        sum(doc.status == "quarantined" for doc in result.documents),
        sum(len(doc.segments) for doc in result.documents),
        sum(len(doc.transformations) for doc in result.documents),
        sum(doc.raw_characters for doc in result.documents),
        len(result.duplicates),
        len(result.overlaps),
    )
    return result


def write_batch(report: Report, output: str | Path) -> Path:
    """Versioned immutable reports/candidates. Never writes a raw original."""
    if not re.fullmatch(r"[a-f0-9]{24}", report.batch_id) or any(
        not re.fullmatch(r"[a-f0-9]{24}", segment.id) for doc in report.documents for segment in doc.segments
    ):
        raise ValueError("Invalid output identity")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = output / report.batch_id
    payload = to_json(report)
    if destination.exists():
        existing = json.loads((destination / "report.json").read_text())
        if existing != payload:
            raise ValueError("Existing batch differs; refusing overwrite")
        write_receipt(output, report.batch_id)
        return destination
    temporary = Path(tempfile.mkdtemp(prefix=".candidate-", dir=output))
    try:
        (temporary / "report.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
        for index, doc in enumerate(report.documents):
            if doc.status == "quarantined":
                continue
            folder = temporary / f"document-{index:04d}"
            folder.mkdir()
            for segment in doc.segments:
                (folder / (segment.id + ".md")).write_text(segment.text, encoding="utf-8")
        for path in temporary.rglob("*"):
            if path.is_file():
                path.chmod(0o600)
        temporary.rename(destination)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    write_receipt(output, report.batch_id)
    return destination


def write_receipt(output: Path, batch_id: str) -> None:
    # Receipt is a mutable pointer; content-addressed batch files stay immutable.
    receipt = Receipt(batch_id, batch_id + "/report.json")
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=output)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(to_json(receipt), stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        Path(temporary).chmod(0o600)
        os.replace(temporary, output / "receipt.json")
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
