import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ImportService,
  canonical,
  hash,
  operationView,
  type AtomicGuard,
  type ImportDependencies,
} from "@/lib/cleaner-import";
import { type Job } from "@/lib/cleaner-jobs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const metadataHash = (doc: Record<string, unknown>) =>
  hash(
    canonical({
      document_metadata: doc.document_metadata ?? null,
      tags: doc.tags ?? [],
      retain_params: doc.retain_params ?? null,
    })
  );
async function fixture(count = 1, guardEnabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), "cleaner-import-test-"));
  roots.push(root);
  const directory = path.join(root, "job");
  await mkdir(directory, { mode: 0o700 });
  const sources = new Map<string, Record<string, unknown>>();
  const targets = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, Record<string, unknown>>();
  const reports = new Map<string, Record<string, unknown>>();
  const job: Job = {
    id: randomUUID(),
    bank_id: "bank",
    status: "completed",
    stage: "Ready",
    directory,
    mode: "selected",
    total: count,
    enumeration_complete: true,
    records: [],
    enumerated: count,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    owner_pid: process.pid,
    controller: new AbortController(),
  };
  for (let i = 0; i < count; i++) {
    const id = `source-${i}.md`;
    const raw = `#   Résumé 🧭\nPlease implement feature ${i}. Historical date 2020-01-02; source [citation](https://example.org).\n`;
    const source = {
      id,
      bank_id: "bank",
      original_text: raw,
      content_hash: hash(raw),
      created_at: "2026-10-07T00:00:00Z",
      updated_at: "2026-10-07T00:00:01Z",
      document_metadata: null,
      retain_params: null,
      tags: [],
      memory_unit_count: 1,
    };
    sources.set(id, source);
    const snapshot = JSON.stringify([
      {
        id,
        bank_id: "bank",
        project_id: "bank",
        original_text: raw,
        metadata: {
          created_at: source.created_at,
          updated_at: source.updated_at,
          source_metadata: source.document_metadata,
          source_retain_params: source.retain_params,
          tags: source.tags,
          currentness: "unverified",
        },
      },
    ]);
    const candidate = raw.replace("#   ", "# ");
    const report = {
      status: "completed",
      engine_version: "1.0.0",
      documents: [
        {
          id,
          bank_id: "bank",
          project_id: "bank",
          raw_sha256: hash(raw),
          status: "candidate",
          metadata: {},
          raw_characters: Array.from(raw).length,
          original_preview: raw,
          candidate_preview: candidate,
          preview_truncated: false,
          diff: "heading spacing preview",
          diff_truncated: false,
          transformations: [{ start: 0, end: 16, transform: "heading-spacing" }],
          segments: [
            {
              id: "segment",
              start: 0,
              end: Array.from(raw).length,
              sha256: hash(raw),
              text: candidate,
            },
          ],
          coverage: {
            source_characters_mapped: Array.from(raw).length,
            dates_total: 1,
            dates_preserved: 1,
            citation_occurrences_total: 1,
            citation_occurrences_preserved: 1,
            omissions: [],
            semantic_rewrite: false,
          },
        },
      ],
    };
    await writeFile(path.join(directory, `source-${i}.json`), snapshot, { mode: 0o600 });
    await writeFile(path.join(directory, `report-${i}.json`), JSON.stringify(report), {
      mode: 0o600,
    });
    reports.set(path.join(directory, `source-${i}.json`), report);
    job.records.push({
      id,
      status: "processed",
      attempt: 1,
      snapshot: `source-${i}.json`,
      snapshot_sha256: hash(snapshot),
      report: `report-${i}.json`,
    });
  }
  const config = {
    retain_extraction_mode: "chunks",
    enable_observations: false,
    retain_default_strategy: null,
    retain_chunk_size: 3000,
  };
  const gets: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("error");
    const url = String(input);
    gets.push(url);
    if (url.endsWith("/version")) return json({ api_version: "0.10.2" });
    if (url.endsWith("/config")) return json({ bank_id: "bank", config });
    if (url.includes("/documents/")) {
      const id = decodeURIComponent(url.split("/documents/")[1]);
      const value = sources.get(id) || targets.get(id);
      return value ? json(value) : json({}, 404);
    }
    if (url.includes("/operations/")) {
      const id = url.split("/operations/")[1];
      return operations.has(id) ? json(operations.get(id)) : json({}, 404);
    }
    throw new Error("unexpected read");
  }) as unknown as typeof fetch;
  const guard: AtomicGuard = {
    capabilities: vi.fn(async () => ({
      atomic_create: true,
      atomic_source_check: true,
      conditional_delete: false,
      contract_id: "synthetic-atomic-v1",
    })),
    create: vi.fn(async ({ condition, payload_json }) => {
      const payload = JSON.parse(payload_json);
      expect(hash(payload_json)).toBe(condition.payload_sha256);
      // Model the required atomic transaction: source predicates + target nonexistence together.
      const source = sources.get(condition.source_id)!;
      if (
        hash(String(source.original_text)) !== condition.source_sha256 ||
        source.updated_at !== condition.source_updated_at ||
        metadataHash(source) !== condition.source_metadata_sha256
      )
        throw new Error("atomic source conflict");
      if (targets.has(condition.target_id)) throw new Error("atomic target conflict");
      const item = (payload.items as Array<Record<string, unknown>>)[0];
      expect(payload.async).toBe(true);
      expect(item.timestamp).toBe("unset");
      expect(item.document_id).not.toBe(condition.source_id);
      targets.set(condition.target_id, {
        id: condition.target_id,
        bank_id: "bank",
        original_text: item.content,
        content_hash: hash(String(item.content)),
        document_metadata: item.metadata,
        tags: item.tags,
        retain_params: null,
        created_at: "2026-10-07T01:00:00Z",
        updated_at: "2026-10-07T01:00:00Z",
        memory_unit_count: 1,
      });
      operations.set(condition.operation_id, {
        operation_id: condition.operation_id,
        status: "completed",
      });
      return { accepted: true, operation_id: condition.operation_id };
    }),
  };
  const deps: ImportDependencies = {
    root,
    fetcher,
    getJob: async (id) => (id === job.id ? job : undefined),
    jobActive: () => false,
    verify: vi.fn(async (_job, snapshot) => structuredClone(reports.get(snapshot)!)),
    guard: guardEnabled ? guard : undefined,
    pollMilliseconds: 0,
    pollAttempts: 1,
  };
  const service = new ImportService(deps);
  return { root, job, sources, targets, operations, reports, config, guard, deps, service, gets };
}
const approval = (plan: Record<string, unknown>) => ({
  bank_confirmation: String(plan.bank_id),
  plan_hash: String(plan.plan_hash),
  confirmation_token: String(plan.confirmation_token),
  acknowledged: true,
});
async function finish(service: ImportService, id: string) {
  await vi.waitFor(async () => expect((await service.get(id))?.status).not.toBe("running"), {
    timeout: 5000,
    interval: 10,
  });
}

function enableRollback(f: Awaited<ReturnType<typeof fixture>>) {
  const tombstones = new Map<
    string,
    {
      rollback_operation_id: string;
      rollback_payload_sha256: string;
      status: string;
      deleted: boolean;
    }
  >();
  f.guard.capabilities = async () => ({
    atomic_create: true,
    atomic_source_check: true,
    conditional_delete: true,
    contract_id: "synthetic-atomic-v1",
  });
  f.guard.operation = async (condition) => {
    const target = f.targets.get(condition.target_id)!;
    return {
      operation_id: condition.operation_id,
      status: String(f.operations.get(condition.operation_id)?.status || "missing"),
      payload_sha256: condition.payload_sha256,
      created: true,
      target_id: condition.target_id,
      owner_key: condition.owner_key,
      target_sha256: condition.target_sha256,
      metadata_sha256: target ? metadataHash(target) : "",
      graph_sha256: hash("synthetic-graph"),
      updated_at: String(target?.updated_at),
      rollback_operation_id: null,
      rollback_payload_sha256: null,
      created_receipt_sha256: null,
    };
  };
  f.guard.remove = vi.fn(async (command) => {
    const target = f.targets.get(command.condition.target_id);
    if (
      !target ||
      metadataHash(target) !== command.expected_document_metadata_sha256 ||
      target.updated_at !== command.expected_updated_at ||
      hash(String(target.original_text)) !== command.condition.target_sha256
    )
      throw new Error("atomic delete conflict");
    f.targets.delete(command.condition.target_id);
    tombstones.set(command.rollback_operation_id, {
      rollback_operation_id: command.rollback_operation_id,
      rollback_payload_sha256: command.rollback_payload_sha256,
      status: "completed",
      deleted: true,
    });
    return { deleted: true, rollback_operation_id: command.rollback_operation_id };
  });
  f.guard.rollbackOperation = async (command) =>
    tombstones.get(command.rollback_operation_id) || {
      rollback_operation_id: command.rollback_operation_id,
      rollback_payload_sha256: command.rollback_payload_sha256,
      status: "pending",
      deleted: false,
    };
  return tombstones;
}
describe("guarded additive import plans", () => {
  it("prepares backups, confirms additive versions and reuses exact targets on another plan", async () => {
    const f = await fixture(2);
    const originals = canonical([...f.sources.values()]);
    const plan = await f.service.prepare(f.job.id, "bank", [0, 1]);
    expect(plan.status).toBe("prepared");
    expect(plan.eligible).toHaveLength(2);
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    const state = (await f.service.get(plan.plan_id))!;
    expect(operationView(state).progress).toMatchObject({ imported: 2, reused: 0, remaining: 0 });
    expect(canonical([...f.sources.values()])).toBe(originals);
    const next = await f.service.prepare(f.job.id, "bank", [0, 1]);
    expect(next.eligible.map((i) => i.candidate_id)).toEqual(
      plan.eligible.map((i) => i.candidate_id)
    );
    await f.service.confirm(next.plan_id, approval(next));
    await finish(f.service, next.plan_id);
    expect(operationView((await f.service.get(next.plan_id))!).progress.reused).toBe(2);
    expect(f.guard.create).toHaveBeenCalledTimes(2);
  });
  it("fails closed without atomic capabilities and never sends an ordinary retain request", async () => {
    const f = await fixture(1, false);
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.reason).toContain("atomic");
    await expect(f.service.confirm(plan.plan_id, approval(plan))).rejects.toThrow("guard");
    expect(f.guard.create).not.toHaveBeenCalled();
    expect(f.gets.every((url) => !url.endsWith("/memories"))).toBe(true);
  });
  it("rejects cross-bank plans, quarantine, omissions, pending and duplicate selection", async () => {
    const f = await fixture();
    await expect(f.service.prepare(f.job.id, "other", [0])).rejects.toThrow("preview");
    await expect(f.service.prepare(f.job.id, "bank", [0, 0])).rejects.toThrow("explicit");
    f.job.records[0].status = "quarantined";
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.rejected).toHaveLength(1);
    expect(f.guard.create).not.toHaveBeenCalled();
  });
  it("rejects mutated candidate evidence even when its stored report claims complete coverage", async () => {
    const f = await fixture();
    const file = path.join(f.job.directory, f.job.records[0].report!);
    const report = JSON.parse(await readFile(file, "utf8"));
    report.documents[0].segments[0].text = "Completed feature (fabricated)";
    await writeFile(file, JSON.stringify(report));
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.rejected[0].reason).toContain("deterministic");
  });
  it("binds typed bank, nonce, plan hash and immutable backup integrity", async () => {
    const f = await fixture();
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    for (const bad of [
      { bank_confirmation: "other" },
      { plan_hash: "a".repeat(64) },
      { confirmation_token: "wrong" },
      { acknowledged: false },
    ])
      await expect(f.service.confirm(plan.plan_id, { ...approval(plan), ...bad })).rejects.toThrow(
        "Confirmation"
      );
    const state = (await f.service.get(plan.plan_id))!;
    await writeFile(path.join(state.directory, state.items[0].payload), "{}");
    await expect(f.service.confirm(plan.plan_id, approval(plan))).rejects.toThrow("integrity");
    expect(f.guard.create).not.toHaveBeenCalled();
  });
  it("rejects changed source raw text, updated_at and metadata before dispatch", async () => {
    for (const mutation of [
      (s: Record<string, unknown>) => {
        s.original_text = "changed";
      },
      (s: Record<string, unknown>) => {
        s.updated_at = "later";
      },
      (s: Record<string, unknown>) => {
        s.document_metadata = { context: "changed" };
      },
    ]) {
      const f = await fixture();
      const plan = await f.service.prepare(f.job.id, "bank", [0]);
      mutation(f.sources.get("source-0.md")!);
      await f.service.confirm(plan.plan_id, approval(plan));
      await finish(f.service, plan.plan_id);
      expect(f.guard.create).not.toHaveBeenCalled();
      expect(operationView((await f.service.get(plan.plan_id))!).progress.blocked).toBe(1);
    }
  });
  it("rejects untracked legacy metadata-only secrets and tag changes with a fresh-preview instruction", async () => {
    const f = await fixture();
    f.sources.get("source-0.md")!.document_metadata = { password: "SYNTHETIC_SECRET_NOT_REAL" };
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.rejected[0].reason).toContain("fresh preview");
    expect(JSON.stringify(plan)).not.toContain("SYNTHETIC_SECRET_NOT_REAL");
  });
  it("requires the existing chunks/no-observations config and never mutates settings", async () => {
    const f = await fixture();
    f.config.enable_observations = true;
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.reason).toContain("observations");
    expect(f.guard.create).not.toHaveBeenCalled();
  });
  it("atomic guard rejects a raced existing target without any replacement", async () => {
    const f = await fixture();
    const create = f.guard.create;
    f.guard.create = vi.fn(async (command, signal) => {
      f.targets.set(command.condition.target_id, {
        id: command.condition.target_id,
        original_text: "preexisting external content",
      });
      return create(command, signal);
    });
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    expect([...f.targets.values()][0].original_text).toBe("preexisting external content");
    expect((await f.service.get(plan.plan_id))?.status).toBe("uncertain");
  });
  it("recovers transient read quota failure only after explicit resume with the same plan/IDs", async () => {
    const f = await fixture(2);
    const plan = await f.service.prepare(f.job.id, "bank", [0, 1]);
    let quota = true;
    const fetcher = f.deps.fetcher;
    f.deps.fetcher = (async (...args: Parameters<typeof fetch>) =>
      quota && String(args[0]).endsWith("/documents/source-0.md")
        ? json({}, 429)
        : fetcher(...args)) as typeof fetch;
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    const state = (await f.service.get(plan.plan_id))!;
    expect(state.status).toBe("partial");
    expect(state.items[0].status).toBe("retryable");
    expect(state.items[1].status).toBe("planned");
    expect(f.guard.create).not.toHaveBeenCalled();
    const ids = state.items.map((i) => i.operation_id);
    quota = false;
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    expect(state.status).toBe("completed");
    expect(state.items.map((i) => i.operation_id)).toEqual(ids);
    expect(f.guard.create).toHaveBeenCalledTimes(2);
  });
  it("lost acknowledgement stops later dispatch; reconciliation never invents a new UUID", async () => {
    const f = await fixture(2);
    const create = f.guard.create;
    f.guard.create = vi.fn(async (command, signal) => {
      await create(command, signal);
      throw new Error("lost acknowledgement");
    });
    const plan = await f.service.prepare(f.job.id, "bank", [0, 1]);
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    expect(f.guard.create).toHaveBeenCalledTimes(1);
    const state = (await f.service.get(plan.plan_id))!;
    expect(state.status).toBe("uncertain");
    expect(state.items[1].status).toBe("planned");
    const uuid = state.items[0].operation_id;
    await f.service.confirm(plan.plan_id, approval(plan), true);
    await finish(f.service, plan.plan_id);
    expect(state.items[0].operation_id).toBe(uuid);
    expect(f.guard.create).toHaveBeenCalledTimes(1);
    expect(state.items[0].created).toBe(false);
  });
  it("does not count a target as imported before its operation completes", async () => {
    const f = await fixture();
    const create = f.guard.create;
    f.guard.create = async (command, signal) => {
      const result = await create(command, signal);
      f.operations.get(command.condition.operation_id)!.status = "processing";
      return result;
    };
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    expect(operationView((await f.service.get(plan.plan_id))!).progress).toMatchObject({
      imported: 0,
      uncertain: 1,
      remaining: 1,
    });
  });
  it("permits read-only reconciliation after confirmation expiry and write capability/config withdrawal", async () => {
    const f = await fixture();
    const create = f.guard.create;
    f.guard.create = vi.fn(async (command, signal) => {
      await create(command, signal);
      throw new Error("lost acknowledgement");
    });
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(plan.plan_id, approval(plan));
    await finish(f.service, plan.plan_id);
    f.deps.guard = undefined;
    f.config.enable_observations = true;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60 * 60_000);
    try {
      await expect(f.service.confirm(plan.plan_id, approval(plan))).rejects.toThrow("expiry");
      await f.service.confirm(plan.plan_id, approval(plan), true);
      await finish(f.service, plan.plan_id);
      expect((await f.service.get(plan.plan_id))?.status).toBe("completed");
      expect(f.guard.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("restores durable plans after service reload and blocks rollback without CAS", async () => {
    const f = await fixture();
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    const service = new ImportService(f.deps);
    const saved = await service.get(plan.plan_id);
    expect(saved?.plan_hash).toBe(plan.plan_hash);
    await service.confirm(plan.plan_id, approval(plan));
    await finish(service, plan.plan_id);
    const rollback = await service.rollbackPlan(plan.plan_id, "bank");
    expect(rollback.available).toBe(false);
    expect(rollback.status).toBe("blocked");
    await expect(service.rollbackPlan(plan.plan_id, "other")).rejects.toThrow("boundary");
    expect(f.targets.size).toBe(1);
  });
  it("excludes already-owned cleaner sources so repeated bank cleaning cannot recurse", async () => {
    const f = await fixture();
    f.job.records[0].id = "cleaner-v1-" + "a".repeat(48);
    const plan = await f.service.prepare(f.job.id, "bank", [0]);
    expect(plan.status).toBe("blocked");
    expect(plan.rejected[0].reason).toContain("already a cleaner");
    expect(f.guard.create).not.toHaveBeenCalled();
  });
  it("cancel stops only local dispatch and retains accepted API operation for reconciliation", async () => {
    const f = await fixture(2);
    f.guard.create = vi.fn(async (command, signal) => {
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      );
      return { accepted: true, operation_id: command.condition.operation_id };
    });
    const plan = await f.service.prepare(f.job.id, "bank", [0, 1]);
    await f.service.confirm(plan.plan_id, approval(plan));
    await vi.waitFor(() => expect(f.guard.create).toHaveBeenCalledTimes(1));
    await f.service.cancel(plan.plan_id);
    const state = (await f.service.get(plan.plan_id))!;
    expect(state.status).toBe("cancelled");
    expect(state.items[0].status).toBe("uncertain");
    expect(state.items[1].status).toBe("planned");
    await expect(access(path.join(f.service.directory, ".active.json"))).rejects.toThrow();
  });
  it("requires a separate rollback approval and conditionally deletes only verified created candidates", async () => {
    const f = await fixture(2);
    enableRollback(f);
    const raw = canonical([...f.sources]);
    const p = await f.service.prepare(f.job.id, "bank", [0, 1]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    const r = await f.service.rollbackPlan(p.plan_id, "bank");
    expect(r.mode).toBe("rollback");
    expect(r.plan_id).not.toBe(p.plan_id);
    expect(r.status).toBe("prepared");
    expect(f.guard.remove).not.toHaveBeenCalled();
    await expect(f.service.confirm(r.plan_id, approval(p))).rejects.toThrow("Confirmation");
    await f.service.confirm(r.plan_id, approval(r));
    await finish(f.service, r.plan_id);
    expect(
      (await f.service.get(r.plan_id))?.items.every((item) => item.status === "rolled_back")
    ).toBe(true);
    expect(f.targets.size).toBe(0);
    expect(canonical([...f.sources])).toBe(raw);
    expect(f.guard.remove).toHaveBeenCalledTimes(2);
  });
  it("excludes reused targets from rollback and refuses changed ownership/version atomically", async () => {
    const f = await fixture();
    enableRollback(f);
    const p = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    const reuse = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(reuse.plan_id, approval(reuse));
    await finish(f.service, reuse.plan_id);
    expect((await f.service.rollbackPlan(reuse.plan_id, "bank")).status).toBe("blocked");
    const r = await f.service.rollbackPlan(p.plan_id, "bank");
    const remove = f.guard.remove!;
    f.guard.remove = vi.fn(async (command, signal) => {
      f.targets.get(command.condition.target_id)!.updated_at = "raced-version";
      return remove(command, signal);
    });
    await f.service.confirm(r.plan_id, approval(r));
    await finish(f.service, r.plan_id);
    expect(f.targets.size).toBe(1);
    expect((await f.service.get(r.plan_id))?.status).toBe("uncertain");
    expect(f.sources.size).toBe(1);
  });
  it("reconciles lost rollback acknowledgement using a durable tombstone without replay after restart", async () => {
    const f = await fixture(2);
    enableRollback(f);
    const p = await f.service.prepare(f.job.id, "bank", [0, 1]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    const r = await f.service.rollbackPlan(p.plan_id, "bank");
    const remove = f.guard.remove!;
    f.guard.remove = vi.fn(async (command, signal) => {
      await remove(command, signal);
      throw new Error("lost deletion ack");
    });
    await f.service.confirm(r.plan_id, approval(r));
    await finish(f.service, r.plan_id);
    expect(f.guard.remove).toHaveBeenCalledTimes(1);
    expect(f.targets.size).toBe(1);
    const reload = new ImportService(f.deps);
    await reload.confirm(r.plan_id, approval(r), true);
    await finish(reload, r.plan_id);
    expect((await reload.get(r.plan_id))?.items[0].status).toBe("rolled_back");
    expect((await reload.get(r.plan_id))?.items[1].status).toBe("planned");
    expect(f.guard.remove).toHaveBeenCalledTimes(1);
  });
  it("does not infer rollback success from a missing target without a tombstone and rejects mutated proof", async () => {
    const f = await fixture();
    enableRollback(f);
    const p = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    const r = await f.service.rollbackPlan(p.plan_id, "bank");
    const state = (await f.service.get(r.plan_id))!;
    await writeFile(path.join(state.directory, "receipt-0.json"), "{}");
    await expect(f.service.confirm(r.plan_id, approval(r))).rejects.toThrow("receipt integrity");
    expect(f.guard.remove).not.toHaveBeenCalled();
  });
  it("keeps rollback uncertain when target is absent but the durable tombstone is still pending", async () => {
    const f = await fixture();
    enableRollback(f);
    const p = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    const r = await f.service.rollbackPlan(p.plan_id, "bank");
    f.guard.rollbackOperation = async (command) => ({
      rollback_operation_id: command.rollback_operation_id,
      rollback_payload_sha256: command.rollback_payload_sha256,
      status: "pending",
      deleted: false,
    });
    await f.service.confirm(r.plan_id, approval(r));
    await finish(f.service, r.plan_id);
    expect(f.targets.size).toBe(0);
    expect((await f.service.get(r.plan_id))?.status).toBe("uncertain");
    expect(operationView((await f.service.get(r.plan_id))!).progress.imported).toBe(0);
    expect(f.guard.remove).toHaveBeenCalledTimes(1);
  });
  it("reuses exact candidates through cleaner receipts even when generic operations are absent", async () => {
    const f = await fixture();
    enableRollback(f);
    const p = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(p.plan_id, approval(p));
    await finish(f.service, p.plan_id);
    f.operations.clear();
    const operation = f.guard.operation!;
    f.guard.operation = async (condition, signal) => ({
      ...(await operation(condition, signal)),
      status: "completed",
    });
    const next = await f.service.prepare(f.job.id, "bank", [0]);
    await f.service.confirm(next.plan_id, approval(next));
    await finish(f.service, next.plan_id);
    expect(operationView((await f.service.get(next.plan_id))!).progress.reused).toBe(1);
    expect(f.guard.create).toHaveBeenCalledTimes(1);
    expect((await f.service.rollbackPlan(next.plan_id, "bank")).status).toBe("blocked");
  });
});
