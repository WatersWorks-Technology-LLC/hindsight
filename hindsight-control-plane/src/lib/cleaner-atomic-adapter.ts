/** Pinned atomic cleaner protocol transport. Never falls back to retain or DELETE. */
import {
  ATOMIC_MAX_PAYLOAD_BYTES,
  atomicCandidateWithinAdmission,
  canonical,
  hash,
  type AtomicGuard,
  type Capabilities,
  type Condition,
  type RollbackCommand,
} from "./cleaner-atomic-protocol";
import { DATAPLANE_URL, getDataplaneHeaders } from "./hindsight-client";

const CONTRACT = "cleaner-atomic-v1";
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_RESPONSE = 64 * 1024;
const CONDITION_KEYS = [
  "execution_config_sha256",
  "bank_id",
  "source_id",
  "source_sha256",
  "source_updated_at",
  "source_metadata_sha256",
  "target_id",
  "target_sha256",
  "owner_key",
  "operation_id",
  "payload_sha256",
];
const RECEIPT_KEYS = [
  "condition_sha256",
  "operation_id",
  "payload_sha256",
  "target_id",
  "owner_key",
  "target_sha256",
  "metadata_sha256",
  "graph_sha256",
  "updated_at",
  "status",
  "created",
  "rollback_operation_id",
  "rollback_payload_sha256",
  "created_receipt_sha256",
];
type Json = Record<string, unknown>;
interface Receipt {
  condition_sha256: string;
  operation_id: string;
  payload_sha256: string;
  target_id: string;
  owner_key: string;
  target_sha256: string;
  metadata_sha256: string;
  graph_sha256: string;
  updated_at: string;
  status: "completed" | "rolled_back";
  created: true;
  rollback_operation_id: string | null;
  rollback_payload_sha256: string | null;
  created_receipt_sha256: string | null;
}
export interface AtomicAdapterOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  headers?: (extra?: Record<string, string>) => Record<string, string>;
  timeoutMilliseconds?: number;
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Atomic protocol response invalid");
  return value as Json;
}
function exact(value: Json, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error("Atomic protocol fields invalid");
}
function text(value: unknown, max = 1024): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  );
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function bankId(bank: string) {
  if (!text(bank, 256)) throw new Error("Atomic bank scope invalid");
  return encodeURIComponent(bank);
}
function validateCondition(condition: Condition) {
  exact(object(condition), CONDITION_KEYS);
  bankId(condition.bank_id);
  for (const key of [
    "execution_config_sha256",
    "source_sha256",
    "source_metadata_sha256",
    "target_sha256",
    "payload_sha256",
  ] as const)
    if (!SHA.test(condition[key])) throw new Error("Atomic hash binding invalid");
  if (
    !UUID.test(condition.operation_id) ||
    !date(condition.source_updated_at) ||
    !text(condition.source_id) ||
    !text(condition.target_id) ||
    condition.source_id.startsWith("cleaner-v1-") ||
    !condition.target_id.startsWith("cleaner-v1-") ||
    condition.source_id === condition.target_id ||
    !SHA.test(condition.owner_key)
  )
    throw new Error("Atomic ownership binding invalid");
}
function validatePayload(condition: Condition, payloadJson: string) {
  if (
    typeof payloadJson !== "string" ||
    Buffer.byteLength(payloadJson) > ATOMIC_MAX_PAYLOAD_BYTES ||
    hash(payloadJson) !== condition.payload_sha256
  )
    throw new Error("Atomic candidate payload binding invalid");
  const payload = object(JSON.parse(payloadJson));
  exact(payload, ["async", "operation_id", "items"]);
  if (
    payload.async !== true ||
    payload.operation_id !== condition.operation_id ||
    !Array.isArray(payload.items) ||
    payload.items.length !== 1
  )
    throw new Error("Atomic literal payload invalid");
  const item = object(payload.items[0]);
  exact(item, ["document_id", "content", "timestamp", "metadata", "tags"]);
  const metadata = object(item.metadata);
  if (typeof item.content === "string" && !atomicCandidateWithinAdmission(item.content))
    throw new Error("Atomic candidate exceeds 50,000 Unicode code point admission bound");
  if (
    item.document_id !== condition.target_id ||
    typeof item.content !== "string" ||
    !item.content.length ||
    item.content.includes("\0") ||
    hash(item.content) !== condition.target_sha256 ||
    item.timestamp !== "unset" ||
    !Array.isArray(item.tags) ||
    item.tags.length > 100 ||
    item.tags.some((tag) => typeof tag !== "string") ||
    Object.values(metadata).some((value) => typeof value !== "string")
  )
    throw new Error("Atomic literal candidate invalid");
  const required = {
    cleaner_owner: "hindsight-cleaner-v1",
    cleaner_owner_key: condition.owner_key,
    cleaner_operation_id: condition.operation_id,
    cleaner_source_id: condition.source_id,
    cleaner_source_sha256: condition.source_sha256,
    cleaner_source_metadata_sha256: condition.source_metadata_sha256,
    cleaner_candidate_sha256: condition.target_sha256,
  };
  if (
    Object.entries(required).some(([key, value]) => metadata[key] !== value) ||
    !date(metadata.cleaner_source_updated_at) ||
    Date.parse(metadata.cleaner_source_updated_at) !== Date.parse(condition.source_updated_at)
  )
    throw new Error("Atomic provenance invalid");
}
function validateRollback(command: RollbackCommand) {
  validateCondition(command.condition);
  exact(object(command), [
    "condition",
    "expected_document_metadata_sha256",
    "expected_updated_at",
    "rollback_operation_id",
    "rollback_payload_sha256",
    "created_receipt_sha256",
  ]);
  const { rollback_payload_sha256, ...binding } = command;
  if (
    !SHA.test(command.expected_document_metadata_sha256) ||
    !SHA.test(command.created_receipt_sha256) ||
    !UUID.test(command.rollback_operation_id) ||
    !date(command.expected_updated_at) ||
    !SHA.test(rollback_payload_sha256) ||
    hash(canonical(binding)) !== rollback_payload_sha256
  )
    throw new Error("Atomic rollback binding invalid");
}
function parseReceipt(value: unknown, condition: Condition): Receipt {
  const receipt = object(value);
  exact(receipt, RECEIPT_KEYS);
  for (const key of [
    "condition_sha256",
    "payload_sha256",
    "target_sha256",
    "metadata_sha256",
    "graph_sha256",
  ])
    if (typeof receipt[key] !== "string" || !SHA.test(receipt[key]))
      throw new Error("Atomic receipt hash invalid");
  if (
    receipt.condition_sha256 !== hash(canonical(condition)) ||
    receipt.operation_id !== condition.operation_id ||
    receipt.payload_sha256 !== condition.payload_sha256 ||
    receipt.target_id !== condition.target_id ||
    receipt.owner_key !== condition.owner_key ||
    receipt.target_sha256 !== condition.target_sha256 ||
    receipt.created !== true ||
    !date(receipt.updated_at) ||
    !["completed", "rolled_back"].includes(String(receipt.status))
  )
    throw new Error("Atomic receipt binding mismatch");
  if (
    receipt.status === "completed" &&
    (receipt.rollback_operation_id !== null ||
      receipt.rollback_payload_sha256 !== null ||
      receipt.created_receipt_sha256 !== null)
  )
    throw new Error("Atomic initial receipt invalid");
  if (
    receipt.status === "rolled_back" &&
    (!UUID.test(String(receipt.rollback_operation_id)) ||
      !SHA.test(String(receipt.rollback_payload_sha256)) ||
      !SHA.test(String(receipt.created_receipt_sha256)))
  )
    throw new Error("Atomic tombstone invalid");
  return receipt as unknown as Receipt;
}
const unavailable = (): Capabilities => ({
  atomic_create: false,
  atomic_source_check: false,
  conditional_delete: false,
  contract_id: CONTRACT,
  reason:
    "Verified atomic cleaner capability is unavailable; no retain or DELETE fallback is enabled.",
});
export class CleanerAtomicAdapter implements AtomicGuard {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly headers: (extra?: Record<string, string>) => Record<string, string>;
  private readonly timeout: number;
  constructor(options: AtomicAdapterOptions = {}) {
    const url = new URL(options.baseUrl ?? DATAPLANE_URL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.port === "0" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname)
    )
      throw new Error("Atomic adapter requires a loopback dataplane origin");
    this.base = url.origin;
    this.fetcher = options.fetcher ?? fetch;
    this.headers = options.headers ?? getDataplaneHeaders;
    this.timeout = options.timeoutMilliseconds ?? 120_000;
    if (!Number.isFinite(this.timeout) || this.timeout < 1 || this.timeout > 120_000)
      throw new Error("Atomic timeout invalid");
  }
  private endpoint(bank: string, suffix: string) {
    return `${this.base}/v1/default/banks/${bankId(bank)}/cleaner/${suffix}`;
  }
  private async request(
    bank: string,
    suffix: string,
    method: "GET" | "POST",
    signal?: AbortSignal,
    body?: unknown
  ): Promise<unknown | null> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.timeout);
    try {
      if (controller.signal.aborted) throw new Error("Atomic request cancelled");
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && Buffer.byteLength(encoded) > ATOMIC_MAX_PAYLOAD_BYTES * 2 + 8192)
        throw new Error("Atomic request exceeds bound");
      const response = await this.fetcher(this.endpoint(bank, suffix), {
        method,
        body: encoded,
        headers: this.headers(encoded ? { "Content-Type": "application/json" } : undefined),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 404 && method === "GET") return null;
      if (!response.ok || !response.body)
        throw new Error(
          response.status === 429
            ? "Atomic API quota exhausted"
            : "Atomic request unavailable or conflicted"
        );
      const reader = response.body.getReader();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > MAX_RESPONSE) throw new Error("Atomic response exceeds bound");
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    } catch {
      throw new Error(
        "Atomic transport or protocol verification failed; reconcile accepted operations before any replay"
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  private async capability(bank: string, signal?: AbortSignal): Promise<Capabilities> {
    try {
      const result = object(await this.request(bank, "capabilities", "GET", signal));
      if (
        result.contract_id !== CONTRACT ||
        typeof result.atomic_create !== "boolean" ||
        typeof result.atomic_source_check !== "boolean" ||
        typeof result.conditional_delete !== "boolean" ||
        Object.keys(result).some(
          (key) =>
            ![
              "contract_id",
              "atomic_create",
              "atomic_source_check",
              "conditional_delete",
              "reason",
            ].includes(key)
        )
      )
        return unavailable();
      return {
        contract_id: CONTRACT,
        atomic_create: result.atomic_create,
        atomic_source_check: result.atomic_source_check,
        conditional_delete: result.conditional_delete,
        ...(!result.atomic_create || !result.atomic_source_check
          ? { reason: unavailable().reason }
          : {}),
      };
    } catch {
      return unavailable();
    }
  }
  capabilities(bank: string) {
    return this.capability(bank);
  }
  async create(command: { condition: Condition; payload_json: string }, signal: AbortSignal) {
    exact(object(command), ["condition", "payload_json"]);
    validateCondition(command.condition);
    validatePayload(command.condition, command.payload_json);
    const capability = await this.capability(command.condition.bank_id, signal);
    if (!capability.atomic_create || !capability.atomic_source_check)
      throw new Error("Verified atomic create capability unavailable");
    const result = object(
      await this.request(command.condition.bank_id, "operations", "POST", signal, command)
    );
    exact(result, ["accepted", "operation_id", "reused"]);
    if (
      result.accepted !== true ||
      result.operation_id !== command.condition.operation_id ||
      typeof result.reused !== "boolean"
    )
      throw new Error("Atomic create acknowledgement invalid");
    return { accepted: true, operation_id: command.condition.operation_id, reused: result.reused };
  }
  async operation(condition: Condition, signal: AbortSignal) {
    validateCondition(condition);
    const result = await this.request(
      condition.bank_id,
      `operations/${condition.operation_id}`,
      "GET",
      signal
    );
    if (result === null)
      return {
        operation_id: condition.operation_id,
        payload_sha256: condition.payload_sha256,
        status: "pending",
        created: false,
      };
    return parseReceipt(result, condition);
  }
  async remove(command: RollbackCommand, signal: AbortSignal) {
    validateRollback(command);
    const capability = await this.capability(command.condition.bank_id, signal);
    if (
      !capability.conditional_delete ||
      !capability.atomic_create ||
      !capability.atomic_source_check
    )
      throw new Error("Verified conditional rollback capability unavailable");
    const result = object(
      await this.request(
        command.condition.bank_id,
        `operations/${command.condition.operation_id}/rollback`,
        "POST",
        signal,
        command
      )
    );
    exact(result, ["deleted", "rollback_operation_id"]);
    if (result.deleted !== true || result.rollback_operation_id !== command.rollback_operation_id)
      throw new Error("Atomic rollback acknowledgement invalid");
    return { deleted: true, rollback_operation_id: command.rollback_operation_id };
  }
  async rollbackOperation(command: RollbackCommand, signal: AbortSignal) {
    validateRollback(command);
    const receipt = await this.operation(command.condition, signal);
    if (receipt.status === "rolled_back") {
      const proof = receipt as Receipt;
      if (
        proof.rollback_operation_id !== command.rollback_operation_id ||
        proof.rollback_payload_sha256 !== command.rollback_payload_sha256 ||
        proof.created_receipt_sha256 !== command.created_receipt_sha256
      )
        throw new Error("Atomic tombstone binding mismatch");
      return {
        rollback_operation_id: command.rollback_operation_id,
        rollback_payload_sha256: command.rollback_payload_sha256,
        status: "completed",
        deleted: true,
      };
    }
    return {
      rollback_operation_id: command.rollback_operation_id,
      rollback_payload_sha256: command.rollback_payload_sha256,
      status: "pending",
      deleted: false,
    };
  }
}
