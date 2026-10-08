/** Pure pinned cleaner protocol primitives; no runtime service or side effects. */
import { createHash } from "node:crypto";
export const ATOMIC_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const ATOMIC_MAX_CANDIDATE_CODE_POINTS = 50_000;
/** Count Unicode code points, matching Python len(), and stop at the admission bound. */
export function atomicCandidateWithinAdmission(text: string): boolean {
  let units = 0;
  let count = 0;
  while (units < text.length) {
    units += text.codePointAt(units)! > 0xffff ? 2 : 1;
    if (++count > ATOMIC_MAX_CANDIDATE_CODE_POINTS) return false;
  }
  return true;
}
export interface Capabilities {
  atomic_create: boolean;
  atomic_source_check: boolean;
  conditional_delete: boolean;
  contract_id: string;
  reason?: string;
}
export interface Condition {
  execution_config_sha256: string;
  bank_id: string;
  source_id: string;
  source_sha256: string;
  source_updated_at: string;
  source_metadata_sha256: string;
  target_id: string;
  target_sha256: string;
  owner_key: string;
  operation_id: string;
  payload_sha256: string;
}
export interface RollbackCommand {
  condition: Condition;
  expected_document_metadata_sha256: string;
  expected_updated_at: string;
  rollback_operation_id: string;
  rollback_payload_sha256: string;
  created_receipt_sha256: string;
}
export interface AtomicGuard {
  capabilities(bank: string): Promise<Capabilities>;
  create(
    command: { condition: Condition; payload_json: string },
    signal: AbortSignal
  ): Promise<{ accepted: boolean; operation_id: string; reused?: boolean }>;
  operation?(
    condition: Condition,
    signal: AbortSignal
  ): Promise<{
    operation_id: string;
    status: string;
    payload_sha256: string;
    created?: boolean;
    target_id?: string;
    owner_key?: string;
    target_sha256?: string;
    metadata_sha256?: string;
    graph_sha256?: string;
    updated_at?: string;
    rollback_operation_id?: string | null;
    rollback_payload_sha256?: string | null;
    created_receipt_sha256?: string | null;
  }>;
  remove?(
    command: RollbackCommand,
    signal: AbortSignal
  ): Promise<{ deleted: boolean; rollback_operation_id: string }>;
  rollbackOperation?(
    command: RollbackCommand,
    signal: AbortSignal
  ): Promise<{
    rollback_operation_id: string;
    rollback_payload_sha256: string;
    status: string;
    deleted: boolean;
  }>;
}
export function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => {
          const x = Array.from(a),
            y = Array.from(b);
          for (let i = 0; i < Math.min(x.length, y.length); i++) {
            const delta = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
            if (delta) return delta;
          }
          return x.length - y.length;
        })
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
