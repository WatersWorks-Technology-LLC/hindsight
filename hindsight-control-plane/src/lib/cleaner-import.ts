/** Additive candidate imports. Ordinary retain/transfer writes are NEVER a fallback.
 * A verified server guard must provide atomic source/version checks + create-only semantics.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
export {
  ATOMIC_MAX_PAYLOAD_BYTES,
  ATOMIC_MAX_CANDIDATE_CODE_POINTS,
  atomicCandidateWithinAdmission,
  canonical,
  hash,
  type AtomicGuard,
  type Capabilities,
  type Condition,
  type RollbackCommand,
} from "./cleaner-atomic-protocol";
import { CleanerAtomicAdapter, type AtomicAdapterOptions } from "./cleaner-atomic-adapter";
import { getDataplaneHeaders } from "./hindsight-client";
import { cleanerBankUrl, cleanerServiceUrl } from "./cleaner-dataplane";
import { getJob, isJobActive, MAX_BYTES, validBank, type Job } from "./cleaner-jobs";

type Json = Record<string, unknown>;
type ItemStatus =
  | "planned"
  | "retryable"
  | "submitted"
  | "imported"
  | "reused"
  | "blocked"
  | "failed"
  | "uncertain"
  | "rolled_back";
type Status =
  | "prepared"
  | "blocked"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "paused"
  | "uncertain"
  | "failed";
interface SourceVersion {
  id: string;
  sha256: string;
  updated_at: string;
  metadata_sha256: string;
  backup: string;
  backup_sha256: string;
}
interface Item {
  document_index: number;
  segment_index: number;
  candidate_id: string;
  candidate_sha256: string;
  source: SourceVersion;
  owner_key: string;
  operation_id: string;
  payload: string;
  payload_sha256: string;
  source_start: number;
  source_end: number;
  rollback?: RollbackCommand;
  status: ItemStatus;
  error?: string;
  created: boolean;
}
interface ApprovedDocument {
  document_index: number;
  candidate_id: string;
  candidate_ids: string[];
  source_id: string;
  source_sha256: string;
  candidate_sha256: string;
  characters: number;
  segments: number;
  diff: string;
  diff_truncated: boolean;
  transformations: number;
  coverage: Json;
  source_ranges: Json[];
  original_preview: string;
  candidate_preview: string;
  preview_truncated: boolean;
}
interface Plan {
  id: string;
  job_id: string;
  bank_id: string;
  mode: "import" | "rollback";
  parent_plan?: string;
  created_at: string;
  expires_at: string;
  confirmation_token: string;
  plan_hash: string;
  status: Status;
  stage: string;
  directory: string;
  owner_pid: number;
  capability: Capabilities;
  config_sha256: string;
  eligible: ApprovedDocument[];
  rejected: Array<{ document_index: number; reason: string }>;
  items: Item[];
  error?: string;
  controller: AbortController;
}
export interface ImportDependencies {
  root: string;
  fetcher: typeof fetch;
  getJob: (id: string) => Promise<Job | undefined>;
  jobActive: (id: string) => boolean;
  verify: (job: Job, snapshot: string, directory: string, signal: AbortSignal) => Promise<Json>;
  guard?: AtomicGuard;
  pollMilliseconds?: number;
  pollAttempts?: number;
  maxCandidateBytes?: number;
}
const OWNER = "hindsight-cleaner-v1";
const uuid = (text: string) => {
  const h = hash(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function metadataHash(document: Json) {
  return hash(
    canonical({
      document_metadata: document.document_metadata ?? null,
      tags: document.tags ?? [],
      retain_params: document.retain_params ?? null,
    })
  );
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function safeId(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}
async function atomic(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temp, file);
}
async function privateRead(file: string) {
  const bytes = await readFile(file);
  if (bytes.length > MAX_BYTES) throw new Error("Private input exceeds limit");
  return bytes;
}
function unicodeOffsets(text: string, ranges: Json[]) {
  const wanted = new Set<number>([
    0,
    ...ranges.flatMap((range) => [Number(range.start), Number(range.end)]),
  ]);
  const offsets = new Map<number, number>([[0, 0]]);
  let points = 0;
  let units = 0;
  for (const character of text) {
    units += character.length;
    points++;
    if (wanted.has(points)) offsets.set(points, units);
  }
  return { length: points, offsets };
}
function privatePath(directory: string, relative: string) {
  const result = path.resolve(directory, relative);
  if (!result.startsWith(path.resolve(directory) + path.sep))
    throw new Error("Private path invalid");
  return result;
}
function sourceUrl(bank: string, id: string) {
  return cleanerBankUrl(bank, `/documents/${encodeURIComponent(id)}`);
}
class RetryableRead extends Error {}
async function api(fetcher: typeof fetch, url: string, signal?: AbortSignal): Promise<Json | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 30_000);
  if (signal?.aborted) abort();
  try {
    const response = await fetcher(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: getDataplaneHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok || !response.body)
      throw new RetryableRead(
        response.status === 429 ? "Read quota exhausted" : "Read unavailable"
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BYTES) throw new Error("Read exceeds limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const body = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof RetryableRead) throw error;
    if (controller.signal.aborted || error instanceof TypeError)
      throw new RetryableRead("Read unavailable or timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
function immutablePlan(plan: Plan) {
  return {
    id: plan.id,
    job_id: plan.job_id,
    bank_id: plan.bank_id,
    mode: plan.mode,
    parent_plan: plan.parent_plan,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    confirmation_token_sha256: hash(plan.confirmation_token),
    capability: plan.capability,
    config_sha256: plan.config_sha256,
    eligible: plan.eligible,
    rejected: plan.rejected,
    items: plan.items.map((i) => ({
      document_index: i.document_index,
      segment_index: i.segment_index,
      candidate_id: i.candidate_id,
      candidate_sha256: i.candidate_sha256,
      source: i.source,
      owner_key: i.owner_key,
      operation_id: i.operation_id,
      payload: i.payload,
      payload_sha256: i.payload_sha256,
      source_start: i.source_start,
      source_end: i.source_end,
      rollback: i.rollback,
    })),
  };
}
export function planView(plan: Plan) {
  return {
    plan_id: plan.id,
    plan_hash: plan.plan_hash,
    confirmation_token: plan.confirmation_token,
    expires_at: plan.expires_at,
    status:
      plan.status === "prepared" ? "prepared" : plan.status === "blocked" ? "blocked" : "prepared",
    bank_id: plan.bank_id,
    mode: plan.mode,
    eligible: plan.eligible,
    rejected: plan.rejected,
    backup_manifest: {
      originals: new Set(plan.items.map((i) => i.source.backup)).size,
      candidates: plan.items.length,
      verified: !!plan.plan_hash,
      manifest_sha256: plan.plan_hash,
    },
    guard: plan.capability,
    rollback: {
      available: plan.capability.conditional_delete,
      reason: plan.capability.conditional_delete
        ? "A separate explicit rollback plan is required"
        : "Pinned 0.10.2 DELETE has no conditional version precondition; verified server guard required",
    },
    error: plan.error,
    reason: plan.error,
    available: plan.mode === "rollback" && plan.status !== "blocked",
  };
}
export function operationView(plan: Plan) {
  const imported = plan.items.filter(
    (i) => i.status === "imported" || i.status === "rolled_back"
  ).length;
  const reused = plan.items.filter((i) => i.status === "reused").length;
  const failed = plan.items.filter((i) => i.status === "failed" || i.status === "retryable").length;
  const blocked = plan.items.filter((i) => i.status === "blocked").length;
  const uncertain = plan.items.filter(
    (i) => i.status === "uncertain" || i.status === "submitted"
  ).length;
  return {
    operation_id: plan.id,
    status: plan.status,
    stage: plan.stage,
    mode: plan.mode,
    progress: {
      total: plan.items.length,
      imported,
      rolled_back: plan.items.filter((i) => i.status === "rolled_back").length,
      reused,
      failed,
      blocked,
      uncertain,
      remaining: plan.items.length - imported - reused,
    },
    items: plan.items.map((i) => ({
      document_index: i.document_index,
      candidate_id: i.candidate_id,
      status: i.status,
      error: i.error,
    })),
    can_resume: ["paused", "cancelled", "partial", "failed", "uncertain"].includes(plan.status),
    can_reconcile: uncertain > 0,
  };
}

export class ImportService {
  private plans = new Map<string, Plan>();
  private active: string | null = null;
  private workers = new Map<string, Promise<void>>();
  readonly directory: string;
  constructor(private dependencies: ImportDependencies) {
    if (
      dependencies.maxCandidateBytes !== undefined &&
      (!Number.isSafeInteger(dependencies.maxCandidateBytes) ||
        dependencies.maxCandidateBytes < 1 ||
        dependencies.maxCandidateBytes > ATOMIC_MAX_PAYLOAD_BYTES)
    )
      throw new Error("Candidate write bound invalid");
    this.directory = path.join(dependencies.root, "runs", "imports");
  }
  private async capability(bank: string): Promise<Capabilities> {
    return this.dependencies.guard
      ? this.dependencies.guard.capabilities(bank)
      : {
          atomic_create: false,
          atomic_source_check: false,
          conditional_delete: false,
          contract_id: "pinned-0.10.2-no-cas",
          reason:
            "Import requires a verified atomic create/source-version service guard. Ordinary retain/transfer can replace raced documents; no unsafe fallback is enabled.",
        };
  }
  private async config(bank: string, signal?: AbortSignal) {
    const version = await api(this.dependencies.fetcher, cleanerServiceUrl("/version"), signal);
    if (version?.api_version !== "0.10.2") throw new Error("Pinned API version mismatch");
    const response = await api(this.dependencies.fetcher, cleanerBankUrl(bank, "/config"), signal);
    const config = response?.config as Json;
    if (
      response?.bank_id !== bank ||
      !config ||
      config.retain_extraction_mode !== "chunks" ||
      config.enable_observations !== false ||
      config.retain_default_strategy
    )
      throw new Error(
        "Bank must already use deterministic chunks and observations disabled, with no unverified default strategy"
      );
    return hash(canonical(config));
  }
  private async save(plan: Plan) {
    const saved = { ...plan };
    Reflect.deleteProperty(saved, "controller");
    await atomic(path.join(plan.directory, "state.json"), saved);
  }
  async get(id: string) {
    if (!safeId(id)) return;
    const current = this.plans.get(id);
    if (current) return current;
    try {
      const saved = JSON.parse(
        (await privateRead(path.join(this.directory, id, "state.json"))).toString("utf8")
      );
      if (saved.id !== id || !validBank(saved.bank_id)) return;
      const plan: Plan = {
        ...saved,
        directory: path.join(this.directory, id),
        controller: new AbortController(),
      };
      if (plan.status === "running" && !alive(plan.owner_pid)) {
        plan.status = "paused";
        plan.stage = "Interrupted; reconcile submitted operations before resuming";
        await this.save(plan);
      }
      this.plans.set(id, plan);
      return plan;
    } catch {
      return;
    }
  }
  async latest(job: string, bank: string) {
    let result: Plan | undefined;
    for (const name of await readdir(this.directory).catch(() => [])) {
      const plan = await this.get(name);
      if (
        plan?.job_id === job &&
        plan.bank_id === bank &&
        (!result || plan.created_at > result.created_at)
      )
        result = plan;
    }
    return result;
  }
  private async sourceMatches(plan: Plan, item: Item, signal?: AbortSignal) {
    const live = await api(
      this.dependencies.fetcher,
      sourceUrl(plan.bank_id, item.source.id),
      signal
    );
    if (
      !live ||
      live.id !== item.source.id ||
      live.bank_id !== plan.bank_id ||
      typeof live.original_text !== "string" ||
      hash(live.original_text) !== item.source.sha256 ||
      live.content_hash !== item.source.sha256 ||
      live.updated_at !== item.source.updated_at ||
      metadataHash(live) !== item.source.metadata_sha256
    )
      throw new Error("Source changed or unavailable; prepare a new plan");
    return live;
  }
  private owned(plan: Plan, item: Item, target: Json) {
    const meta = target.document_metadata as Json;
    return (
      target.id === item.candidate_id &&
      target.bank_id === plan.bank_id &&
      typeof target.original_text === "string" &&
      hash(target.original_text) === item.candidate_sha256 &&
      target.content_hash === item.candidate_sha256 &&
      meta?.cleaner_owner === OWNER &&
      meta.cleaner_owner_key === item.owner_key &&
      meta.cleaner_operation_id === item.operation_id &&
      meta.cleaner_source_sha256 === item.source.sha256
    );
  }
  private async verifyFiles(plan: Plan) {
    const manifest = JSON.parse(
      (await privateRead(path.join(plan.directory, "manifest.json"))).toString("utf8")
    );
    if (
      hash(canonical(manifest)) !== plan.plan_hash ||
      hash(canonical(immutablePlan(plan))) !== plan.plan_hash
    )
      throw new Error("Plan manifest integrity changed");
    for (const item of plan.items) {
      const payload = await privateRead(privatePath(plan.directory, item.payload));
      const original = await privateRead(privatePath(plan.directory, item.source.backup));
      if (hash(payload) !== item.payload_sha256 || hash(original) !== item.source.backup_sha256)
        throw new Error("Private backup integrity changed");
      const body = JSON.parse(payload.toString("utf8"));
      if (
        body.operation_id !== item.operation_id ||
        body.items?.length !== 1 ||
        body.items[0].document_id !== item.candidate_id ||
        hash(body.items[0].content) !== item.candidate_sha256
      )
        throw new Error("Candidate integrity changed");
      if (item.rollback) {
        const { rollback_payload_sha256, ...binding } = item.rollback;
        if (hash(canonical(binding)) !== rollback_payload_sha256)
          throw new Error("Rollback binding changed");
        const proof = await privateRead(
          path.join(plan.directory, `receipt-${plan.items.indexOf(item)}.json`)
        );
        if (hash(proof) !== item.rollback.created_receipt_sha256)
          throw new Error("Created receipt integrity changed");
      }
    }
  }
  async prepare(jobId: string, bank: string, indexes: number[]) {
    if (
      !validBank(bank) ||
      bank.length > 256 ||
      !Array.isArray(indexes) ||
      indexes.length < 1 ||
      indexes.length > 10 ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((i) => !Number.isSafeInteger(i) || i < 0)
    )
      throw new Error("Select 1–10 explicit source documents");
    const job = await this.dependencies.getJob(jobId);
    if (
      !job ||
      job.bank_id !== bank ||
      job.mode === "upload" ||
      this.dependencies.jobActive(job.id) ||
      job.status === "running"
    )
      throw new Error("A finished bank-source preview is required");
    const capability = await this.capability(bank);
    const id = randomUUID();
    const directory = path.join(this.directory, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const plan: Plan = {
      id,
      job_id: jobId,
      bank_id: bank,
      mode: "import",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      confirmation_token: randomBytes(32).toString("hex"),
      plan_hash: "",
      status: "prepared",
      stage: "Prepared; awaiting explicit bank and plan confirmation",
      directory,
      owner_pid: process.pid,
      capability,
      config_sha256: "",
      eligible: [],
      rejected: [],
      items: [],
      controller: new AbortController(),
    };
    try {
      plan.config_sha256 = await this.config(bank);
    } catch {
      plan.status = "blocked";
      plan.error =
        "Pinned API/config unavailable or bank is not verified chunks with observations disabled; no settings are changed.";
    }
    for (const index of indexes) {
      try {
        const record = job.records[index];
        if (record && record.id.length > 1024)
          throw new Error("Source identifier exceeds atomic protocol bound");
        if (record?.id.startsWith("cleaner-v1-"))
          throw new Error(
            "Candidate source is already a cleaner version; import original sources only"
          );
        if (
          !record ||
          record.status !== "processed" ||
          !record.snapshot ||
          !record.snapshot_sha256 ||
          !record.report
        )
          throw new Error("Candidate is quarantined, incomplete, failed or unavailable");
        const sourceBytes = await privateRead(privatePath(job.directory, record.snapshot));
        if (hash(sourceBytes) !== record.snapshot_sha256)
          throw new Error("Source snapshot integrity changed");
        const originals = JSON.parse(sourceBytes.toString("utf8"));
        if (originals.length !== 1) throw new Error("Source scope mismatch");
        const original = originals[0];
        if (
          original.id !== record.id ||
          original.bank_id !== bank ||
          original.project_id !== bank ||
          typeof original.original_text !== "string"
        )
          throw new Error("Source scope mismatch");
        const storedReport = JSON.parse(
          (await privateRead(privatePath(job.directory, record.report))).toString("utf8")
        );
        const doc = storedReport.documents?.[0] as Json;
        if (
          storedReport.status !== "completed" ||
          storedReport.documents?.length !== 1 ||
          doc?.status !== "candidate" ||
          doc.bank_id !== bank ||
          doc.project_id !== bank
        )
          throw new Error("Candidate is quarantined or incomplete");
        const verificationDirectory = path.join(directory, `verify-${index}`);
        await mkdir(verificationDirectory, { recursive: true, mode: 0o700 });
        const recomputed = await this.dependencies.verify(
          job,
          path.join(job.directory, record.snapshot),
          verificationDirectory,
          plan.controller.signal
        );
        if (canonical(recomputed.documents) !== canonical(storedReport.documents))
          throw new Error("Candidate differs from deterministic source evidence");
        const raw = original.original_text;
        const rawHash = hash(raw);
        const coverage = doc.coverage as Json;
        const segments = doc.segments as Json[];
        const unicode = unicodeOffsets(raw, Array.isArray(segments) ? segments : []);
        if (
          doc.raw_sha256 !== rawHash ||
          !coverage ||
          coverage.semantic_rewrite !== false ||
          !Array.isArray(coverage.omissions) ||
          coverage.omissions.length ||
          coverage.source_characters_mapped !== unicode.length ||
          coverage.dates_total !== coverage.dates_preserved ||
          coverage.citation_occurrences_total !== coverage.citation_occurrences_preserved ||
          !Array.isArray(segments) ||
          !segments.length ||
          plan.items.length + segments.length > 100
        )
          throw new Error("Candidate coverage or bounded operation list is incomplete");
        let offset = 0;
        for (const segment of segments) {
          if (
            segment.start !== offset ||
            !Number.isSafeInteger(segment.end) ||
            Number(segment.end) < offset ||
            hash(
              raw.slice(unicode.offsets.get(offset), unicode.offsets.get(Number(segment.end)))
            ) !== segment.sha256 ||
            typeof segment.text !== "string" ||
            !segment.text.length
          )
            throw new Error("Candidate source mapping invalid");
          offset = Number(segment.end);
        }
        if (offset !== unicode.length) throw new Error("Candidate omits source ranges");
        const live = await api(this.dependencies.fetcher, sourceUrl(bank, record.id));
        if (
          !live ||
          live.id !== record.id ||
          live.bank_id !== bank ||
          live.content_hash !== rawHash ||
          live.original_text !== raw ||
          typeof live.updated_at !== "string" ||
          original.metadata?.updated_at !== live.updated_at
        )
          throw new Error("Live source version changed since preview");
        if (
          canonical(original.metadata?.source_metadata ?? null) !==
            canonical(live.document_metadata ?? live.metadata ?? null) ||
          canonical(original.metadata?.source_retain_params ?? null) !==
            canonical(live.retain_params ?? null) ||
          canonical(original.metadata?.tags ?? []) !== canonical(live.tags ?? [])
        )
          throw new Error("Source metadata changed or was not captured; create a fresh preview");
        if (
          !Array.isArray(live.tags) ||
          live.tags.length > 100 ||
          live.tags.some((tag) => typeof tag !== "string")
        )
          throw new Error("Source tags exceed atomic protocol bounds");
        if ((live.document_metadata as Json)?.cleaner_owner === OWNER)
          throw new Error(
            "Candidate source is already a cleaner-owned version; import original sources only"
          );
        const sourceBackup = `original-${index}.json`;
        const backupBytes = Buffer.from(JSON.stringify(live));
        await writeFile(path.join(directory, sourceBackup), backupBytes, {
          mode: 0o600,
          flag: "wx",
        });
        const source: SourceVersion = {
          id: record.id,
          sha256: rawHash,
          updated_at: live.updated_at,
          metadata_sha256: metadataHash(live),
          backup: sourceBackup,
          backup_sha256: hash(backupBytes),
        };
        const approved: ApprovedDocument = {
          document_index: index,
          candidate_id: "",
          candidate_ids: [],
          source_id: String(doc.id),
          source_sha256: rawHash,
          candidate_sha256: hash(segments.map((s) => s.text).join("")),
          characters: segments.reduce(
            (sum, s) => sum + unicodeOffsets(String(s.text), []).length,
            0
          ),
          segments: segments.length,
          diff: String(doc.diff || ""),
          diff_truncated: !!doc.diff_truncated,
          transformations: ((doc.transformations || []) as unknown[]).length,
          coverage,
          source_ranges: segments.map((s) => ({ start: s.start, end: s.end, sha256: s.sha256 })),
          original_preview: String(doc.original_preview || ""),
          candidate_preview: String(doc.candidate_preview || ""),
          preview_truncated: !!doc.preview_truncated,
        };
        const items: Item[] = [];
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
          const segment = segments[segmentIndex];
          if (!atomicCandidateWithinAdmission(String(segment.text)))
            throw new Error(
              "Candidate exceeds 50,000 Unicode code point admission bound; split into smaller reviewed source sections"
            );
          const candidateHash = hash(String(segment.text));
          const identity = canonical({
            bank,
            source_id: record.id,
            source_sha256: rawHash,
            source_updated_at: source.updated_at,
            source_metadata_sha256: source.metadata_sha256,
            candidate_sha256: candidateHash,
            engine: storedReport.engine_version || "1.0.0",
            segment_index: segmentIndex,
            start: segment.start,
            end: segment.end,
          });
          const candidateId = "cleaner-v1-" + hash(identity).slice(0, 48);
          const ownerKey = hash(OWNER + identity);
          const operationId = uuid(ownerKey);
          const metadata = {
            cleaner_owner: OWNER,
            cleaner_owner_key: ownerKey,
            cleaner_operation_id: operationId,
            cleaner_source_id: record.id,
            cleaner_source_sha256: rawHash,
            cleaner_source_updated_at: source.updated_at,
            cleaner_source_metadata_sha256: source.metadata_sha256,
            cleaner_candidate_sha256: candidateHash,
            cleaner_source_range: canonical({ start: segment.start, end: segment.end }),
            cleaner_evidence_status: "unverified source candidate; no semantic rewrite",
          };
          const payload = {
            async: true,
            operation_id: operationId,
            items: [
              {
                document_id: candidateId,
                content: segment.text,
                timestamp: "unset",
                metadata,
                tags: live.tags || [],
              },
            ],
          };
          const payloadBytes = Buffer.from(JSON.stringify(payload));
          if (
            payloadBytes.length > (this.dependencies.maxCandidateBytes ?? ATOMIC_MAX_PAYLOAD_BYTES)
          )
            throw new Error(
              "Candidate exceeds atomic payload write bound; source reads remain independent"
            );
          const payloadName = `candidate-${index}-${segmentIndex}.json`;
          await writeFile(path.join(directory, payloadName), payloadBytes, {
            mode: 0o600,
            flag: "wx",
          });
          const item: Item = {
            document_index: index,
            segment_index: segmentIndex,
            candidate_id: candidateId,
            candidate_sha256: candidateHash,
            source,
            owner_key: ownerKey,
            operation_id: operationId,
            payload: payloadName,
            payload_sha256: hash(payloadBytes),
            source_start: Number(segment.start),
            source_end: Number(segment.end),
            status: "planned",
            created: false,
          };
          const target = await api(this.dependencies.fetcher, sourceUrl(bank, candidateId));
          if (target && !this.owned(plan, item, target))
            throw new Error("Deterministic target exists with different content or ownership");
          if (
            capability.atomic_create &&
            capability.atomic_source_check &&
            this.dependencies.guard?.operation
          ) {
            const receipt = await this.dependencies.guard.operation(
              this.condition(plan, item),
              plan.controller.signal
            );
            if (
              receipt.operation_id !== item.operation_id ||
              receipt.payload_sha256 !== item.payload_sha256
            )
              throw new Error(
                "Candidate operation receipt binding changed; no resubmission prepared"
              );
            if (receipt.status === "rolled_back")
              throw new Error(
                "Candidate was previously rolled back; restoring the same unchanged candidate is unavailable"
              );
            const missing = receipt.status === "pending" && receipt.created === false && !target;
            if (!missing && (receipt.status !== "completed" || receipt.created !== true || !target))
              throw new Error(
                "Candidate operation outcome is unavailable or uncertain; reconcile the existing plan before preparing another"
              );
          }
          items.push(item);
        }
        approved.candidate_ids = items.map((item) => item.candidate_id);
        approved.candidate_id = approved.candidate_ids[0];
        plan.eligible.push(approved);
        plan.items.push(...items);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const safe = /^(Candidate |Source |Live source |Deterministic target )/.test(message)
          ? message
          : "Source validation failed; no candidate writes prepared";
        plan.rejected.push({ document_index: index, reason: safe });
      }
    }
    if (!capability.atomic_create || !capability.atomic_source_check) {
      plan.status = "blocked";
      plan.error =
        capability.reason ||
        "Verified atomic create/source-version guard required; ordinary retain/transfer writes are disabled.";
    }
    if (!plan.items.length) {
      plan.status = "blocked";
      plan.error ||= "No eligible candidates were prepared";
    }
    const manifest = immutablePlan(plan);
    plan.plan_hash = hash(canonical(manifest));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    await this.save(plan);
    this.plans.set(id, plan);
    return planView(plan);
  }
  private confirmation(
    plan: Plan,
    input: {
      bank_confirmation: string;
      plan_hash: string;
      confirmation_token: string;
      acknowledged: boolean;
    },
    allowExpired = false
  ) {
    if (
      input.bank_confirmation !== plan.bank_id ||
      input.plan_hash !== plan.plan_hash ||
      input.acknowledged !== true ||
      (!allowExpired && Date.now() > Date.parse(plan.expires_at))
    )
      throw new Error("Confirmation bank, plan or expiry mismatch");
    const a = Buffer.from(input.confirmation_token || "");
    const b = Buffer.from(plan.confirmation_token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new Error("Confirmation token mismatch");
  }
  private async acquire(plan: Plan) {
    if (this.active) throw new Error("An import worker is already active");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, ".active.json");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, plan_id: plan.id }), {
          mode: 0o600,
          flag: "wx",
        });
        this.active = plan.id;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = JSON.parse(await readFile(lock, "utf8"));
        if (alive(previous.pid)) throw new Error("An import worker is already active");
        await unlink(lock).catch(() => undefined);
      }
    }
    throw new Error("Import ownership unavailable");
  }
  private async release(plan: Plan) {
    if (this.active !== plan.id) return;
    try {
      const file = path.join(this.directory, ".active.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (saved.plan_id === plan.id) await unlink(file);
    } finally {
      this.active = null;
    }
  }
  async confirm(
    id: string,
    input: {
      bank_confirmation: string;
      plan_hash: string;
      confirmation_token: string;
      acknowledged: boolean;
    },
    reconcileOnly = false
  ) {
    const plan = await this.get(id);
    if (!plan) throw new Error("Plan unavailable");
    this.confirmation(plan, input, reconcileOnly);
    if (plan.status === "running") return operationView(plan);
    await this.workers.get(plan.id);
    if (plan.status === "completed") return operationView(plan);
    if (plan.status === "blocked")
      throw new Error("Verified server import guard required or plan has no eligible candidates");
    await this.verifyFiles(plan);
    const capability = reconcileOnly ? plan.capability : await this.capability(plan.bank_id);
    if (
      !reconcileOnly &&
      (!this.dependencies.guard ||
        !capability.atomic_create ||
        !capability.atomic_source_check ||
        capability.contract_id !== plan.capability.contract_id ||
        (plan.mode === "rollback" && !capability.conditional_delete))
    )
      throw new Error("Verified server guard capability unavailable or changed");
    if (
      !reconcileOnly &&
      plan.mode === "import" &&
      (await this.config(plan.bank_id)) !== plan.config_sha256
    )
      throw new Error("Bank execution config changed; prepare a new plan");
    await this.acquire(plan);
    try {
      plan.controller = new AbortController();
      plan.status = "running";
      plan.owner_pid = process.pid;
      plan.error = undefined;
      plan.stage = reconcileOnly
        ? "Reconciling accepted operations; no blind resubmission"
        : plan.mode === "rollback"
          ? "Validating exact created targets for conditional rollback"
          : "Validating source versions and importing fresh candidates";
      await this.save(plan);
      const promise = this.execute(plan, reconcileOnly).catch(() => {
        plan.status = "failed";
        plan.error = "Local checkpoint unavailable; accepted operations must be reconciled";
      });
      this.workers.set(plan.id, promise);
      void promise.finally(() => this.workers.delete(plan.id));
      return operationView(plan);
    } catch {
      plan.status = "paused";
      plan.stage = "Checkpoint unavailable; no worker started";
      await this.release(plan);
      await this.save(plan).catch(() => undefined);
      throw new Error("Import checkpoint unavailable");
    }
  }
  async cancel(id: string) {
    const plan = await this.get(id);
    if (!plan || this.active !== id) return false;
    plan.status = "cancelled";
    plan.stage = "Local queue stopped; accepted API operations remain for reconciliation";
    plan.controller.abort();
    try {
      await this.save(plan);
    } finally {
      await this.workers.get(id);
    }
    return true;
  }
  private condition(plan: Plan, item: Item): Condition {
    return {
      execution_config_sha256: plan.config_sha256,
      bank_id: plan.bank_id,
      source_id: item.source.id,
      source_sha256: item.source.sha256,
      source_updated_at: item.source.updated_at,
      source_metadata_sha256: item.source.metadata_sha256,
      target_id: item.candidate_id,
      target_sha256: item.candidate_sha256,
      owner_key: item.owner_key,
      operation_id: item.operation_id,
      payload_sha256: item.payload_sha256,
    };
  }
  private async reconcile(plan: Plan, item: Item) {
    const operation = this.dependencies.guard?.operation
      ? await this.dependencies.guard.operation(this.condition(plan, item), plan.controller.signal)
      : await api(
          this.dependencies.fetcher,
          cleanerBankUrl(plan.bank_id, `/operations/${encodeURIComponent(item.operation_id)}`),
          plan.controller.signal
        );
    if (
      operation &&
      "payload_sha256" in operation &&
      operation.payload_sha256 !== item.payload_sha256
    ) {
      item.status = "blocked";
      item.error = "Operation payload binding changed; no replay";
      return true;
    }
    const target = await api(
      this.dependencies.fetcher,
      sourceUrl(plan.bank_id, item.candidate_id),
      plan.controller.signal
    );
    if (target && !this.owned(plan, item, target)) {
      item.status = "blocked";
      item.error = "Target content or ownership changed; no overwrite";
      return true;
    }
    if (
      operation?.operation_id === item.operation_id &&
      operation.status === "completed" &&
      target &&
      this.owned(plan, item, target) &&
      Number(target.memory_unit_count) > 0
    ) {
      item.status = item.created ? "imported" : "reused";
      item.error = undefined;
      return true;
    }
    if (operation?.status === "failed" || operation?.status === "cancelled") {
      item.status = "failed";
      item.error = "Existing API operation failed or cancelled; no new UUID or automatic replay";
      return true;
    }
    item.status = "uncertain";
    item.error =
      "Existing operation outcome is not fully verified; reconcile before any further action";
    return false;
  }
  private async processItem(plan: Plan, item: Item, reconcileOnly: boolean) {
    const timer = setTimeout(() => plan.controller.abort(), 120_000);
    try {
      if (item.status === "retryable" && !reconcileOnly) {
        item.status = "planned";
        item.error = undefined;
      }
      if (["submitted", "uncertain", "failed"].includes(item.status)) {
        await this.reconcile(plan, item);
        return;
      }
      if (item.status !== "planned") return;
      if (reconcileOnly) return;
      await this.verifyFiles(plan);
      await this.sourceMatches(plan, item, plan.controller.signal);
      if ((await this.config(plan.bank_id, plan.controller.signal)) !== plan.config_sha256)
        throw new Error("Bank execution config changed");
      const target = await api(
        this.dependencies.fetcher,
        sourceUrl(plan.bank_id, item.candidate_id),
        plan.controller.signal
      );
      if (target) {
        if (!this.owned(plan, item, target))
          throw new Error("Target exists with different content or ownership");
        item.created = false;
        await this.reconcile(plan, item);
        return;
      }
      const payloadJson = (await privateRead(privatePath(plan.directory, item.payload))).toString(
        "utf8"
      );
      if (plan.controller.signal.aborted) return;
      item.status = "submitted";
      item.created = false;
      await this.save(plan); // durable payload hash + stable UUID before network side effects
      const result = await this.dependencies.guard!.create(
        { condition: this.condition(plan, item), payload_json: payloadJson },
        plan.controller.signal
      );
      if (result.operation_id !== item.operation_id || !result.accepted)
        throw new Error("Guard acknowledgement mismatch");
      if (result.reused) {
        item.created = false;
        item.status = "uncertain";
        await this.reconcile(plan, item);
        return;
      }
      item.created = true;
      await this.save(plan);
      for (let attempt = 0; attempt < (this.dependencies.pollAttempts ?? 10); attempt++) {
        if (plan.controller.signal.aborted) return;
        if (await this.reconcile(plan, item)) return;
        await this.save(plan);
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timeout);
            plan.controller.signal.removeEventListener("abort", abort);
            resolve();
          };
          const abort = () => {
            clearTimeout(timeout);
            plan.controller.signal.removeEventListener("abort", abort);
            reject(new Error("Cancelled"));
          };
          const timeout = setTimeout(finish, this.dependencies.pollMilliseconds ?? 1000);
          plan.controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    } catch (error) {
      const beforeSubmission = item.status === "planned";
      item.status = beforeSubmission
        ? error instanceof RetryableRead || plan.controller.signal.aborted
          ? "retryable"
          : "blocked"
        : "uncertain";
      item.error = beforeSubmission
        ? error instanceof RetryableRead
          ? "Read unavailable; review and resume this plan to retry"
          : "Source/config/target or private integrity precondition failed; prepare a new plan"
        : "Acknowledgement or outcome uncertain; only read-only reconciliation is permitted";
      if (error instanceof Error && error.message === "Read quota exhausted")
        item.error = "API quota exhausted; no blind retry";
    } finally {
      clearTimeout(timer);
      await this.save(plan);
    }
  }
  private async execute(plan: Plan, reconcileOnly: boolean) {
    try {
      for (const item of plan.items) {
        if (plan.controller.signal.aborted) break;
        plan.stage = `${reconcileOnly ? "Reconciling" : plan.mode === "rollback" ? "Rolling back" : "Importing"} candidate ${plan.items.indexOf(item) + 1} of ${plan.items.length}; originals preserved`;
        await this.save(plan);
        await (plan.mode === "rollback"
          ? this.processRollbackItem(plan, item, reconcileOnly)
          : this.processItem(plan, item, reconcileOnly));
        if (!reconcileOnly && ["submitted", "uncertain", "retryable"].includes(item.status)) break;
      }
      if (plan.status === "running") {
        const uncertain = plan.items.some(
          (i) => i.status === "uncertain" || i.status === "submitted"
        );
        const incomplete = plan.items.some(
          (i) => !["imported", "reused", "rolled_back"].includes(i.status)
        );
        plan.status = uncertain ? "uncertain" : incomplete ? "partial" : "completed";
        plan.stage = uncertain
          ? "Accepted/uncertain operations need reconciliation; no blind retry"
          : incomplete
            ? "Some candidates were blocked or failed; originals preserved"
            : "All selected candidate outcomes verified; originals preserved";
      }
    } finally {
      try {
        await this.save(plan);
      } finally {
        await this.release(plan);
      }
    }
  }
  private async reconcileRollback(plan: Plan, item: Item) {
    const command = item.rollback;
    if (!command || !this.dependencies.guard?.rollbackOperation) {
      item.status = "uncertain";
      item.error = "Conditional rollback receipt unavailable; no deletion replay";
      return;
    }
    const receipt = await this.dependencies.guard.rollbackOperation(
      command,
      plan.controller.signal
    );
    if (
      receipt.rollback_operation_id !== command.rollback_operation_id ||
      receipt.rollback_payload_sha256 !== command.rollback_payload_sha256
    ) {
      item.status = "blocked";
      item.error = "Rollback receipt binding changed";
      return;
    }
    if (receipt.status === "completed" && receipt.deleted === true) {
      const target = await api(
        this.dependencies.fetcher,
        sourceUrl(plan.bank_id, item.candidate_id),
        plan.controller.signal
      );
      if (target) {
        item.status = "blocked";
        item.error = "Deleted target reappeared; no further deletion";
        return;
      }
      item.status = "rolled_back";
      item.error = undefined;
      return;
    }
    item.status = receipt.status === "failed" ? "failed" : "uncertain";
    item.error = "Rollback outcome requires its durable tombstone receipt; no blind retry";
  }
  private async processRollbackItem(plan: Plan, item: Item, reconcileOnly: boolean) {
    const timer = setTimeout(() => plan.controller.abort(), 120_000);
    try {
      if (item.status === "retryable" && !reconcileOnly) item.status = "planned";
      if (["submitted", "uncertain", "failed"].includes(item.status)) {
        await this.reconcileRollback(plan, item);
        return;
      }
      if (item.status !== "planned" || reconcileOnly) return;
      await this.verifyFiles(plan);
      const command = item.rollback;
      if (
        !command ||
        !this.dependencies.guard?.remove ||
        !this.dependencies.guard.rollbackOperation
      )
        throw new Error("Conditional guard unavailable");
      const target = await api(
        this.dependencies.fetcher,
        sourceUrl(plan.bank_id, item.candidate_id),
        plan.controller.signal
      );
      if (
        !target ||
        !this.owned(plan, item, target) ||
        metadataHash(target) !== command.expected_document_metadata_sha256 ||
        target.updated_at !== command.expected_updated_at
      )
        throw new Error("Exact created target changed");
      if (plan.controller.signal.aborted) return;
      item.status = "submitted";
      await this.save(plan);
      const result = await this.dependencies.guard.remove(command, plan.controller.signal);
      if (!result.deleted || result.rollback_operation_id !== command.rollback_operation_id)
        throw new Error("Conditional deletion acknowledgement unverified");
      await this.reconcileRollback(plan, item);
    } catch (error) {
      const before = item.status === "planned";
      item.status = before
        ? error instanceof RetryableRead
          ? "retryable"
          : "blocked"
        : "uncertain";
      item.error = before
        ? "Exact created target or conditional guard precondition failed"
        : "Rollback acknowledgement uncertain; reconcile the same tombstone operation";
    } finally {
      clearTimeout(timer);
      await this.save(plan);
    }
  }
  async rollbackPlan(id: string, bank: string) {
    const parent = await this.get(id);
    if (
      !parent ||
      parent.bank_id !== bank ||
      parent.mode !== "import" ||
      parent.status === "running"
    )
      throw new Error("Rollback source plan boundary mismatch");
    await this.workers.get(id);
    if (this.active === id) throw new Error("Rollback source plan worker has not settled");
    await this.verifyFiles(parent);
    const capability = await this.capability(bank);
    const planId = randomUUID();
    const directory = path.join(this.directory, planId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const plan: Plan = {
      ...parent,
      id: planId,
      parent_plan: parent.id,
      mode: "rollback",
      directory,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      confirmation_token: randomBytes(32).toString("hex"),
      plan_hash: "",
      status: "prepared",
      stage: "Separate rollback plan; new explicit bank confirmation required",
      capability,
      items: [],
      eligible: [],
      rejected: [],
      controller: new AbortController(),
    };
    const supported =
      capability.conditional_delete &&
      !!this.dependencies.guard?.remove &&
      !!this.dependencies.guard.operation &&
      !!this.dependencies.guard.rollbackOperation;
    for (const original of parent.items) {
      if (original.status !== "imported" || !original.created) {
        plan.rejected.push({
          document_index: original.document_index,
          reason:
            "Not a verified candidate created by this plan; reused and original documents are excluded",
        });
        continue;
      }
      try {
        if (!supported)
          throw new Error("Verified conditional guard and durable created receipt required");
        const receipt = await this.dependencies.guard!.operation!(
          this.condition(parent, original),
          plan.controller.signal
        );
        if (
          receipt.operation_id !== original.operation_id ||
          receipt.payload_sha256 !== original.payload_sha256 ||
          receipt.status !== "completed" ||
          receipt.created !== true
        )
          throw new Error("Immutable created receipt not verified");
        const target = await api(this.dependencies.fetcher, sourceUrl(bank, original.candidate_id));
        if (
          !target ||
          !this.owned(parent, original, target) ||
          typeof target.updated_at !== "string" ||
          !original.candidate_id.startsWith("cleaner-v1-") ||
          original.candidate_id === original.source.id
        )
          throw new Error("Exact owned candidate no longer verified");
        const item: Item = {
          ...original,
          source: { ...original.source },
          status: "planned",
          error: undefined,
        };
        for (const name of [item.payload, item.source.backup]) {
          const bytes = await privateRead(privatePath(parent.directory, name));
          await writeFile(privatePath(directory, name), bytes, { mode: 0o600, flag: "wx" }).catch(
            async (error) => {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              if (hash(await privateRead(privatePath(directory, name))) !== hash(bytes))
                throw error;
            }
          );
        }
        if (
          receipt.target_id !== original.candidate_id ||
          receipt.owner_key !== original.owner_key ||
          receipt.target_sha256 !== original.candidate_sha256 ||
          receipt.metadata_sha256 !== metadataHash(target) ||
          receipt.updated_at !== target.updated_at ||
          !/^[a-f0-9]{64}$/.test(receipt.graph_sha256 || "")
        )
          throw new Error("Created receipt target properties changed");
        const proof = canonical({
          ...receipt,
          rollback_operation_id: receipt.rollback_operation_id ?? null,
          rollback_payload_sha256: receipt.rollback_payload_sha256 ?? null,
          created_receipt_sha256: receipt.created_receipt_sha256 ?? null,
        });
        await writeFile(path.join(directory, `receipt-${plan.items.length}.json`), proof, {
          mode: 0o600,
          flag: "wx",
        });
        const command = {
          condition: this.condition(parent, original),
          expected_document_metadata_sha256: metadataHash(target),
          expected_updated_at: String(target.updated_at),
          rollback_operation_id: uuid(planId + original.operation_id),
          created_receipt_sha256: hash(proof),
        };
        item.rollback = { ...command, rollback_payload_sha256: hash(canonical(command)) };
        plan.items.push(item);
      } catch {
        plan.rejected.push({
          document_index: original.document_index,
          reason:
            "Exact created target, immutable receipt or conditional guard is unavailable; no delete prepared",
        });
      }
    }
    plan.eligible = parent.eligible.filter((doc) =>
      plan.items.some((item) => item.document_index === doc.document_index)
    );
    if (!supported || !plan.items.length) {
      plan.status = "blocked";
      plan.error =
        "Rollback requires a verified atomic conditional-delete guard and durable created/tombstone receipts. No original or candidate deletion is issued.";
    }
    const manifest = immutablePlan(plan);
    plan.plan_hash = hash(canonical(manifest));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
      flag: "wx",
    });
    await this.save(plan);
    this.plans.set(plan.id, plan);
    return planView(plan);
  }
}

async function verifyCore(
  job: Job,
  snapshot: string,
  directory: string,
  signal: AbortSignal
): Promise<Json> {
  const root = process.env.CLEANER_ROOT || path.resolve(process.cwd(), "..");
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-m",
      "cleaner",
      "preview",
      snapshot,
      "--bank",
      job.bank_id,
      "--project",
      job.bank_id,
      "--max-documents",
      "1",
      "--output",
      directory,
    ];
    const child = spawn(process.env.CLEANER_PYTHON || "python3", args, {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 120_000);
    child.on("error", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Deterministic verifier unavailable"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error("Deterministic verifier rejected candidate"));
    });
    if (signal.aborted) abort();
  });
  const receipt = JSON.parse(
    (await privateRead(path.join(directory, "receipt.json"))).toString("utf8")
  );
  if (!/^[a-f0-9]{24}$/.test(receipt.batch_id)) throw new Error("Verifier receipt invalid");
  return JSON.parse(
    (await privateRead(path.join(directory, receipt.batch_id, "report.json"))).toString("utf8")
  );
}
const globalLocal = globalThis as typeof globalThis & { cleanerImportService?: ImportService };
export function createImportService(
  dependencies: ImportDependencies,
  options: { enableAtomicGuard?: boolean; adapter?: AtomicAdapterOptions } = {}
) {
  let guard = dependencies.guard;
  if (!guard && (options.enableAtomicGuard ?? process.env.CLEANER_ENABLE_ATOMIC_IMPORTS === "1")) {
    try {
      guard = new CleanerAtomicAdapter({ fetcher: dependencies.fetcher, ...options.adapter });
    } catch {
      guard = undefined;
    }
  }
  return new ImportService({ ...dependencies, guard });
}
export const importService = (globalLocal.cleanerImportService ||= createImportService({
  root: process.env.CLEANER_ROOT || path.resolve(process.cwd(), ".."),
  fetcher: fetch,
  getJob,
  jobActive: isJobActive,
  verify: verifyCore,
}));
