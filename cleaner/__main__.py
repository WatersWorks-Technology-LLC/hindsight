"""JSON CLI boundary for the typed deterministic cleaner."""

from __future__ import annotations

import argparse
import json
import signal
import sys
from dataclasses import dataclass
from types import FrameType

from .core import (
    apply_source_index,
    parse_documents,
    preview,
    read_documents,
    write_batch,
)
from .models import ErrorResponse, PreviewRequest, SourceIndex, parse_model, to_json


@dataclass
class Cancellation:
    requested: bool = False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preview-only document cleaning; never writes Hindsight or raw originals"
    )
    parser.add_argument("command", choices=["preview"])
    parser.add_argument("input", help="JSON/ZIP/Markdown/text file, or - for normalized JSON stdin")
    parser.add_argument("--max-documents", type=int, default=5000)
    parser.add_argument("--source-index", help="Generic source-index JSON with verified hashes/offsets")
    parser.add_argument("--bank")
    parser.add_argument("--project")
    parser.add_argument("--output")
    parser.add_argument("--split-chars", type=int, default=120000)
    args = parser.parse_args()
    stop = Cancellation()

    def interrupt(signum: int, frame: FrameType | None) -> None:
        stop.requested = True

    signal.signal(signal.SIGINT, interrupt)
    try:
        if args.input == "-":
            data: object = json.load(sys.stdin)
            if isinstance(data, list):
                docs = parse_documents(data)
            else:
                request = parse_model(PreviewRequest, data)
                if request.split_chars is not None:
                    args.split_chars = request.split_chars
                docs = request.documents
        else:
            docs = read_documents(args.input, args.bank, args.project)
        if len(docs) > args.max_documents:
            raise ValueError("Document selection exceeds configured bound")
        if any(
            (args.bank and doc.bank_id != args.bank) or (args.project and doc.project_id != args.project)
            for doc in docs
        ):
            raise ValueError("Selected bank/project boundary mismatch")
        if args.source_index:
            with open(args.source_index, encoding="utf-8") as stream:
                index = parse_model(SourceIndex, json.load(stream))
            docs = apply_source_index(docs, index)
        report = preview(docs, args.split_chars, lambda: stop.requested)
        if args.output:
            write_batch(report, args.output)
        json.dump(to_json(report), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 130 if report.status == "cancelled" else 0
    except Exception as exc:  # noqa: BLE001 - privacy boundary never exposes source values.
        # Source values may appear in parse errors; only expose the safe generic record.
        json.dump(to_json(ErrorResponse(type(exc).__name__)), sys.stdout)
        sys.stdout.write("\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())
