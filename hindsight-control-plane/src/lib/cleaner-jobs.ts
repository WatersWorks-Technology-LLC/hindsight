/** Local read-only source jobs. No Hindsight write path exists in this module. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { getDataplaneHeaders } from "./hindsight-client";
import { cleanerBankUrl } from "./cleaner-dataplane";

export const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 100;
type Status = "running" | "completed" | "partial" | "failed" | "cancelled" | "paused";
type RecordStatus =
  "pending" | "reading" | "processing" | "processed" | "quarantined" | "failed" | "skipped";
type Json = Record<string, unknown>;
interface SourceRecord {
  id: string;
  content_hash?: string;
  status: RecordStatus;
  attempt: number;
  snapshot?: string;
  snapshot_sha256?: string;
  report?: string;
  preview?: string;
  error?: string;
}
export interface Job {
  id: string;
  bank_id: string;
  status: Status;
  stage: string;
  directory: string;
  mode: "bank" | "selected" | "upload";
  total: number | null;
  enumeration_complete: boolean;
  records: SourceRecord[];
  enumerated: number;
  created_at: string;
  updated_at: string;
  owner_pid: number;
  error?: string;
  source?: string;
  controller: AbortController;
}
interface Page {
  items: Array<{ id: string; bank_id: string; content_hash?: string }>;
  total: number;
  offset: number;
  limit: number;
}
interface CoreOptions {
  bank: string;
  source: string;
  output: string;
  root: string;
  signal: AbortSignal;
  maxDocuments: number;
}
export interface Dependencies {
  root: string;
  fetcher: typeof fetch;
  runCore: (options: CoreOptions) => Promise<Json>;
}
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const safeId = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function validBank(bank: unknown): bank is string {
  return (
    typeof bank === "string" &&
    bank.length > 0 &&
    bank.length <= 256 &&
    !Array.from(bank).some((c) => c.charCodeAt(0) < 32) &&
    !/(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.|https?:\/\/|(?:secret|password|token|api[_ -]?key|authorization)\s*[:=])/i.test(
      bank
    )
  );
}

async function atomicJson(file: string, value: unknown) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error("Source unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw new Error("Cancelled");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Source exceeds 64 MiB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function getJson(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<Json> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 120_000);
  if (signal.aborted) abort();
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
      method: "GET",
      headers: getDataplaneHeaders(),
    });
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBody(response, controller.signal)
      )
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
const bankUrl = (bank: string) => cleanerBankUrl(bank);

/** Verified 0.10.2 offset/limit contract. No filters/time_field: include undated documents. */
export async function enumerateBank(
  bank: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  progress?: (count: number, total: number) => Promise<void>
) {
  const records: SourceRecord[] = [];
  const ids = new Set<string>();
  let total: number | null = null;
  let offset = 0;
  while (total === null || offset < total) {
    if (signal.aborted) throw new Error("Cancelled");
    const data = (await getJson(
      fetcher,
      `${bankUrl(bank)}?limit=${PAGE_SIZE}&offset=${offset}`,
      signal
    )) as unknown as Page;
    if (
      !Array.isArray(data.items) ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.offset !== offset ||
      !Number.isSafeInteger(data.limit) ||
      data.limit < 1 ||
      data.items.length > data.limit
    )
      throw new Error("Enumeration contract mismatch");
    if (total !== null && total !== data.total) throw new Error("Bank changed during enumeration");
    total = data.total;
    if (offset + data.items.length > total || (offset < total && data.items.length === 0))
      throw new Error("Enumeration incomplete");
    for (const item of data.items) {
      if (
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 4096 ||
        item.bank_id !== bank ||
        ids.has(item.id)
      )
        throw new Error("Enumeration identity mismatch");
      if (
        item.content_hash !== undefined &&
        (typeof item.content_hash !== "string" || !/^[a-f0-9]{64}$/i.test(item.content_hash))
      )
        throw new Error("Enumeration hash mismatch");
      ids.add(item.id);
      records.push({ id: item.id, content_hash: item.content_hash, status: "pending", attempt: 0 });
    }
    offset += data.items.length;
    await progress?.(offset, total);
  }
  if (records.length !== total) throw new Error("Enumeration incomplete");
  return records;
}
const inventoryFingerprint = (records: SourceRecord[]) =>
  sha(
    JSON.stringify(
      records
        .map((r) => [r.id, r.content_hash || null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    )
  );

export function jobView(job: Job) {
  const processed = job.records.filter((r) =>
    ["processed", "quarantined"].includes(r.status)
  ).length;
  const failed = job.records.filter((r) => r.status === "failed").length;
  const skipped = job.records.filter((r) => r.status === "skipped").length;
  return {
    job_id: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error,
    mode: job.mode,
    progress: {
      total: job.total,
      enumerated: job.enumerated,
      read: job.records.filter((r) => !!r.snapshot).length,
      processed,
      quarantined: job.records.filter((r) => r.status === "quarantined").length,
      failed,
      skipped,
      completed: processed,
      attempted: processed + failed + skipped,
      pending: job.total === null ? null : job.total - processed - failed - skipped,
      in_flight: job.records.filter((r) => ["reading", "processing"].includes(r.status)).length,
      remaining: job.total === null ? null : job.total - processed,
    },
    can_resume: ["cancelled", "paused", "failed"].includes(job.status),
    can_retry: job.status !== "running" && failed + skipped > 0,
    report_available: job.enumeration_complete || job.records.some((r) => !!r.report),
  };
}

async function defaultRunCore(options: CoreOptions): Promise<Json> {
  const { bank, source, output, root, signal, maxDocuments } = options;
  await new Promise<void>((resolve, reject) => {
    const args = [
      "-m",
      "cleaner",
      "preview",
      source,
      "--bank",
      bank,
      "--project",
      bank,
      "--max-documents",
      String(maxDocuments),
      "--output",
      output,
    ];
    const child = spawn(process.env.CLEANER_PYTHON || "python3", args, {
      cwd: root,
      env: { ...process.env, PYTHONPATH: root },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("Cleaner worker unavailable"));
    });
    child.on("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(new Error("Cleaner input rejected"));
    });
    if (signal.aborted) abort();
  });
  const receipt = JSON.parse(await readFile(path.join(output, "receipt.json"), "utf8"));
  if (!/^[a-f0-9]{24}$/.test(receipt.batch_id)) throw new Error("Cleaner receipt invalid");
  return JSON.parse(await readFile(path.join(output, receipt.batch_id, "report.json"), "utf8"));
}

/** Dependency injection keeps lifecycle/GET-only/boundary tests independent of live services. */
export class CleanerService {
  private jobs = new Map<string, Job>();
  private active: string | null = null;
  private workers = new Map<string, Promise<void>>();
  readonly runs: string;
  constructor(private dependencies: Dependencies) {
    this.runs = path.join(dependencies.root, "runs", "web");
  }
  private async persist(job: Job) {
    job.updated_at = new Date().toISOString();
    const saved = { ...job };
    Reflect.deleteProperty(saved, "controller");
    await atomicJson(path.join(job.directory, "job.json"), saved);
  }
  async getJob(id: string): Promise<Job | undefined> {
    if (!safeId(id)) return;
    const existing = this.jobs.get(id);
    if (existing) return existing;
    try {
      const saved = JSON.parse(await readFile(path.join(this.runs, id, "job.json"), "utf8"));
      if (saved.id !== id || !validBank(saved.bank_id)) return;
      const job: Job = {
        ...saved,
        directory: path.join(this.runs, id),
        controller: new AbortController(),
      };
      if (job.status === "running" && !alive(job.owner_pid)) {
        job.status = "paused";
        job.stage = "Interrupted; saved candidates can be resumed";
        for (const record of job.records)
          if (["reading", "processing"].includes(record.status)) record.status = "pending";
        await this.persist(job);
      }
      this.jobs.set(id, job);
      return job;
    } catch {
      return;
    }
  }
  isJobActive(id: string) {
    return this.active === id;
  }
  async latestJob(bank: string) {
    let latest: Job | undefined;
    const names = await readdir(this.runs).catch(() => []);
    for (const name of names) {
      const job = await this.getJob(name);
      if (job?.bank_id === bank && (!latest || job.created_at > latest.created_at)) latest = job;
    }
    return latest;
  }
  private async acquire(job: Job) {
    if (this.active) throw new Error("A preview is already running");
    await mkdir(this.runs, { recursive: true, mode: 0o700 });
    const lock = path.join(this.runs, ".active.json");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, job_id: job.id }), {
          mode: 0o600,
          flag: "wx",
        });
        this.active = job.id;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = JSON.parse(await readFile(lock, "utf8"));
        if (alive(prior.pid)) throw new Error("A preview is already running");
        await unlink(lock).catch(() => undefined);
      }
    }
    throw new Error("Worker lock unavailable");
  }
  private async release(job: Job) {
    if (this.active !== job.id) return;
    this.active = null;
    const lock = path.join(this.runs, ".active.json");
    try {
      const saved = JSON.parse(await readFile(lock, "utf8"));
      if (saved.job_id === job.id) await unlink(lock);
    } catch {
      /* Already released */
    }
  }
  async startJob(
    bank: string,
    input: { all?: boolean; ids?: string[]; bytes?: Uint8Array; extension?: string }
  ) {
    if (!validBank(bank)) throw new Error("Bank boundary invalid");
    if (this.active) {
      const current = this.jobs.get(this.active);
      if (input.all && current?.bank_id === bank && current.mode === "bank") return current;
      throw new Error("A preview is already running");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    const job: Job = {
      id,
      bank_id: bank,
      status: "running",
      stage: input.all ? "Enumerating every bank document" : "Reading immutable source copies",
      directory: path.join(this.runs, id),
      mode: input.all ? "bank" : input.ids ? "selected" : "upload",
      total: input.ids?.length ?? null,
      enumeration_complete: !!input.ids,
      records: (input.ids || []).map((documentId) => ({
        id: documentId,
        status: "pending",
        attempt: 0,
      })),
      enumerated: input.ids?.length || 0,
      created_at: now,
      updated_at: now,
      owner_pid: process.pid,
      controller: new AbortController(),
    };
    await this.acquire(job);
    try {
      await mkdir(job.directory, { recursive: true, mode: 0o700 });
      if (input.bytes) {
        if (
          input.bytes.length > MAX_BYTES ||
          ![".json", ".md", ".txt", ".zip"].includes(input.extension || "")
        )
          throw new Error("Invalid source size or format");
        job.source = `source${input.extension}`;
        await writeFile(path.join(job.directory, job.source), input.bytes, {
          mode: 0o600,
          flag: "wx",
        });
      }
      this.jobs.set(id, job);
      await this.persist(job);
    } catch (error) {
      await this.release(job);
      throw error;
    }
    this.launch(job);
    return job;
  }
  async resumeJob(id: string, bank: string, retry = false) {
    const job = await this.getJob(id);
    if (!job || job.bank_id !== bank || job.status === "running")
      throw new Error("Saved job boundary or state mismatch");
    if (!retry && !["cancelled", "paused", "failed"].includes(job.status))
      throw new Error("Job is not resumable");
    await this.acquire(job);
    try {
      job.controller = new AbortController();
      job.status = "running";
      job.owner_pid = process.pid;
      job.error = undefined;
      for (const record of job.records)
        if (
          ["reading", "processing"].includes(record.status) ||
          (retry && ["failed", "skipped"].includes(record.status))
        )
          record.status = "pending";
      job.stage = "Resuming saved bank snapshot; completed candidates retained";
      await this.persist(job);
      this.launch(job);
      return job;
    } catch {
      job.status = "paused";
      job.stage = "Resume checkpoint unavailable; preserved candidates can be retried";
      job.error = "Local checkpoint unavailable; no worker was started";
      await this.release(job);
      await this.persist(job).catch(() => undefined);
      throw new Error("Resume checkpoint unavailable");
    }
  }
  async cancelJob(id: string) {
    const job = await this.getJob(id);
    if (!job || job.status !== "running" || this.active !== job.id) return false;
    job.status = "cancelled";
    job.stage = "Cancelled; saved progress and originals retained";
    job.controller.abort();
    try {
      await this.persist(job);
    } finally {
      await this.workers.get(id);
    }
    return true;
  }
  private launch(job: Job) {
    const promise = this.execute(job).catch(() => {
      job.status = "failed";
      job.error = "Local checkpoint unavailable; preserved files require review";
    });
    this.workers.set(job.id, promise);
    void promise.finally(() => this.workers.delete(job.id));
  }
  private async enumerate(job: Job) {
    const records = await enumerateBank(
      job.bank_id,
      this.dependencies.fetcher,
      job.controller.signal,
      async (count, total) => {
        job.enumerated = count;
        job.total = total;
        job.stage = `Enumerated ${count} of ${total} bank documents`;
        await this.persist(job);
      }
    );
    job.stage = "Verifying bank inventory remained stable";
    await this.persist(job);
    const verify = await enumerateBank(
      job.bank_id,
      this.dependencies.fetcher,
      job.controller.signal
    );
    if (inventoryFingerprint(records) !== inventoryFingerprint(verify))
      throw new Error("Bank changed during enumeration");
    job.records = records;
    job.enumerated = records.length;
    job.total = records.length;
    job.enumeration_complete = true;
    await this.persist(job);
  }
  private async processRecord(job: Job, record: SourceRecord, index: number) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    job.controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 120_000);
    record.attempt += 1;
    const folder = `document-${String(index).padStart(5, "0")}/attempt-${record.attempt}`;
    const attemptDirectory = path.join(job.directory, folder);
    await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
    try {
      if (job.controller.signal.aborted) throw new Error("Cancelled");
      if (!record.snapshot) {
        record.status = "reading";
        job.stage = `Reading document ${index + 1} of ${job.total}`;
        await this.persist(job);
        const doc = await getJson(
          this.dependencies.fetcher,
          `${bankUrl(job.bank_id)}/${encodeURIComponent(record.id)}`,
          controller.signal
        );
        if (
          doc.id !== record.id ||
          doc.bank_id !== job.bank_id ||
          typeof doc.original_text !== "string"
        )
          throw new Error("Source identity mismatch");
        if (record.content_hash && sha(doc.original_text) !== record.content_hash)
          throw new Error("Source changed since bank inventory; start a new bank job");
        const bytes = Buffer.from(
          JSON.stringify([
            {
              id: record.id,
              bank_id: job.bank_id,
              project_id: job.bank_id,
              original_text: doc.original_text,
              metadata: {
                created_at: doc.created_at,
                updated_at: doc.updated_at,
                tags: doc.tags,
                source_metadata: doc.document_metadata ?? doc.metadata,
                source_retain_params: doc.retain_params,
                currentness: "unverified",
              },
            },
          ])
        );
        if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 64 MiB limit");
        const snapshot = folder + "/source.json";
        const temporary = path.join(attemptDirectory, "source.json.tmp");
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        await rename(temporary, path.join(job.directory, snapshot));
        record.snapshot = snapshot;
        record.snapshot_sha256 = sha(bytes);
        await this.persist(job);
      } else {
        const bytes = await readFile(path.join(job.directory, record.snapshot));
        if (bytes.length > MAX_BYTES || sha(bytes) !== record.snapshot_sha256)
          throw new Error("Saved source snapshot integrity mismatch");
      }
      record.status = "processing";
      job.stage = `Cleaning document ${index + 1} of ${job.total}; candidates only`;
      await this.persist(job);
      const report = await this.dependencies.runCore({
        bank: job.bank_id,
        source: path.join(job.directory, record.snapshot),
        output: path.join(attemptDirectory, "candidates"),
        root: this.dependencies.root,
        signal: controller.signal,
        maxDocuments: 1,
      });
      const docs = report.documents as Json[];
      if (
        report.status !== "completed" ||
        !Array.isArray(docs) ||
        docs.length !== 1 ||
        !["candidate", "quarantined"].includes(String(docs[0].status))
      )
        throw new Error("Cleaner output invalid");
      if (controller.signal.aborted) throw new Error("Cancelled");
      record.report = folder + "/report.json";
      record.preview = folder + "/preview.json";
      await writeFile(path.join(job.directory, record.report), JSON.stringify(report), {
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(
        path.join(job.directory, record.preview),
        JSON.stringify(previewReport(report)),
        { mode: 0o600, flag: "wx" }
      );
      record.status = docs[0].status === "quarantined" ? "quarantined" : "processed";
      record.error = undefined;
    } catch (error) {
      if (job.controller.signal.aborted) record.status = "pending";
      else {
        const message = error instanceof Error ? error.message : "";
        record.status = message === "Source exceeds 64 MiB limit" ? "skipped" : "failed";
        record.error =
          message === "Source exceeds 64 MiB limit"
            ? message
            : controller.signal.aborted
              ? "Document exceeded the 120 second limit"
              : message.startsWith("Source changed")
                ? "Source changed since inventory; start a new bank job"
                : "Document read or validation failed; snapshot retained when available";
      }
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", cancel);
      await this.persist(job);
    }
  }
  private async executeUpload(job: Job) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    job.controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const report = await this.dependencies.runCore({
        bank: job.bank_id,
        source: path.join(job.directory, job.source!),
        output: path.join(job.directory, "upload-candidates", randomUUID()),
        root: this.dependencies.root,
        signal: controller.signal,
        maxDocuments: 25,
      });
      if (report.status !== "completed" || !Array.isArray(report.documents))
        throw new Error("Cleaner output invalid");
      if (job.controller.signal.aborted) return;
      await atomicJson(path.join(job.directory, "upload-report.json"), report);
      job.total = report.documents.length;
      job.enumerated = job.total!;
      job.enumeration_complete = true;
      job.records = (report.documents as Json[]).map((d, index) => ({
        id: `upload-${index}`,
        status: d.status === "quarantined" ? "quarantined" : "processed",
        attempt: 1,
      }));
      job.status = "completed";
      job.stage = "Upload candidates ready for review; no live changes";
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", cancel);
    }
  }
  private async execute(job: Job) {
    try {
      if (job.mode === "upload") await this.executeUpload(job);
      else {
        if (!job.enumeration_complete) await this.enumerate(job);
        for (let index = 0; index < job.records.length; index++) {
          if (job.controller.signal.aborted) break;
          const record = job.records[index];
          if (record.status !== "pending") continue;
          await this.processRecord(job, record, index);
        }
        if (job.status === "running") {
          const errors = job.records.some((r) => ["failed", "skipped"].includes(r.status));
          job.status = errors ? "partial" : "completed";
          job.stage = errors
            ? "Bank preview finished with failures/skips; review every outcome and retry"
            : "Every snapshot document processed; review candidates and quarantines";
        }
      }
    } catch {
      if (job.status === "running") {
        job.status = "failed";
        job.error =
          "Bank enumeration or input validation failed. Saved candidates and originals are retained.";
        job.stage = "Failed; resume the saved job or start a new bank snapshot";
      }
    } finally {
      try {
        await this.persist(job);
      } finally {
        await this.release(job);
      }
    }
  }
  async loadReport(job: Job, full = false): Promise<Json> {
    if (job.mode === "upload") {
      const report = JSON.parse(
        await readFile(path.join(job.directory, "upload-report.json"), "utf8")
      );
      return full ? report : previewReport(report);
    }
    const documents: Json[] = [];
    const sections = new Map<string, Json[]>();
    const duplicates = new Map<string, Json[]>();
    for (let index = 0; index < job.records.length; index++) {
      const record = job.records[index];
      if (record.report && record.preview && ["processed", "quarantined"].includes(record.status)) {
        const report = JSON.parse(
          await readFile(path.join(job.directory, full ? record.report : record.preview), "utf8")
        );
        const document = report.documents[0] as Json;
        const ref = { bank_id: document.bank_id, project_id: document.project_id, id: document.id };
        const hash = String(document.raw_sha256);
        duplicates.set(hash, [...(duplicates.get(hash) || []), ref]);
        for (const section of (document.section_inventory || []) as Json[]) {
          const h = String(section.sha256);
          sections.set(h, [
            ...(sections.get(h) || []),
            { ...ref, start: section.start, end: section.end },
          ]);
        }
        delete document.section_inventory;
        documents.push(document);
      } else
        documents.push({
          id: `document-${index + 1} (${sha(record.id).slice(0, 12)})`,
          bank_id: job.bank_id,
          project_id: job.bank_id,
          status: record.status,
          flags: [record.error || "Not processed; resume this saved snapshot"],
          segments: [],
          transformations: [],
          original_preview: "",
          candidate_preview: "",
          diff: "",
          coverage: {
            omissions: [{ reason: record.error || "Pending document; no candidate exists" }],
            semantic_rewrite: false,
          },
          source_id_sha256: sha(record.id),
        });
    }
    const view = jobView(job);
    const duplicateGroups = [...duplicates.entries()]
      .filter(([, refs]) => refs.length > 1)
      .map(([hash, refs]) => ({
        sha256: hash,
        documents: refs,
        cross_boundary: false,
        action: "report-only",
      }));
    const overlapGroups = [...sections.entries()]
      .filter(([, refs]) => refs.length > 1)
      .map(([hash, refs]) => ({
        sha256: hash,
        sources: refs,
        cross_boundary: false,
        action: "report-only",
      }));
    return {
      schema_version: 1,
      batch_id: job.id,
      status: job.status,
      bank_snapshot: {
        bank_id: job.bank_id,
        enumeration_complete: job.enumeration_complete,
        enumerated_at: job.created_at,
        inventory_sha256: inventoryFingerprint(job.records),
        contract:
          job.mode === "bank"
            ? "Hindsight 0.10.2 unfiltered limit/offset; two inventory passes"
            : "Explicit selected document IDs; individually verified reads",
        scope:
          job.mode === "bank"
            ? "All documents in the verified starting snapshot; new later documents need a new bank job"
            : "Selected documents in this bank; no bank-wide inventory requested",
      },
      documents,
      duplicates: duplicateGroups,
      overlaps: overlapGroups,
      summary: {
        documents_requested: job.total,
        documents_processed: view.progress.processed,
        documents_read: view.progress.read,
        failed: view.progress.failed,
        skipped: view.progress.skipped,
        remaining: view.progress.remaining,
        quarantined: view.progress.quarantined,
        duplicate_groups: duplicateGroups.length,
        overlap_groups: overlapGroups.length,
        segments: documents.reduce((sum, d) => sum + ((d.segments || []) as unknown[]).length, 0),
        formatting_changes: documents.reduce(
          (sum, d) => sum + ((d.transformations || []) as unknown[]).length,
          0
        ),
        raw_characters: documents.reduce((sum, d) => sum + Number(d.raw_characters || 0), 0),
      },
      policy: {
        live_apply: false,
        raw_export: false,
        cross_boundary_merge: false,
        classifications_authoritative: false,
      },
    };
  }
  async exportStream(job: Job): Promise<ReadableStream<Uint8Array>> {
    // Freeze metadata/immutable attempt paths before another tab can resume this job.
    job = { ...job, records: job.records.map((record) => ({ ...record })) };
    const summary = await this.loadReport(job, false);
    const encoder = new TextEncoder();
    // Read and emit one bounded document at a time; never combine all raw inputs or full candidates.
    let index = -1;
    let stopped = false;
    let uploadDocuments: Json[] | undefined;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (stopped) return;
          try {
            if (index === -1) {
              const header = { ...summary };
              delete header.documents;
              controller.enqueue(
                encoder.encode(
                  JSON.stringify(header).slice(0, -1) +
                    ',"export_status":"CANDIDATE_REVIEW_ONLY","live_import_enabled":false,"documents":['
                )
              );
              index = 0;
              return;
            }
            const total = (summary.documents as Json[]).length;
            if (index >= total) {
              controller.enqueue(encoder.encode("]}"));
              controller.close();
              stopped = true;
              return;
            }
            let document = (summary.documents as Json[])[index];
            if (job.mode === "upload") {
              if (!uploadDocuments)
                uploadDocuments = (await this.loadReport(job, true)).documents as Json[];
              document = uploadDocuments[index];
            } else {
              const record = job.records[index];
              if (record.report && ["processed", "quarantined"].includes(record.status)) {
                const report = JSON.parse(
                  await readFile(path.join(job.directory, record.report), "utf8")
                );
                document = report.documents[0];
                delete document.section_inventory;
              }
            }
            if (stopped) return;
            controller.enqueue(encoder.encode((index ? "," : "") + JSON.stringify(document)));
            index++;
          } catch (error) {
            stopped = true;
            controller.error(error);
          }
        },
        cancel: () => {
          stopped = true;
          uploadDocuments = undefined;
        },
      },
      { highWaterMark: 0 }
    );
  }
}

export function previewReport(report: Json): Json {
  return {
    ...report,
    documents: (report.documents as Json[]).map((doc) => ({
      ...doc,
      segments: ((doc.segments || []) as Json[]).map((segment) => {
        const provenance = { ...segment };
        delete provenance.text;
        return provenance;
      }),
    })),
  };
}
const globalLocal = globalThis as typeof globalThis & { bankCleanerService?: CleanerService };
const service = (globalLocal.bankCleanerService ||= new CleanerService({
  root: process.env.CLEANER_ROOT || path.resolve(process.cwd(), ".."),
  fetcher: fetch,
  runCore: defaultRunCore,
}));
export const startJob = service.startJob.bind(service);
export const getJob = service.getJob.bind(service);
export const latestJob = service.latestJob.bind(service);
export const cancelJob = service.cancelJob.bind(service);
export const resumeJob = service.resumeJob.bind(service);
export const loadReport = service.loadReport.bind(service);
export const exportStream = service.exportStream.bind(service);
export const isJobActive = service.isJobActive.bind(service);
