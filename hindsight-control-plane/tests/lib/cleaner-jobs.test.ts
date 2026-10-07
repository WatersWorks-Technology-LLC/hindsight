import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CleanerService,
  enumerateBank,
  jobView,
  type Dependencies,
  type Job,
} from "@/lib/cleaner-jobs";

const roots: string[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const docs = (count: number) =>
  Array.from({ length: count }, (_, n) => ({
    id: n === 0 ? "folder/document#one.md" : `document-${n}`,
    bank_id: "bank",
    original_text:
      "# Source\n" +
      "shared citation https://example.org on 2020-01-02. ".repeat(3) +
      `\n# Unique\n${n}\n`,
  }));
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(count = 61, extra?: Partial<Dependencies>) {
  const root = await mkdtemp(path.join(tmpdir(), "cleaner-bank-test-"));
  roots.push(root);
  const documents = docs(count);
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(options?.method).toBe("GET");
    expect(options?.redirect).toBe("error");
    const value = String(url);
    calls.push(value);
    const parsed = new URL(value);
    if (parsed.searchParams.has("offset")) {
      expect([...parsed.searchParams.keys()].sort()).toEqual(["limit", "offset"]);
      const offset = Number(parsed.searchParams.get("offset"));
      return response({
        items: documents
          .slice(offset, offset + 20)
          .map((d) => ({ id: d.id, bank_id: d.bank_id, content_hash: hash(d.original_text) })),
        total: count,
        offset,
        limit: 20,
      });
    }
    const id = decodeURIComponent(parsed.pathname.split("/documents/")[1]);
    const document = documents.find((d) => d.id === id);
    return response(document || {}, document ? 200 : 404);
  }) as unknown as typeof fetch;
  const runCore: Dependencies["runCore"] = vi.fn(async ({ source, signal }) => {
    if (signal.aborted) throw new Error("Cancelled");
    const [d] = JSON.parse(await readFile(source, "utf8"));
    const sectionEnd = d.original_text.indexOf("# Unique");
    return {
      status: "completed",
      batch_id: hash(d.original_text).slice(0, 24),
      documents: [
        {
          id: d.id,
          bank_id: d.bank_id,
          project_id: d.project_id,
          raw_sha256: hash(d.original_text),
          status: "candidate",
          flags: [],
          raw_characters: d.original_text.length,
          original_preview: d.original_text,
          candidate_preview: d.original_text,
          diff: "",
          transformations: [],
          section_inventory: [
            { sha256: hash(d.original_text.slice(0, sectionEnd)), start: 0, end: sectionEnd },
          ],
          segments: [
            { id: "segment", start: 0, end: d.original_text.length, text: d.original_text },
          ],
          coverage: { omissions: [], semantic_rewrite: false },
        },
      ],
      summary: {},
    };
  });
  const dependencies = { root, fetcher, runCore, ...extra };
  return {
    root,
    documents,
    calls,
    fetcher,
    runCore,
    dependencies,
    service: new CleanerService(dependencies),
  };
}
async function finish(job: Job) {
  await vi.waitFor(() => expect(job.status).not.toBe("running"), { timeout: 10_000, interval: 10 });
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("durable all-bank cleaner", () => {
  it("preserves the API document_metadata field in the immutable verifier input", async () => {
    const f = await fixture(1);
    const metadata = {
      source_url: "https://example.org/archive",
      classification: "instruction",
      secret: "sk-" + "A".repeat(35),
    };
    const retainParams = { timestamp: "unset", context: "Generic historical archive" };
    Object.assign(f.documents[0], {
      document_metadata: metadata,
      retain_params: retainParams,
      metadata: { legacy: "must not replace canonical metadata" },
    });
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    expect(job.status).toBe("completed");
    const [snapshot] = JSON.parse(
      await readFile(path.join(job.directory, job.records[0].snapshot!), "utf8")
    );
    expect(snapshot.metadata.source_metadata).toEqual(metadata);
    expect(snapshot.metadata.source_retain_params).toEqual(retainParams);
    expect(snapshot.metadata.currentness).toBe("unverified");
  });
  it("covers 61 documents across pages, slash IDs, exact duplicates and cross-document source overlaps", async () => {
    const f = await fixture();
    // Two different IDs share exact raw content, but candidates remain separate.
    f.documents[60].original_text = f.documents[59].original_text;
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    expect(job.status).toBe("completed");
    expect(jobView(job).progress).toMatchObject({
      total: 61,
      processed: 61,
      failed: 0,
      remaining: 0,
      enumerated: 61,
    });
    expect(f.calls.filter((u) => !u.includes("?"))).toHaveLength(61);
    expect(f.calls.some((u) => u.includes("folder%2Fdocument%23one.md"))).toBe(true);
    const report = await f.service.loadReport(job);
    expect(report.documents).toHaveLength(61);
    expect(report.duplicates).toHaveLength(1);
    expect(report.overlaps).toHaveLength(1);
    expect((report.overlaps as Array<{ sources: unknown[] }>)[0].sources).toHaveLength(61);
    expect(JSON.stringify(report)).not.toContain('"text":');
    const exported = JSON.parse(await new Response(await f.service.exportStream(job)).text());
    expect(exported.documents).toHaveLength(61);
    expect(exported.documents[0].segments[0].text).toBe(f.documents[0].original_text);
  });
  it("records individual failure as partial and retries only the failed source", async () => {
    const f = await fixture(3);
    let fail = true;
    const original = f.fetcher;
    f.dependencies.fetcher = (async (...args: Parameters<typeof fetch>) =>
      String(args[0]).endsWith("/document-1") && fail
        ? response({}, 503)
        : original(...args)) as typeof fetch;
    const service = new CleanerService(f.dependencies);
    const job = await service.startJob("bank", { all: true });
    await finish(job);
    expect(job.status).toBe("partial");
    expect(jobView(job).progress).toMatchObject({
      total: 3,
      processed: 2,
      failed: 1,
      remaining: 1,
      pending: 0,
    });
    const originalHashes = job.records.filter((r) => !!r.report).map((r) => r.snapshot_sha256);
    const report = await service.loadReport(job);
    expect(report.documents).toHaveLength(3);
    expect((report.documents as Array<{ status: string }>)[1].status).toBe("failed");
    fail = false;
    await service.resumeJob(job.id, "bank", true);
    await finish(job);
    expect(job.status).toBe("completed");
    expect(job.records.filter((r) => r.attempt === 1).map((r) => r.snapshot_sha256)).toEqual(
      originalHashes
    );
    expect(f.calls.filter((u) => !u.includes("?"))).toHaveLength(3);
    expect(job.records[1].attempt).toBe(2);
  });
  it("cancels mid-bank then resumes across a service reload without refetching committed snapshots", async () => {
    const f = await fixture(3);
    let runs = 0;
    const runner = f.runCore;
    f.dependencies.runCore = async (options) => {
      runs++;
      if (runs === 2)
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          })
        );
      return runner(options);
    };
    const service = new CleanerService(f.dependencies);
    const job = await service.startJob("bank", { all: true });
    await vi.waitFor(() => expect(jobView(job).progress.processed).toBe(1));
    await service.cancelJob(job.id);
    expect(job.status).toBe("cancelled");
    const firstHash = job.records[0].snapshot_sha256;
    const restored = new CleanerService(f.dependencies);
    const saved = await restored.getJob(job.id);
    expect(saved?.status).toBe("cancelled");
    await restored.resumeJob(job.id, "bank");
    await finish(saved!);
    expect(saved?.status).toBe("completed");
    expect(saved?.records[0].snapshot_sha256).toBe(firstHash);
    expect(f.calls.filter((u) => !u.includes("?"))).toHaveLength(3);
    expect(saved?.records[1].attempt).toBe(2);
  });
  it("recovers interrupted process as paused and rejects mismatched bank resume", async () => {
    const f = await fixture(1);
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    // Finish the real worker's checkpoint before simulating a dead owner on disk.
    await vi.waitFor(() => expect(f.service.isJobActive(job.id)).toBe(false));
    const file = path.join(job.directory, "job.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.status = "running";
    saved.owner_pid = 999999999;
    saved.records[0].status = "processing";
    await writeFile(file, JSON.stringify(saved));
    const service = new CleanerService(f.dependencies);
    const restored = await service.getJob(job.id);
    expect(restored?.status).toBe("paused");
    await expect(service.resumeJob(job.id, "other")).rejects.toThrow("boundary");
    expect((await service.latestJob("bank"))?.id).toBe(job.id);
  });
  it("repeated bank action reuses the active job and another bank cannot start concurrently", async () => {
    const f = await fixture(2);
    const runner = f.runCore;
    f.dependencies.runCore = async (options) => {
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        })
      );
      return runner(options);
    };
    const service = new CleanerService(f.dependencies);
    const first = await service.startJob("bank", { all: true });
    expect((await service.startJob("bank", { all: true })).id).toBe(first.id);
    await expect(service.startJob("other", { all: true })).rejects.toThrow("already running");
    await service.cancelJob(first.id);
    await expect(access(path.join(service.runs, ".active.json"))).rejects.toThrow();
  });
  it("fails changing/duplicate enumeration instead of silently processing incomplete inventory", async () => {
    const f = await fixture(41);
    const original = f.fetcher;
    const changed = (async (...args: Parameters<typeof fetch>) => {
      const r = await original(...args);
      const body = await r.json();
      if (new URL(String(args[0])).searchParams.get("offset") === "20") body.total++;
      return response(body);
    }) as typeof fetch;
    await expect(enumerateBank("bank", changed, new AbortController().signal)).rejects.toThrow(
      "changed"
    );
    const duplicate = (async (...args: Parameters<typeof fetch>) => {
      const r = await original(...args);
      const body = await r.json();
      if (new URL(String(args[0])).searchParams.get("offset") === "20")
        body.items[0] = { id: f.documents[0].id, bank_id: "bank" };
      return response(body);
    }) as typeof fetch;
    await expect(enumerateBank("bank", duplicate, new AbortController().signal)).rejects.toThrow(
      "identity"
    );
  });
  it("rejects same-total changed inventory on the verification pass", async () => {
    const f = await fixture(2);
    let lists = 0;
    const original = f.fetcher;
    const fetcher = (async (...args: Parameters<typeof fetch>) => {
      const r = await original(...args);
      const body = await r.json();
      if (new URL(String(args[0])).searchParams.has("offset") && ++lists === 2)
        body.items[0].content_hash = "a".repeat(64);
      return response(body);
    }) as typeof fetch;
    const service = new CleanerService({ ...f.dependencies, fetcher });
    const job = await service.startJob("bank", { all: true });
    await finish(job);
    expect(job.status).toBe("failed");
    expect(job.enumeration_complete).toBe(false);
    expect(f.calls.filter((u) => !u.includes("?"))).toHaveLength(0);
  });
  it("releases worker ownership when a resume checkpoint or terminal checkpoint fails", async () => {
    const f = await fixture(1);
    let first = true;
    const original = f.runCore;
    const service = new CleanerService({
      ...f.dependencies,
      runCore: async (options) => {
        if (first) {
          first = false;
          await new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            })
          );
        }
        return original(options);
      },
    });
    const job = await service.startJob("bank", { all: true });
    await vi.waitFor(() => expect(first).toBe(false));
    const cancelCheckpoint = vi.spyOn(
      service as unknown as { persist: (job: Job) => Promise<void> },
      "persist"
    );
    cancelCheckpoint.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(service.cancelJob(job.id)).rejects.toThrow("disk unavailable");
    await expect(access(path.join(service.runs, ".active.json"))).rejects.toThrow();
    cancelCheckpoint.mockRestore();
    const checkpoint = vi.spyOn(
      service as unknown as { persist: (job: Job) => Promise<void> },
      "persist"
    );
    checkpoint.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(service.resumeJob(job.id, "bank")).rejects.toThrow("checkpoint");
    expect(job.status).toBe("paused");
    await expect(access(path.join(service.runs, ".active.json"))).rejects.toThrow();
    checkpoint.mockRestore();
    await service.resumeJob(job.id, "bank");
    await finish(job);
    expect(job.status).toBe("completed");
    // A final checkpoint failure must also release ownership before surfacing the failure.
    const realPersist = (
      service as unknown as { persist: (job: Job) => Promise<void> }
    ).persist.bind(service);
    const terminal = vi.spyOn(
      service as unknown as { persist: (job: Job) => Promise<void> },
      "persist"
    );
    terminal.mockImplementation(async (job) => {
      if (job.status === "completed") throw new Error("disk unavailable");
      await realPersist(job);
    });
    const second = await service.startJob("bank", { all: true });
    await vi.waitFor(() => expect(second.status).toBe("failed"));
    await expect(access(path.join(service.runs, ".active.json"))).rejects.toThrow();
    terminal.mockRestore();
  });
  it("keeps full candidate reads lazy and stops after exporter cancellation", async () => {
    const f = await fixture(2);
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    const stream = await f.service.exportStream(job);
    // A missing second full result must not be read before the consumer requests it.
    await rm(path.join(job.directory, job.records[1].report!));
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false); // metadata header only
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("folder/document#one.md");
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
  });
  it("freezes export status and attempt pointers before a concurrent resume", async () => {
    const f = await fixture(1);
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    const stream = await f.service.exportStream(job);
    job.status = "running";
    job.records[0].status = "pending";
    job.records[0].report = "nonexistent-new-attempt/report.json";
    const exported = JSON.parse(await new Response(stream).text());
    expect(exported.status).toBe("completed");
    expect(exported.documents[0].status).toBe("candidate");
    expect(exported.documents[0].segments[0].text).toBe(f.documents[0].original_text);
  });
  it("records an oversized document as skipped while continuing every other source", async () => {
    const f = await fixture(2);
    const original = f.fetcher;
    const fetcher = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/document-1")) {
        let chunks = 0;
        const chunk = new Uint8Array(1024 * 1024);
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (chunks++ < 65) controller.enqueue(chunk);
              else controller.close();
            },
          })
        );
      }
      return original(...args);
    }) as typeof fetch;
    const service = new CleanerService({ ...f.dependencies, fetcher });
    const job = await service.startJob("bank", { all: true });
    await finish(job);
    expect(job.status).toBe("partial");
    expect(jobView(job).progress).toMatchObject({
      total: 2,
      processed: 1,
      skipped: 1,
      remaining: 1,
    });
    expect(job.records[1].snapshot).toBeUndefined();
    const report = await service.loadReport(job);
    expect(report.documents).toHaveLength(2);
  });
  it("bounds slow enumeration pages and each document without a whole-bank deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = await fixture(1);
      let invoked = false;
      const fetcher = (async (_url: string | URL | Request, options?: RequestInit) => {
        invoked = true;
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          })
        );
        return response({});
      }) as typeof fetch;
      const promise = enumerateBank("bank", fetcher, new AbortController().signal);
      const rejected = expect(promise).rejects.toThrow("aborted");
      expect(invoked).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      let processing = false;
      const service = new CleanerService({
        ...f.dependencies,
        runCore: async (options) => {
          processing = true;
          await new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () => reject(new Error("timeout")), {
              once: true,
            })
          );
          return {};
        },
      });
      const job = await service.startJob("bank", { all: true });
      await vi.waitFor(() => expect(processing).toBe(true));
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(job.status).toBe("partial"));
      expect(jobView(job).progress).toMatchObject({ processed: 0, failed: 1, remaining: 1 });
      expect(job.records[0].error).toContain("120 second");
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports empty bank truthfully and never exposes raw current IDs in progress", async () => {
    const f = await fixture(0);
    const job = await f.service.startJob("bank", { all: true });
    await finish(job);
    expect(jobView(job).progress.total).toBe(0);
    expect(job.status).toBe("completed");
    expect((await f.service.loadReport(job)).documents).toEqual([]);
    expect(JSON.stringify(jobView(job))).not.toContain("folder/document");
  });
});
