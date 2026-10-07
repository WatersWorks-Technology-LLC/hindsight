// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CleanerView } from "@/components/cleaner-view";
import { measuredProgress } from "@/components/cleaner-progress";

const bankState = vi.hoisted(() => ({ currentBank: "fixture-bank" }));
vi.mock("@/lib/bank-context", () => ({ useBank: () => bankState }));
vi.mock("@/lib/api", () => ({ client: { listDocuments: vi.fn() } }));
vi.mock("next/image", () => ({ default: () => null }));
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  cleanup();
  bankState.currentBank = "fixture-bank";
  vi.unstubAllGlobals();
});

describe("cleaner progress and batch controls", () => {
  it("never estimates progress before a finite denominator or calls failed documents cleaned", () => {
    expect(measuredProgress({ total: null, processed: 3 })).toBeUndefined();
    expect(measuredProgress({ total: NaN, processed: 3 })).toBeUndefined();
    expect(measuredProgress({ total: 4, processed: Infinity })).toBeUndefined();
    expect(measuredProgress({ total: 4, processed: 3, failed: 1, completed: 4 })).toBe(75);
  });

  it("starts one bank-scoped batch from the prominent action", async () => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === "POST"
        ? response(
            {
              job_id: "batch-1",
              status: "completed",
              stage: "Complete",
              progress: { total: 0, processed: 0, completed: 0, remaining: 0 },
            },
            202
          )
        : response({ error: "No previous batch" }, 404)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerView />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Clean bank" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Clean bank" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean bank" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      bank_id: "fixture-bank",
      action: "clean_bank",
    });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1
    );
    expect(screen.getByText(/Nothing is automatically replaced or imported/)).toBeTruthy();
  });

  it("cancels the exact job when its POST ID arrives after the cancel click", async () => {
    let completePost!: (value: Response) => void;
    const post = new Promise<Response>((resolve) => {
      completePost = resolve;
    });
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === "POST") return post;
      if (options?.method === "DELETE")
        return Promise.resolve(
          response({ job_id: "late-batch", status: "cancelled", can_resume: true })
        );
      return Promise.resolve(response({ error: "No previous batch" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerView />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Clean bank" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Clean bank" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel cleanup" }));
    completePost(response({ job_id: "late-batch", status: "running" }, 202));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) => url.includes("job=late-batch") && options?.method === "DELETE"
        )
      ).toBe(true)
    );
    expect(await screen.findByRole("button", { name: "Resume this batch" })).toBeTruthy();
  });

  it("recovers a cancelled durable batch and resumes the same ID", async () => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
      options?.method === "POST"
        ? response({ job_id: "saved-batch", status: "completed", stage: "Complete" }, 202)
        : response({
            job_id: "saved-batch",
            status: "cancelled",
            can_resume: true,
            progress: { total: 10, processed: 3, completed: 3, remaining: 7 },
          })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerView />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume this batch" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true)
    );
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      bank_id: "fixture-bank",
      action: "resume",
      job_id: "saved-batch",
    });
  });

  it("requires both batch review and incomplete-export acknowledgment for partial results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          job_id: "partial-batch",
          status: "partial",
          can_retry: true,
          progress: { total: 2, processed: 1, failed: 1, completed: 2, remaining: 0 },
          report: {
            documents: [
              {
                id: "doc",
                bank_id: "fixture-bank",
                raw_sha256: "abc",
                status: "candidate",
                flags: [],
                segments: [],
                original_preview: "text",
                candidate_preview: "text",
                diff: "",
                coverage: {},
              },
            ],
            summary: {},
            duplicates: [],
            overlaps: [],
          },
        })
      )
    );
    render(<CleanerView />);
    const button = (await screen.findByRole("button", {
      name: "Export reviewed candidates",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this batch/ }));
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /This batch is incomplete/ }));
    expect(button.disabled).toBe(false);
    expect(screen.getByText("50% staged")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry failed documents" })).toBeTruthy();
  });

  it("keeps reconnect and cancellation available when progress polling fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("bank_id="))
        return response({ job_id: "running-batch", status: "running", stage: "Reading sources" });
      throw new Error("Connection interrupted");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerView />);
    expect(await screen.findByRole("button", { name: "Reconnect to progress" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel cleanup" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Clean bank" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("does not show an old bank's late job response after switching banks", async () => {
    let completePost!: (value: Response) => void;
    const post = new Promise<Response>((resolve) => {
      completePost = resolve;
    });
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === "POST") return post;
      if (options?.method === "DELETE")
        return Promise.resolve(
          response({ job_id: "old-bank-batch", status: "cancelled", can_resume: true })
        );
      return Promise.resolve(response({ error: "No previous batch" }, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CleanerView />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Clean bank" }) as HTMLButtonElement).disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Clean bank" }));
    bankState.currentBank = "next-bank";
    view.rerender(<CleanerView />);
    completePost(response({ job_id: "old-bank-batch", status: "running" }, 202));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, options]) => url.includes("job=old-bank-batch") && options?.method === "DELETE"
        )
      ).toBe(true)
    );
    expect(screen.getByText("next-bank")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume this batch" })).toBeNull();
  });

  it("hides stale reports and approval until the final cancellation snapshot loads", async () => {
    const report = (text: string) => ({
      documents: [
        {
          id: "doc",
          bank_id: "fixture-bank",
          raw_sha256: "abc",
          status: "candidate",
          flags: [],
          segments: [],
          original_preview: text,
          candidate_preview: text,
          diff: "",
          coverage: {},
        },
      ],
      summary: {},
      duplicates: [],
      overlaps: [],
    });
    let finishSnapshot!: (value: Response) => void;
    const snapshot = new Promise<Response>((resolve) => {
      finishSnapshot = resolve;
    });
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, options?: RequestInit) => {
        if (options?.method === "DELETE") {
          cancelled = true;
          return Promise.resolve(
            response({
              job_id: "snapshot-batch",
              status: "cancelled",
              can_resume: true,
              report_available: true,
            })
          );
        }
        if (cancelled && url.includes("job=")) return snapshot;
        return Promise.resolve(
          response({ job_id: "snapshot-batch", status: "running", report: report("old snapshot") })
        );
      })
    );
    render(<CleanerView />);
    await screen.findAllByText("old snapshot");
    fireEvent.click(screen.getByRole("button", { name: "Cancel cleanup" }));
    await waitFor(() => expect(screen.queryAllByText("old snapshot")).toHaveLength(0));
    expect(screen.queryByRole("checkbox", { name: /I reviewed this batch/ })).toBeNull();
    finishSnapshot(
      response({
        job_id: "snapshot-batch",
        status: "cancelled",
        can_resume: true,
        report: report("final snapshot"),
      })
    );
    expect((await screen.findAllByText("final snapshot")).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole("button", { name: "Export reviewed candidates" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("blocks approval of interrupted evidence and requires fresh review after reconnect", async () => {
    const report = {
      documents: [
        {
          id: "doc",
          bank_id: "fixture-bank",
          raw_sha256: "abc",
          status: "candidate",
          flags: [],
          segments: [],
          original_preview: "source",
          candidate_preview: "candidate",
          diff: "",
          coverage: {},
        },
      ],
      summary: {},
      duplicates: [],
      overlaps: [],
    };
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("bank_id="))
          return response({ job_id: "interrupt-batch", status: "running", report });
        if (++polls === 1) throw new Error("Interrupted");
        return response({ job_id: "interrupt-batch", status: "completed", report });
      })
    );
    render(<CleanerView />);
    await screen.findByRole("button", { name: "Reconnect to progress" });
    expect(
      (screen.getByRole("checkbox", { name: /I reviewed this batch/ }) as HTMLInputElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox", { name: /This batch is incomplete/ }) as HTMLInputElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Export reviewed candidates" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect to progress" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("checkbox", { name: /I reviewed this batch/ }) as HTMLInputElement)
          .disabled
      ).toBe(false)
    );
    expect(
      (screen.getByRole("checkbox", { name: /I reviewed this batch/ }) as HTMLInputElement).checked
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Export reviewed candidates" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
