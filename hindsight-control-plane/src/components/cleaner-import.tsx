"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CleanerProgress } from "./cleaner-progress";

export interface ImportCandidate {
  id: string;
  bank_id: string;
  status: string;
  raw_sha256: string;
  flags: unknown[];
  coverage: unknown;
}

export function candidateIneligibility(document: ImportCandidate, bankId: string): string | undefined {
  if (document.bank_id !== bankId) return "Different bank boundary";
  if (document.status !== "candidate") return `Review-only status: ${document.status}`;
  if (!/^[a-f0-9]{64}$/i.test(document.raw_sha256 || "")) return "Source hash unavailable";
  const coverage = document.coverage as { omissions?: unknown[] } | undefined;
  if (!coverage || !Array.isArray(coverage.omissions)) return "Coverage evidence unavailable";
  if (coverage.omissions.length) return "Cited claim or date omissions need review";
  if (document.flags.some((flag) => typeof flag === "string" && /possible-secret|quarantin/i.test(flag))) return "Possible-secret candidate quarantined";
  return undefined;
}

interface ImportPlan {
  plan_id: string;
  plan_hash: string;
  confirmation_token: string;
  status: "prepared" | "blocked";
  bank_id: string;
  mode?: "import" | "rollback";
  eligible: { document_index: number; candidate_id: string; source_id: string; source_sha256: string; candidate_sha256: string; diff?: string; diff_truncated?: boolean; preview_truncated?: boolean }[];
  rejected: unknown[];
  backup_manifest: unknown;
  expires_at?: string;
  rollback?: { available: boolean; reason?: string };
  reason?: string;
}
interface ImportOperation {
  operation_id: string;
  mode?: "import" | "rollback";
  status: "running" | "completed" | "partial" | "failed" | "paused" | "uncertain" | "cancelled";
  stage?: string;
  progress: { total: number; imported: number; reused: number; rolled_back?: number; failed: number; blocked: number; uncertain: number; remaining: number };
  items?: unknown[];
  can_resume?: boolean;
  can_reconcile?: boolean;
  error?: string;
}
interface OperationSnapshot { plan: ImportPlan; operation: ImportOperation }
const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
async function json<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The requested operation could not proceed.");
  return data;
}

export function CleanerImportPanel({ bankId, jobId, documents, reviewed, disabled, onBusyChange }: {
  bankId: string; jobId: string; documents: ImportCandidate[]; reviewed: boolean;
  disabled: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [savedPlan, setSavedPlan] = useState<ImportPlan | null>(null);
  const [pendingAction, setPendingAction] = useState<"confirm" | "resume" | "reconcile">("confirm");
  const [rollbackPreview, setRollbackPreview] = useState<unknown>(null);
  const [operation, setOperation] = useState<ImportOperation | null>(null);
  const [typedBank, setTypedBank] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const actionLock = useRef(false);
  const mutationInFlight = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authorization = useRef(false);
  authorization.current = reviewed && !disabled;
  const eligible = documents.filter((document) => !candidateIneligibility(document, bankId));

  useEffect(() => {
    mounted.current = true;
    return () => {
    mounted.current = false; generation.current++;
    if (timer.current) clearTimeout(timer.current);
    onBusyChange?.(false);
    };
  }, [bankId, jobId, onBusyChange]);

  useEffect(() => {
    if (!reviewed || disabled) { if (operation?.status !== "running" && !mutationInFlight.current) { generation.current++; actionLock.current = false; updateBusy(false); } setPlan(null); setTypedBank(""); setAcknowledged(false); setOpen(false); }
  }, [reviewed, disabled]);

  function updateBusy(value: boolean) { setBusy(value); onBusyChange?.(value); }
  function clearPlan() { generation.current++; setPlan(null); setTypedBank(""); setAcknowledged(false); setError(null); }

  async function poll(id: string, token: number) {
    try {
      const snapshot = await json<OperationSnapshot>(await fetch(`/api/cleaner/import?plan=${encodeURIComponent(id)}`));
      const result = snapshot.operation;
      if (snapshot.plan.bank_id !== bankId) throw new Error("Operation bank boundary mismatch.");
      if (!mounted.current || generation.current !== token) return;
      setSavedPlan(snapshot.plan); setOperation(result); setInterrupted(false);
      if (result.status === "running") timer.current = setTimeout(() => void poll(id, token), 800);
      else { updateBusy(false); actionLock.current = false; }
    } catch (cause) {
      if (!mounted.current || generation.current !== token) return;
      updateBusy(false); setInterrupted(true); actionLock.current = false;
      setError(cause instanceof Error ? cause.message : "Operation status interrupted. Reconcile before retrying writes.");
    }
  }

  async function requestPlan(kind: "import" | "rollback") {
    if (actionLock.current || disabled || !reviewed || (kind === "import" && !selected.length)) return;
    actionLock.current = true;
    const token = ++generation.current;
    updateBusy(true); setError(null); setAcknowledged(false); setTypedBank(""); setPlan(null);
    try {
      const result = await json<ImportPlan>(await fetch("/api/cleaner/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(kind === "import" ? { action: "plan", bank_id: bankId, job_id: jobId, document_indexes: selected } : { action: "rollback_plan", bank_id: bankId, plan_id: operation?.operation_id }) }));
      if (!mounted.current || generation.current !== token || !authorization.current) return;
      if (result.bank_id !== bankId) throw new Error("Plan bank boundary mismatch. Rebuild the plan.");
      if (kind === "rollback") {
        if (result.status !== "prepared") { setRollbackPreview(result); return; }
        if (result.mode !== "rollback") throw new Error("Rollback plan mode mismatch. No deletion is authorized.");
        setRollbackPreview(null); setOperation(null);
      }
      setPlan(result); setSavedPlan(result); setPendingAction("confirm"); setOpen(true);
    } catch (cause) { if (mounted.current && generation.current === token) setError(cause instanceof Error ? cause.message : "Dry-run planning failed."); }
    finally { actionLock.current = false; if (mounted.current && generation.current === token) updateBusy(false); }
  }

  async function confirmPlan() {
    if (actionLock.current || !plan || plan.status !== "prepared" || !authorization.current || (interrupted && pendingAction === "confirm") || typedBank !== bankId || !acknowledged || !plan.eligible.length) return;
    actionLock.current = true;
    mutationInFlight.current = true;
    const token = ++generation.current;
    updateBusy(true); setError(null);
    try {
      const result = await json<ImportOperation>(await fetch("/api/cleaner/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: pendingAction, plan_id: plan.plan_id, plan_hash: plan.plan_hash, confirmation_token: plan.confirmation_token, bank_confirmation: typedBank, acknowledged: true }) }));
      if (!mounted.current || generation.current !== token) return;
      setOperation(result); setPlan(null); setAcknowledged(false); setTypedBank("");
      actionLock.current = false;
      if (result.status === "running") void poll(result.operation_id, token);
      else updateBusy(false);
    } catch (cause) {
      if (!mounted.current || generation.current !== token) return;
      updateBusy(false); actionLock.current = false; setInterrupted(true); setPlan(null); setAcknowledged(false); setTypedBank("");
      setError(cause instanceof Error ? `${cause.message} Confirmation outcome may be uncertain. Recover the operation before retrying.` : "Confirmation outcome uncertain. Recover the operation before retrying.");
    } finally { mutationInFlight.current = false; }
  }

  async function operationAction(action: "resume" | "reconcile") {
    if (actionLock.current || !operation || disabled || !reviewed) return;
    actionLock.current = true;
    const token = ++generation.current; updateBusy(true); setError(null); setAcknowledged(false); setTypedBank("");
    try {
      const snapshot = await json<OperationSnapshot>(await fetch(`/api/cleaner/import?plan=${encodeURIComponent(operation.operation_id)}`));
      if (!mounted.current || generation.current !== token) return;
      if (snapshot.plan.bank_id !== bankId) throw new Error("Saved operation bank boundary mismatch.");
      setSavedPlan(snapshot.plan); setPlan(snapshot.plan); setOperation(snapshot.operation); setInterrupted(false); setPendingAction(action); setOpen(true);
    } catch (cause) { if (mounted.current && generation.current === token) setError(cause instanceof Error ? cause.message : "Operation recovery failed."); }
    finally { actionLock.current = false; if (mounted.current && generation.current === token) updateBusy(false); }
  }

  async function cancelOperation() {
    if (actionLock.current || !operation) return;
    actionLock.current = true;
    const token = ++generation.current; updateBusy(true); setError(null); setAcknowledged(false); setTypedBank(""); setPlan(null);
    try {
      const result = await json<ImportOperation>(await fetch("/api/cleaner/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", plan_id: operation.operation_id }) }));
      if (!mounted.current || generation.current !== token) return;
      setOperation(result); setInterrupted(false);
    } catch (cause) { if (mounted.current && generation.current === token) { setInterrupted(true); setError(cause instanceof Error ? cause.message : "Cancel outcome uncertain. Reconcile before continuing."); } }
    finally { actionLock.current = false; if (mounted.current && generation.current === token) updateBusy(false); }
  }

  async function recoverOperation() {
    if (actionLock.current) return;
    actionLock.current = true;
    const token = ++generation.current; updateBusy(true); setAcknowledged(false); setTypedBank(""); setPlan(null); setError(null);
    try {
      const snapshot = await json<OperationSnapshot>(await fetch(`/api/cleaner/import?job=${encodeURIComponent(jobId)}&bank_id=${encodeURIComponent(bankId)}`));
      const result = snapshot.operation;
      if (snapshot.plan.bank_id !== bankId) throw new Error("Saved operation bank boundary mismatch.");
      if (!mounted.current || generation.current !== token) return;
      setSavedPlan(snapshot.plan); setOperation(result); setInterrupted(false);
      actionLock.current = false;
      if (result.status === "running") void poll(result.operation_id, token);
      else updateBusy(false);
    } catch (cause) { if (mounted.current && generation.current === token) { updateBusy(false); actionLock.current = false; setError(cause instanceof Error ? cause.message : "No saved operation found."); } }
  }

  const operationActive = operation?.status === "running" || interrupted || !!operation?.progress.uncertain;
  const rollbackPlan = plan?.mode === "rollback";
  const rollbackOperation = operation?.mode === "rollback";
  const completedCount = operation ? rollbackOperation ? operation.progress.rolled_back || 0 : operation.progress.imported + operation.progress.reused : 0;
  return <div className="mt-4 space-y-4 border-t pt-4">
    <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={disabled || !reviewed || busy || operationActive || !eligible.length} onClick={() => { clearPlan(); setSelected([]); setRollbackPreview(null); setOpen(true); }}>Apply / import to Hindsight</Button><Button variant="ghost" disabled={busy} onClick={() => void recoverOperation()}>{savedPlan?.mode === "rollback" ? "Recover rollback operation" : "Recover import operation"}</Button></div>
    <p className="text-xs text-muted-foreground">Imports add cleaned document versions in this bank. Originals remain unchanged. Every write needs a source-validated dry-run plan and explicit confirmation.</p>
    {error && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}</p>}
    {open && (!operationActive || !!plan) && <section aria-label="Candidate import review" className="rounded-xl border p-4 space-y-4">
      <h3 className="font-semibold">{rollbackPlan ? "Review removal of operation-created candidate versions" : pendingAction === "confirm" ? "Select cleaned versions to import" : "Review saved operation before continuing"}</h3>
      {!plan ? <><p className="text-sm">Select up to 10 eligible sources. Quarantined candidates, omitted evidence and unreadable documents cannot be imported.</p><div className="max-h-64 overflow-auto space-y-2">{documents.map((document, index) => { const reason = candidateIneligibility(document, bankId); return <label key={document.id} className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={!!reason || busy || (!selected.includes(index) && selected.length >= 10)} checked={selected.includes(index)} onChange={(event) => { clearPlan(); setSelected(event.target.checked ? [...selected, index] : selected.filter((value) => value !== index)); }} /><span className="break-all">{document.id}{reason && <span className="block text-muted-foreground">{reason}</span>}</span></label>; })}</div><Button disabled={!selected.length || busy || disabled || !reviewed} onClick={() => void requestPlan("import")}>{busy ? "Validating sources…" : "Build dry-run import plan"}</Button></> : <>
        {plan.status === "blocked" && <p role="alert" className="rounded border border-amber-500 p-3 text-sm">{rollbackPlan ? "Rollback" : "Import"} is blocked: {plan.reason || display(plan.rejected) || "The server could not verify safe conditional creation."} No writes are authorized.</p>}
        {plan.eligible.some((item) => item.diff_truncated || item.preview_truncated) && <p className="rounded border p-3 text-sm">Some plan previews are excerpts. Review the full exported candidate segments and coverage before confirming.</p>}
        <p className="text-sm">Bank: <strong>{plan.bank_id}</strong> · {plan.eligible.length} planned versions · Plan expires: {plan.expires_at || "server validated"}</p>
        <p className="text-sm">{rollbackPlan ? "This separate rollback plan verifies created receipts, ownership and unchanged candidate hashes. It removes only the listed candidate versions created by the original operation; reused targets and originals are excluded." : "This plan validates current source SHA-256 hashes, checks destination IDs, and backs up the manifest before adding new cleaned versions. It does not overwrite originals."}</p>
        <details open><summary className="cursor-pointer text-sm font-medium">Source hashes, planned IDs, diffs and exclusions</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{display({ eligible: plan.eligible, rejected: plan.rejected, plan_hash: plan.plan_hash })}</pre></details>
        <details><summary className="cursor-pointer text-sm font-medium">Backup manifest</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{display(plan.backup_manifest)}</pre></details>
        <label className="block space-y-2 text-sm"><span>Type the bank ID to confirm: {bankId}</span><Input aria-label="Confirm import bank" disabled={busy} value={typedBank} onChange={(event) => setTypedBank(event.target.value)} /></label>
        <label className="flex gap-3 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} /><span>{pendingAction === "reconcile" ? `I reviewed the saved ${rollbackPlan ? "rollback" : "import"} plan and authorize checking uncertain outcomes before any retry.` : rollbackPlan ? "I reviewed the rollback list and new plan. I authorize removal only of these owned, operation-created candidate versions, preserving all originals and reused targets." : "I reviewed the complete plan, source hashes and diffs. I authorize adding only these cleaned versions and preserving all originals."}</span></label>
        <Button disabled={busy || disabled || !reviewed || plan.status !== "prepared" || (interrupted && pendingAction === "confirm") || typedBank !== bankId || !acknowledged || !plan.eligible.length} onClick={() => void confirmPlan()}>{busy ? "Submitting confirmed plan…" : pendingAction === "confirm" ? rollbackPlan ? "Confirm guarded rollback" : "Confirm additive import" : pendingAction === "reconcile" ? rollbackPlan ? "Confirm rollback reconciliation" : "Confirm reconciliation" : rollbackPlan ? "Confirm rollback resume / retry" : "Confirm resume / retry"}</Button>
      </>}
      <Button variant="ghost" disabled={busy} onClick={() => { clearPlan(); setOpen(false); }}>Back / decline</Button>
    </section>}
    {rollbackPreview !== null && <section aria-label="Rollback preview" className="rounded-xl border p-4 space-y-3"><h3 className="font-semibold">Rollback preview — deletion unavailable</h3><p className="text-sm">The pinned Hindsight API cannot atomically verify unchanged candidate ownership while deleting. This review-only preview performs no deletions. Originals remain untouched.</p><pre className="text-xs whitespace-pre-wrap max-h-64 overflow-auto">{display(rollbackPreview)}</pre><Button disabled>Confirm rollback (unsupported by this API)</Button></section>}
    {operation && <section className="space-y-4" aria-label={rollbackOperation ? "Rollback operation status" : "Import operation status"}>
      <CleanerProgress stage={`${rollbackOperation ? "Rollback" : "Import"}: ${operation.stage || operation.status}`} progress={{ total: operation.progress.total, processed: completedCount, completed: completedCount, failed: operation.progress.failed, remaining: operation.progress.remaining }} active={operation.status === "running" && !interrupted} interrupted={interrupted} unitLabel={rollbackOperation ? "rolled back" : "staged"} />
      <p role="status" className="text-sm">Operation {operation.operation_id} · {operation.status}. {operation.progress.uncertain || 0} uncertain outcomes. Originals preserved.</p>
      {rollbackOperation && <p className="text-sm">{operation.progress.rolled_back || 0} owned candidate versions removed · {operation.progress.remaining} remaining. Reused targets and originals are retained.</p>}
      <details><summary className="cursor-pointer text-sm">Per-document outcomes</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{display(operation.items)}</pre></details>
      <div className="flex flex-wrap gap-3">{operation.status === "running" && <Button variant="outline" disabled={actionLock.current} onClick={() => void cancelOperation()}>{rollbackOperation ? "Stop rollback worker" : "Stop import worker"}</Button>}{(interrupted || operation.can_reconcile || operation.status === "uncertain") && <Button disabled={busy || disabled || !reviewed} onClick={() => void operationAction("reconcile")}>{rollbackOperation ? "Review rollback reconciliation" : "Review reconciliation"}</Button>}{operation.can_resume && !interrupted && <Button disabled={busy} onClick={() => void operationAction("resume")}>{rollbackOperation ? "Review rollback resume / retry" : "Review resume / retry"}</Button>}{savedPlan && !rollbackOperation && operation.status !== "running" && !interrupted && <Button variant="outline" disabled={busy || disabled || !reviewed} onClick={() => void requestPlan("rollback")}>Preview rollback</Button>}</div>
    </section>}
  </div>;
}
