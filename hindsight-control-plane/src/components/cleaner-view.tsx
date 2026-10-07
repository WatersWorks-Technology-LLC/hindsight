"use client";

import { useEffect, useRef, useState } from "react";
import { useBank } from "@/lib/bank-context";
import { client } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, ShieldCheck } from "lucide-react";
import { CleanerIcon, CleanerProgress, type CleanerProgressData } from "./cleaner-progress";
import { CleanerImportPanel } from "./cleaner-import";

type CleanerDocument = {
  id: string;
  bank_id: string;
  project_id?: string;
  raw_sha256: string;
  status: string;
  flags: unknown[];
  original_preview: string;
  candidate_preview: string;
  diff: unknown;
  segments: { id: string; start: number; end: number; sha256: string; text?: string }[];
  coverage: unknown;
  metadata: unknown;
  preview_truncated?: boolean;
  diff_truncated?: boolean;
  transformations?: unknown;
  boilerplate_proposals?: unknown;
};
type CleanerReport = {
  schema_version: number;
  batch_id: string;
  status: string;
  documents: CleanerDocument[];
  duplicates: unknown[];
  overlaps: unknown[];
  summary: unknown;
  bank_snapshot?: unknown;
};
type CleanerJob = {
  job_id?: string;
  id?: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | "paused";
  report?: CleanerReport;
  error?: string;
  stage?: string;
  progress?: CleanerProgressData;
  mode?: "bank" | "selected" | "upload";
  can_resume?: boolean;
  can_retry?: boolean;
  report_available?: boolean;
};

const printable = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
async function readResponse(response: Response): Promise<CleanerJob> {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Cleaner request failed. Please retry.");
  return data;
}

export function CleanerView() {
  const { currentBank } = useBank();
  // A bank switch remounts the session, cancels its requests and resets approval.
  return currentBank ? (
    <CleanerSession key={currentBank} bankId={currentBank} />
  ) : (
    <p>Select a bank to preview document cleaning.</p>
  );
}

function CleanerSession({ bankId }: { bankId: string }) {
  const [ids, setIds] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<CleanerJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [partialReviewed, setPartialReviewed] = useState(false);
  const [discovering, setDiscovering] = useState(true);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(true);
  const launching = useRef(false);
  const [sources, setSources] = useState<{ id: string }[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceOffset, setSourceOffset] = useState(0);
  const [sourceTotal, setSourceTotal] = useState(0);
  const sourceGeneration = useRef(0);
  const generation = useRef(0);
  const activeJob = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    const token = generation.current;
    void fetch(`/api/cleaner?bank_id=${encodeURIComponent(bankId)}`)
      .then(async (response) => {
        if (response.status === 404) return;
        const result = await readResponse(response);
        if (generation.current !== token || launching.current) return;
        const id = result.job_id || result.id;
        if (!id) return;
        setJobId(id);
        setJob(result);
        if (result.status === "running") {
          const abort = new AbortController();
          controller.current = abort;
          activeJob.current = id;
          setBusy(true);
          void poll(id, token, abort.signal);
        }
      })
      .catch(() => {
        if (generation.current === token) {
          setInterrupted(true);
          setError(
            "Could not recover the previous batch. Retry connection before starting a new bank cleanup."
          );
        }
      })
      .finally(() => {
        if (generation.current === token) setDiscovering(false);
      });
    return () => {
      mounted.current = false;
      generation.current++;
      sourceGeneration.current++;
      controller.current?.abort();
      if (timer.current) clearTimeout(timer.current);
      if (activeJob.current)
        void fetch(`/api/cleaner?job=${encodeURIComponent(activeJob.current)}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => {});
    };
    // Session is keyed by bank, so discovery runs once for this bank only.
  }, [bankId]);

  async function loadSources(offset = 0) {
    const token = ++sourceGeneration.current;
    setSourcesLoading(true);
    setError(null);
    try {
      const result = (await client.listDocuments({
        bank_id: bankId,
        q: sourceQuery,
        limit: 25,
        offset,
      })) as { items?: { id: string }[]; total?: number };
      if (token !== sourceGeneration.current) return;
      setSources(result.items || []);
      setSourceTotal(result.total || 0);
      setSourceOffset(offset);
      setSourcesLoaded(true);
    } catch {
      if (token === sourceGeneration.current)
        setError("Could not list bank documents. Retry or choose a local export.");
    } finally {
      if (token === sourceGeneration.current) setSourcesLoading(false);
    }
  }

  async function poll(id: string, token: number, signal: AbortSignal) {
    try {
      const result = await readResponse(
        await fetch(`/api/cleaner?job=${encodeURIComponent(id)}`, { signal })
      );
      if (generation.current !== token) return;
      setJob(result);
      setInterrupted(false);
      if (result.status === "running")
        timer.current = setTimeout(() => void poll(id, token, signal), 700);
      else {
        activeJob.current = null;
        setBusy(false);
        if (result.status === "failed")
          setError(result.error || "This batch could not be processed. Originals are unchanged.");
      }
    } catch (cause) {
      if (generation.current !== token || signal.aborted) return;
      setBusy(false);
      setInterrupted(true);
      setReviewed(false);
      setPartialReviewed(false);
      setError(cause instanceof Error ? cause.message : "Unable to read preview status.");
      // Keep cancellation available when the status transport fails: processing
      // can still be active on the server, even though polling has stopped.
    }
  }

  async function preview(action?: "clean_bank" | "resume" | "retry") {
    if (
      busy ||
      importBusy ||
      launching.current ||
      exporting ||
      discovering ||
      activeJob.current ||
      (interrupted && !jobId)
    )
      return;
    const documentIds = ids
      .split(/[\n,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    if (!action && !file && !documentIds.length) {
      setError("Select a local file or enter document IDs from this bank.");
      return;
    }
    if (!action && documentIds.length > 25 && !file) {
      setError("Choose at most 25 document IDs per batch.");
      return;
    }
    if (!action && file && file.size > 64 * 1024 * 1024) {
      setError("Choose a file smaller than 64 MB.");
      return;
    }
    const token = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    launching.current = true;
    setStarting(true);
    setBusy(true);
    setError(null);
    setInterrupted(false);
    setReviewed(false);
    setPartialReviewed(false);
    setSelected(0);
    if (action !== "resume" && action !== "retry") {
      setJob(null);
      setJobId(null);
    }
    try {
      let body: BodyInit;
      let headers: HeadersInit | undefined;
      if (action) {
        body = JSON.stringify({
          bank_id: bankId,
          action,
          job_id: action === "clean_bank" ? undefined : jobId,
        });
        headers = { "Content-Type": "application/json" };
      } else if (file) {
        const form = new FormData();
        form.set("bank_id", bankId);
        form.set("file", file);
        body = form;
      } else {
        body = JSON.stringify({ bank_id: bankId, document_ids: documentIds });
        headers = { "Content-Type": "application/json" };
      }
      // Do not abort creation: the server may have started work before its 202
      // arrives. Let that response reveal the ID so cancellation can delete the
      // exact job even when this session has since been cancelled or unmounted.
      const result = await readResponse(
        await fetch("/api/cleaner", { method: "POST", body, headers })
      );
      const id = result.job_id || result.id;
      if (generation.current !== token) {
        if (id) {
          const cancelled = await readResponse(
            await fetch(`/api/cleaner?job=${encodeURIComponent(id)}`, {
              method: "DELETE",
              keepalive: true,
            })
          );
          if (mounted.current && generation.current === token + 1) {
            setJobId(id);
            setJob(cancelled);
            await refreshCancelledSnapshot(id, token + 1);
          }
        }
        return;
      }
      if (!id) throw new Error("The cleaner did not return a batch ID.");
      setJobId(id);
      setJob(result);
      if (result.status === "running") {
        activeJob.current = id;
        void poll(id, token, abort.signal);
      } else {
        setBusy(false);
        if (result.status === "failed") setError(result.error || "Preview failed.");
      }
    } catch (cause) {
      if (generation.current !== token || abort.signal.aborted) {
        if (mounted.current && generation.current === token + 1) {
          setBusy(false);
          setCancelling(false);
          setInterrupted(true);
          setError("Cancellation snapshot unavailable. Reconnect before reviewing or exporting.");
        }
        return;
      }
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Unable to start preview.");
    } finally {
      launching.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  async function refreshCancelledSnapshot(id: string, token: number) {
    // DELETE confirms cancellation but returns no report. Clear the previous
    // preview and fetch the final saved snapshot before re-enabling approval.
    setBusy(true);
    setReviewed(false);
    setPartialReviewed(false);
    setJob((previous) => (previous ? { ...previous, report: undefined } : previous));
    try {
      const result = await readResponse(await fetch(`/api/cleaner?job=${encodeURIComponent(id)}`));
      if (!mounted.current || generation.current !== token) return;
      setJobId(id);
      setJob(result);
      setInterrupted(false);
      setError(null);
    } catch {
      if (mounted.current && generation.current === token) {
        setInterrupted(true);
        setError("Cancellation snapshot unavailable. Reconnect before reviewing or exporting.");
      }
    } finally {
      if (mounted.current && generation.current === token) {
        setBusy(false);
        setCancelling(false);
      }
    }
  }

  function reconnect() {
    if (busy) return;
    setReviewed(false);
    setPartialReviewed(false);
    const token = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    if (jobId) {
      void poll(jobId, token, abort.signal);
      return;
    }
    void fetch(`/api/cleaner?bank_id=${encodeURIComponent(bankId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (response.status === 404) {
          if (generation.current === token) {
            setInterrupted(false);
            setBusy(false);
          }
          return;
        }
        const result = await readResponse(response);
        if (generation.current !== token) return;
        const id = result.job_id || result.id;
        setJob(result);
        setJobId(id || null);
        setInterrupted(false);
        if (id && result.status === "running") {
          activeJob.current = id;
          void poll(id, token, abort.signal);
        } else setBusy(false);
      })
      .catch(() => {
        if (generation.current === token && !abort.signal.aborted) {
          setBusy(false);
          setInterrupted(true);
          setError(
            "Progress connection unavailable. Retry connection when the local UI is reachable."
          );
        }
      });
  }

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    const token = ++generation.current;
    controller.current?.abort();
    if (timer.current) clearTimeout(timer.current);
    const id = activeJob.current;
    activeJob.current = null;
    setBusy(true);
    setReviewed(false);
    setPartialReviewed(false);
    setInterrupted(false);
    setJob((previous) => ({
      ...previous,
      report: undefined,
      status: "cancelled",
      stage: "Refreshing cancelled batch snapshot",
    }));
    if (id)
      try {
        const result = await readResponse(
          await fetch(`/api/cleaner?job=${encodeURIComponent(id)}`, { method: "DELETE" })
        );
        if (mounted.current && generation.current === token) {
          setJob(result);
          await refreshCancelledSnapshot(id, token);
        }
      } catch {
        if (mounted.current && generation.current === token) {
          setBusy(false);
          setCancelling(false);
          setInterrupted(true);
          setError("Cancellation could not be confirmed. Reconnect before reviewing or exporting.");
        }
      }
    if (!id && !launching.current) {
      setBusy(false);
      setCancelling(false);
    }
  }

  async function exportCandidates() {
    if (
      !reviewed ||
      !jobId ||
      exporting ||
      busy ||
      interrupted ||
      activeJob.current ||
      job?.status === "running" ||
      (job?.status !== "completed" && !partialReviewed)
    )
      return;
    const token = generation.current;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/cleaner?job=${encodeURIComponent(jobId)}&export=1&reviewed=1${job?.status !== "completed" ? "&partial=1" : ""}`
      );
      if (!response.ok) {
        await readResponse(response);
        return;
      }
      const blob = await response.blob();
      // An approval belongs to one batch in one bank. A stale request must never
      // initiate a download after navigation or a subsequent preview.
      if (token !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement("a");
      anchor.href = url;
      anchor.download = `cleaner-${jobId}-candidates.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      if (token === generation.current)
        setError(cause instanceof Error ? cause.message : "Candidate export failed.");
    } finally {
      if (token === generation.current) setExporting(false);
    }
  }

  const report = job?.report;
  const evidenceUnsettled = busy || interrupted || !!activeJob.current || job?.status === "running";
  const document = report?.documents[selected];
  return (
    <section className="space-y-6 p-6 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-center gap-4">
        <CleanerIcon className="h-14 w-14" />
        <div className="flex-1 min-w-56">
          <h1 className="text-2xl font-semibold">Document cleaner</h1>
          <p className="text-muted-foreground">
            Generate cleaned versions. Preserve every original.
          </p>
        </div>
        <Button
          size="lg"
          disabled={
            busy ||
            importBusy ||
            starting ||
            exporting ||
            discovering ||
            !!activeJob.current ||
            (interrupted && !jobId)
          }
          onClick={() => void preview("clean_bank")}
        >
          Clean bank
        </Button>
      </header>
      <p className="text-sm text-muted-foreground">
        Clean bank checks all documents in this bank and stages candidate copies for review. Nothing
        is automatically replaced or imported.
      </p>
      <div className="rounded-xl border bg-card p-4 flex gap-3">
        <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
        <p className="text-sm">
          Bank: <strong className="break-all">{bankId}</strong>. Raw originals stay immutable.
          Instructions, dates and cited claims remain evidence; overlap findings never merge
          projects. Candidate export requires review. Import requires a reviewed, source-validated
          plan and separate confirmation.
        </p>
      </div>
      {(discovering || busy || interrupted || job?.progress) && (
        <CleanerProgress
          stage={discovering ? "Recovering previous batch" : job?.stage || "Starting bank cleanup"}
          progress={job?.progress}
          interrupted={interrupted}
          active={discovering || busy}
        />
      )}
      <div className="flex flex-wrap gap-3">
        {interrupted && (
          <Button variant="outline" disabled={busy} onClick={reconnect}>
            {jobId ? "Reconnect to progress" : "Retry connection"}
          </Button>
        )}
        {job?.can_resume && !busy && (
          <Button
            disabled={starting || exporting || importBusy}
            onClick={() => void preview("resume")}
          >
            Resume this batch
          </Button>
        )}
        {job?.can_retry && !busy && (
          <Button
            variant="outline"
            disabled={starting || exporting || importBusy}
            onClick={() => void preview("retry")}
          >
            Retry failed documents
          </Button>
        )}
        {(busy || activeJob.current) && (
          <Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>
            {cancelling ? "Finishing cancellation…" : "Cancel cleanup"}
          </Button>
        )}
      </div>
      <div className="rounded-xl border bg-card p-5 space-y-4">
        <h2 className="font-semibold">Choose sources</h2>
        <div className="space-y-3">
          <div className="flex gap-3">
            <Input
              aria-label="Search bank documents"
              placeholder="Search bank documents"
              value={sourceQuery}
              disabled={busy}
              onChange={(event) => setSourceQuery(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={busy || sourcesLoading}
              onClick={() => void loadSources()}
            >
              {sourcesLoading ? "Loading…" : "Browse bank documents"}
            </Button>
          </div>
          {sourcesLoaded && (
            <>
              <p className="text-xs text-muted-foreground">
                {sourceTotal} bank documents. Select up to 25 for one preview.
              </p>
              <div className="max-h-56 overflow-auto rounded border p-3 space-y-2">
                {sources.length ? (
                  sources.map((source) => {
                    const selectedIds = ids
                      .split(/[\n,]+/)
                      .map((id) => id.trim())
                      .filter(Boolean);
                    return (
                      <label key={source.id} className="flex gap-3 text-sm break-all">
                        <input
                          type="checkbox"
                          disabled={
                            busy ||
                            !!file ||
                            (!selectedIds.includes(source.id) && selectedIds.length >= 25)
                          }
                          checked={selectedIds.includes(source.id)}
                          onChange={(event) =>
                            setIds(
                              event.target.checked
                                ? [...selectedIds, source.id].join("\n")
                                : selectedIds.filter((id) => id !== source.id).join("\n")
                            )
                          }
                        />
                        <span>{source.id}</span>
                      </label>
                    );
                  })
                ) : (
                  <p className="text-sm">
                    No documents matched. Choose another search or a local file.
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || sourcesLoading || sourceOffset === 0}
                  onClick={() => void loadSources(Math.max(0, sourceOffset - 25))}
                >
                  Previous sources
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || sourcesLoading || sourceOffset + 25 >= sourceTotal}
                  onClick={() => void loadSources(sourceOffset + 25)}
                >
                  Next sources
                </Button>
              </div>
            </>
          )}
        </div>
        <label className="block space-y-2">
          <span className="text-sm">
            Local Markdown, text or supported Hindsight export (.json / .zip)
          </span>
          <Input
            aria-label="Local document file"
            type="file"
            accept=".md,.txt,.json,.zip"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setReviewed(false);
            }}
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm">
            Or document IDs from this bank (one per line or comma separated)
          </span>
          <textarea
            aria-label="Document IDs"
            className="w-full rounded-md border bg-background p-3 text-sm min-h-20"
            disabled={busy || !!file}
            value={ids}
            onChange={(event) => {
              setIds(event.target.value);
              setReviewed(false);
            }}
            placeholder="Copy IDs from Documents"
          />
        </label>
        {file && (
          <p className="text-sm text-muted-foreground">
            Local file selected; live document IDs are ignored for this batch.{" "}
            <button className="underline" disabled={busy} onClick={() => setFile(null)}>
              Clear file selection
            </button>
          </p>
        )}
        <div className="flex gap-3">
          <Button
            onClick={() => void preview()}
            disabled={
              busy ||
              importBusy ||
              starting ||
              exporting ||
              !!activeJob.current ||
              (!file && !ids.trim())
            }
          >
            {busy ? "Preparing preview…" : "Preview candidates"}
          </Button>
          {(busy || activeJob.current) && (
            <Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>
              Cancel preview
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-destructive p-4 text-destructive">
          {error}
        </div>
      )}
      {job?.status === "cancelled" && (
        <p role="status">
          Cleanup cancelled. Generated copies and source progress are preserved; resume this batch
          when ready.
        </p>
      )}
      {job?.status === "paused" && (
        <p role="status">
          This batch was interrupted. Resume it to continue from its saved progress.
        </p>
      )}
      {job?.status === "partial" && (
        <p role="status" className="rounded border border-amber-500/50 p-4">
          Some documents could not be cleaned. Review failed-document flags and retry failed
          documents, or explicitly export the incomplete candidate batch.
        </p>
      )}
      {!job && !busy && (
        <p className="text-muted-foreground">
          No preview yet. Select a source to inspect changes before exporting.
        </p>
      )}
      {report && (
        <>
          <div className="rounded-xl border bg-card p-5 space-y-3">
            <h2 className="font-semibold">Batch decision report</h2>
            <p className="text-sm">
              {report.documents.length} documents · {report.duplicates.length} exact duplicate
              groups · {report.overlaps.length} overlap findings
            </p>
            <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-60">
              {printable(report.summary)}
            </pre>
            {report.bank_snapshot !== undefined && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Verified bank snapshot and scope
                </summary>
                <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-60">
                  {printable(report.bank_snapshot)}
                </pre>
              </details>
            )}
            <details>
              <summary className="cursor-pointer text-sm">Duplicate and overlap evidence</summary>
              <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-60">
                {printable({ duplicates: report.duplicates, overlaps: report.overlaps })}
              </pre>
            </details>
          </div>
          {!report.documents.length ? (
            <p>
              No readable documents in this batch. Review the decision report and choose another
              source.
            </p>
          ) : (
            <>
              <label className="block text-sm">
                Document{" "}
                <select
                  className="ml-3 max-w-full rounded border bg-background p-2"
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {report.documents.map((item, index) => (
                    <option value={index} key={`${item.id}-${index}`}>
                      {item.id} — {item.status}
                    </option>
                  ))}
                </select>
              </label>
              {document && (
                <article className="space-y-4">
                  {(document.preview_truncated || document.diff_truncated) && (
                    <p className="rounded border p-3 text-sm">
                      Large source: preview and diff are excerpts. Review all exported segments and
                      the complete decision report before considering import.
                    </p>
                  )}
                  <div className="rounded-xl border p-4 space-y-2">
                    <h3 className="font-semibold">Provenance and review flags</h3>
                    <p className="text-xs break-all">
                      Source ID: {document.id} · Bank: {document.bank_id} · Project:{" "}
                      {document.project_id || "unspecified"}
                      <br />
                      Raw SHA-256: {document.raw_sha256}
                    </p>
                    <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-auto">
                      {printable(document.flags)}
                    </pre>
                    <details>
                      <summary className="cursor-pointer text-sm">
                        Coverage, transformation source offsets and source segments
                      </summary>
                      <pre className="text-xs whitespace-pre-wrap max-h-60 overflow-auto">
                        {printable({
                          coverage: document.coverage,
                          transformations: document.transformations,
                          boilerplate_proposals: document.boilerplate_proposals,
                          metadata: document.metadata,
                          segments: document.segments.map((segment) => ({
                            id: segment.id,
                            start: segment.start,
                            end: segment.end,
                            sha256: segment.sha256,
                          })),
                        })}
                      </pre>
                    </details>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="rounded-xl border p-4">
                      <h3 className="font-semibold mb-3">Original preview (secrets masked)</h3>
                      <pre className="text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto">
                        {document.original_preview}
                      </pre>
                    </div>
                    <div className="rounded-xl border p-4">
                      <h3 className="font-semibold mb-3">Candidate preview</h3>
                      <pre className="text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto">
                        {document.candidate_preview}
                      </pre>
                    </div>
                  </div>
                  <details open className="rounded-xl border p-4">
                    <summary className="font-semibold cursor-pointer">Source-mapped diff</summary>
                    <pre className="mt-3 text-xs whitespace-pre-wrap break-words max-h-96 overflow-auto">
                      {printable(document.diff)}
                    </pre>
                  </details>
                </article>
              )}
            </>
          )}
          <div className="rounded-xl border bg-card p-5 space-y-4">
            {job?.status !== "completed" && (
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={partialReviewed}
                  disabled={evidenceUnsettled}
                  onChange={(event) => setPartialReviewed(event.target.checked)}
                />
                <span>
                  This batch is incomplete. I acknowledge missing, pending or failed documents and
                  approve exporting only the staged candidate copies.
                </span>
              </label>
            )}
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                disabled={evidenceUnsettled}
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
                className="mt-1"
              />
              <span>
                I reviewed this batch’s diffs, provenance, omissions and possible-secret redactions.
                I approve exporting candidate copies for further review; this does not authorize
                live import.
              </span>
            </label>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={
                  !reviewed ||
                  !report.documents.length ||
                  exporting ||
                  evidenceUnsettled ||
                  (job?.status !== "completed" && !partialReviewed)
                }
                onClick={() => void exportCandidates()}
              >
                <Download className="mr-2 h-4 w-4" />
                {exporting ? "Exporting…" : "Export reviewed candidates"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Candidate export excludes raw originals and possible-secret values. Keep the hash
              manifest and decision report with every exported batch.
            </p>
          </div>
          {jobId && (
            <CleanerImportPanel
              key={`${jobId}-${report.documents.map((item) => `${item.id}:${item.raw_sha256}:${item.status}`).join("|")}`}
              bankId={bankId}
              jobId={jobId}
              documents={report.documents}
              reviewed={reviewed}
              disabled={evidenceUnsettled || (job?.status !== "completed" && !partialReviewed)}
              onBusyChange={setImportBusy}
            />
          )}
        </>
      )}
    </section>
  );
}
