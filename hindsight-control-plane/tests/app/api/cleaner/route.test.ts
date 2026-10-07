import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  startJob: vi.fn(),
  getJob: vi.fn(),
  latestJob: vi.fn(),
  resumeJob: vi.fn(),
  cancelJob: vi.fn(),
  loadReport: vi.fn(),
  exportStream: vi.fn(),
  isJobActive: vi.fn(),
}));

vi.mock("@/lib/cleaner-jobs", () => ({
  // A small cap exercises actual streamed-byte enforcement without allocating
  // a 65 MiB fixture. The endpoint's production cap remains 64 MiB.
  MAX_BYTES: 1024,
  ...worker,
  validBank: (bank: unknown) => typeof bank === "string" && bank.length > 0,
  jobView: (job: unknown) => job,
  previewReport: (report: unknown) => report,
}));

import { DELETE, GET, POST } from "@/app/api/cleaner/route";

function request(url = "http://localhost/api/cleaner", init: RequestInit = {}): NextRequest {
  return Object.assign(new Request(url, init), { nextUrl: new URL(url) }) as unknown as NextRequest;
}

const completed = {
  id: "job",
  job_id: "job",
  bank_id: "bank",
  status: "completed",
  enumeration_complete: true,
  report_available: true,
};
const report = { status: "completed", documents: [], policy: { live_apply: false } };

describe("local cleaner request and review boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    worker.getJob.mockResolvedValue(completed);
    worker.latestJob.mockResolvedValue(undefined);
    worker.loadReport.mockResolvedValue(report);
    worker.startJob.mockResolvedValue({ job_id: "job", status: "running" });
    worker.cancelJob.mockResolvedValue(true);
    worker.isJobActive.mockReturnValue(false);
    worker.exportStream.mockImplementation(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  ...report,
                  export_status: "CANDIDATE_REVIEW_ONLY",
                  live_import_enabled: false,
                })
              )
            );
            controller.close();
          },
        })
    );
  });

  it("rejects cross-origin and non-loopback requests before accessing source jobs", async () => {
    expect(
      (
        await POST(
          request(undefined, {
            method: "POST",
            headers: { origin: "https://other.example" },
            body: "{}",
          })
        )
      ).status
    ).toBe(403);
    expect((await GET(request("http://remote.example/api/cleaner?job=job"))).status).toBe(403);
    expect(worker.startJob).not.toHaveBeenCalled();
    expect(worker.getJob).not.toHaveBeenCalled();
  });

  it("bounds actual bytes even when Content-Length underreports the body", async () => {
    const response = await POST(
      request(undefined, {
        method: "POST",
        headers: { "content-length": "1" },
        body: "x".repeat(10000),
      })
    );
    expect(response.ok).toBe(false);
    expect(worker.startJob).not.toHaveBeenCalled();
  });

  it("requires explicit scope and limits live selected documents to 25", async () => {
    for (const body of [
      { document_ids: ["one"] },
      { bank_id: "bank", document_ids: Array.from({ length: 26 }, (_, i) => `doc-${i}`) },
    ]) {
      expect(
        (await POST(request(undefined, { method: "POST", body: JSON.stringify(body) }))).status
      ).toBe(400);
    }
    expect(worker.startJob).not.toHaveBeenCalled();
  });

  it("retains slash-bearing document identities and explicit bank scope", async () => {
    const response = await POST(
      request(undefined, {
        method: "POST",
        body: JSON.stringify({
          bank_id: "project/bank",
          document_ids: ["source/one.md", "source/one.md"],
        }),
      })
    );
    expect(response.status).toBe(202);
    expect(worker.startJob).toHaveBeenCalledWith("project/bank", { ids: ["source/one.md"] });
  });

  it("refuses candidate export without per-batch review acknowledgement", async () => {
    const response = await GET(request("http://localhost/api/cleaner?job=job&export=1"));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it("exports a marked candidate with live import disabled after review", async () => {
    const response = await GET(request("http://localhost/api/cleaner?job=job&export=1&reviewed=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      export_status: "CANDIDATE_REVIEW_ONLY",
      live_import_enabled: false,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns missing-job errors and cancels only the requested local job", async () => {
    worker.getJob.mockResolvedValueOnce(undefined);
    expect((await GET(request("http://localhost/api/cleaner?job=missing"))).status).toBe(404);
    expect(
      (await DELETE(request("http://localhost/api/cleaner?job=job", { method: "DELETE" }))).status
    ).toBe(200);
    expect(worker.cancelJob).toHaveBeenCalledWith("job");
  });

  it("handles unavailable reports without exposing worker error contents", async () => {
    worker.loadReport.mockRejectedValue(new Error("PRIVATE_SOURCE_VALUE"));
    const response = await GET(request("http://localhost/api/cleaner?job=job"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("PRIVATE_SOURCE_VALUE");
  });

  it("starts the complete bank snapshot without applying the selected-document 25 cap", async () => {
    worker.startJob.mockResolvedValueOnce({
      job_id: "all-bank",
      status: "running",
      progress: { total: 61, processed: 0 },
    });
    const response = await POST(
      request(undefined, {
        method: "POST",
        body: JSON.stringify({ bank_id: "bank", action: "clean_bank" }),
      })
    );
    expect(response.status).toBe(202);
    expect(worker.startJob).toHaveBeenCalledWith("bank", { all: true });
    expect((await response.json()).progress.total).toBe(61);
  });

  it("cannot substitute a saved job's bank for the caller's resume boundary", async () => {
    worker.resumeJob.mockImplementation(async (_id: string, bank: string) => {
      if (bank !== "bank") throw new Error("PRIVATE_BOUNDARY_ERROR");
      return { ...completed, status: "running" };
    });
    const response = await POST(
      request(undefined, {
        method: "POST",
        body: JSON.stringify({ bank_id: "other-bank", action: "resume", job_id: "job" }),
      })
    );
    expect(response.ok).toBe(false);
    expect(worker.resumeJob).toHaveBeenCalledWith("job", "other-bank", false);
    expect(worker.startJob).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("PRIVATE_BOUNDARY_ERROR");
  });

  it("distinguishes retry of failed documents from ordinary resume", async () => {
    worker.resumeJob.mockResolvedValue({ ...completed, status: "running" });
    const response = await POST(
      request(undefined, {
        method: "POST",
        body: JSON.stringify({ bank_id: "bank", action: "retry", job_id: "job" }),
      })
    );
    expect(response.status).toBe(202);
    expect(worker.resumeJob).toHaveBeenCalledWith("job", "bank", true);
  });

  it("requires a separate acknowledgement before exporting partial candidates", async () => {
    worker.getJob.mockResolvedValue({ ...completed, status: "partial" });
    const refused = await GET(request("http://localhost/api/cleaner?job=job&export=1&reviewed=1"));
    expect(refused.status).toBe(403);
    expect(worker.exportStream).not.toHaveBeenCalled();
    const accepted = await GET(
      request("http://localhost/api/cleaner?job=job&export=1&reviewed=1&partial=1")
    );
    expect(accepted.status).toBe(200);
    expect(worker.exportStream).toHaveBeenCalledOnce();
  });

  it("never exports an actively changing job even when both acknowledgements are supplied", async () => {
    worker.getJob.mockResolvedValue({ ...completed, status: "running" });
    const response = await GET(
      request("http://localhost/api/cleaner?job=job&export=1&reviewed=1&partial=1")
    );
    expect(response.ok).toBe(false);
    expect(worker.exportStream).not.toHaveBeenCalled();
  });

  it("keeps export blocked until a cancelled worker has finished committing its checkpoint", async () => {
    worker.getJob.mockResolvedValue({ ...completed, status: "cancelled" });
    worker.isJobActive.mockReturnValue(true);
    const response = await GET(
      request("http://localhost/api/cleaner?job=job&export=1&reviewed=1&partial=1")
    );
    expect(response.status).toBe(409);
    expect(worker.exportStream).not.toHaveBeenCalled();
  });

  it("awaits persisted job recovery and discovers the latest job under an explicit bank", async () => {
    worker.getJob.mockImplementationOnce(async () => ({ ...completed, status: "paused" }));
    const saved = await GET(request("http://localhost/api/cleaner?job=job"));
    expect(saved.status).toBe(200);
    expect((await saved.json()).status).toBe("paused");
    worker.latestJob.mockResolvedValue({ ...completed, status: "cancelled" });
    const latest = await GET(request("http://localhost/api/cleaner?bank_id=bank"));
    expect(latest.status).toBe(200);
    expect(worker.latestJob).toHaveBeenCalledWith("bank");
    expect((await latest.json()).status).toBe("cancelled");
  });
});
