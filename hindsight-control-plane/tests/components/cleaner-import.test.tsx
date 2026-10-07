// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CleanerImportPanel, candidateIneligibility } from "@/components/cleaner-import";

vi.mock("next/image", () => ({ default: () => null }));
const candidate = {
  id: "source-doc",
  bank_id: "bank-a",
  raw_sha256: "a".repeat(64),
  status: "candidate",
  flags: [],
  coverage: { omissions: [] },
};
const props = {
  bankId: "bank-a",
  jobId: "job-a",
  documents: [candidate],
  reviewed: true,
  disabled: false,
};
const plan = {
  plan_id: "plan-a",
  plan_hash: "hash-a",
  confirmation_token: "token-a",
  bank_id: "bank-a",
  status: "prepared",
  eligible: [
    {
      document_index: 0,
      source_id: "source-doc",
      candidate_id: "cleaned-version-a",
      source_sha256: "a".repeat(64),
      candidate_sha256: "b".repeat(64),
      diff: "source mapped diff",
    },
  ],
  rejected: [],
  backup_manifest: { verified: true },
  rollback: { available: false, reason: "No conditional delete" },
};
const operation = {
  operation_id: "plan-a",
  status: "completed",
  progress: { total: 1, imported: 1, reused: 0, failed: 0, blocked: 0, uncertain: 0, remaining: 0 },
  items: [],
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function buildPlan() {
  fireEvent.click(screen.getByRole("button", { name: "Apply / import to Hindsight" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "source-doc" }));
  fireEvent.click(screen.getByRole("button", { name: "Build dry-run import plan" }));
  await screen.findByRole("textbox", { name: "Confirm import bank" });
}
function acknowledge() {
  fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
    target: { value: "bank-a" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the complete plan/ }));
}

describe("guarded cleaner import", () => {
  it("excludes quarantine, omitted evidence, error and bank-boundary candidates", () => {
    expect(candidateIneligibility(candidate, "bank-a")).toBeUndefined();
    expect(candidateIneligibility({ ...candidate, status: "quarantined" }, "bank-a")).toMatch(
      /quarantined/
    );
    expect(
      candidateIneligibility({ ...candidate, coverage: { omissions: ["citation"] } }, "bank-a")
    ).toMatch(/omissions/);
    expect(candidateIneligibility({ ...candidate, status: "failed" }, "bank-a")).toMatch(/failed/);
    expect(candidateIneligibility(candidate, "bank-b")).toMatch(/boundary/);
  });

  it("requires exact bank plus acknowledgment and binds the server plan once", async () => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) =>
      response(JSON.parse(options!.body as string).action === "plan" ? plan : operation)
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    const confirm = screen.getByRole("button", {
      name: "Confirm additive import",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
      target: { value: "wrong-bank" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the complete plan/ }));
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
      target: { value: "bank-a" },
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/Operation plan-a/);
    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(bodies).toEqual([
      { action: "plan", bank_id: "bank-a", job_id: "job-a", document_indexes: [0] },
      {
        action: "confirm",
        plan_id: "plan-a",
        plan_hash: "hash-a",
        confirmation_token: "token-a",
        bank_confirmation: "bank-a",
        acknowledged: true,
      },
    ]);
  });

  it("declining a prepared plan performs no writes and resets confirmation", async () => {
    const fetchMock = vi.fn(async () => response(plan));
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Back / decline" }));
    expect(screen.queryByRole("textbox", { name: "Confirm import bank" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply / import to Hindsight" }));
    expect((screen.getByRole("checkbox", { name: "source-doc" }) as HTMLInputElement).checked).toBe(
      false
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps capability-blocked dry runs reviewable without enabling confirmation", async () => {
    const fetchMock = vi.fn(async () =>
      response({ ...plan, status: "blocked", reason: "Atomic creation not supported" })
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    expect(screen.getByRole("alert").textContent).toMatch(/Atomic creation not supported/);
    expect(
      (screen.getByRole("button", { name: "Confirm additive import" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects stale plan responses when source review is revoked", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
    );
    const view = render(<CleanerImportPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply / import to Hindsight" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "source-doc" }));
    fireEvent.click(screen.getByRole("button", { name: "Build dry-run import plan" }));
    view.rerender(<CleanerImportPanel {...props} reviewed={false} />);
    finish(response(plan));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Confirm import bank" })).toBeNull()
    );
    expect(
      (screen.getByRole("button", { name: "Apply / import to Hindsight" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("reports dry-run quota failure without submitting import confirmation", async () => {
    const fetchMock = vi.fn(async () => response({ error: "Candidate quota exceeded" }, 413));
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply / import to Hindsight" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "source-doc" }));
    fireEvent.click(screen.getByRole("button", { name: "Build dry-run import plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/quota/);
    expect(screen.queryByRole("button", { name: "Confirm additive import" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate confirmations after an uncertain outcome until operation recovery", async () => {
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (JSON.parse(options!.body as string).action === "plan") return response(plan);
      throw new Error("Network response lost");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Confirm additive import" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/uncertain/);
    expect(screen.queryByRole("button", { name: "Confirm additive import" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Apply / import to Hindsight" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Recover import operation" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("can stop the import worker while read-only progress polling continues", async () => {
    const running = {
      ...operation,
      status: "running",
      progress: { ...operation.progress, imported: 0, remaining: 1 },
    };
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ plan, operation: running });
      const action = JSON.parse(options.body as string).action;
      return response(
        action === "plan"
          ? plan
          : action === "cancel"
            ? { ...running, status: "cancelled", can_resume: true }
            : running
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Confirm additive import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop import worker" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, options]) => options?.body && JSON.parse(options.body as string).action === "cancel"
        )
      ).toBe(true)
    );
    expect(await screen.findByRole("button", { name: "Review resume / retry" })).toBeTruthy();
  });

  it("does not transfer a late plan or approval to another bank", async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<CleanerImportPanel key="bank-a" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply / import to Hindsight" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "source-doc" }));
    fireEvent.click(screen.getByRole("button", { name: "Build dry-run import plan" }));
    view.rerender(
      <CleanerImportPanel
        key="bank-b"
        {...props}
        bankId="bank-b"
        jobId="job-b"
        documents={[{ ...candidate, bank_id: "bank-b" }]}
      />
    );
    finish(response(plan));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Confirm import bank" })).toBeNull()
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports partial outcomes and keeps unsupported rollback read-only", async () => {
    const partial = {
      ...operation,
      status: "partial",
      can_resume: true,
      progress: {
        total: 2,
        imported: 1,
        reused: 0,
        failed: 1,
        blocked: 0,
        uncertain: 0,
        remaining: 1,
      },
      items: [{ status: "failed", error: "quota exceeded" }],
    };
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ plan, operation: partial });
      const action = JSON.parse(options.body as string).action;
      return response(
        action === "rollback_plan"
          ? {
              ...plan,
              status: "blocked",
              mode: "rollback",
              available: false,
              reason: "No conditional-delete guarantee",
            }
          : action === "plan"
            ? plan
            : partial
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Confirm additive import" }));
    expect(await screen.findByText("50% staged")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review resume / retry" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview rollback" }));
    expect(await screen.findByRole("region", { name: "Rollback preview" })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Confirm rollback (unsupported by this API)",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    const rollbackRequest = fetchMock.mock.calls.find(
      ([, options]) =>
        options?.body && JSON.parse(options.body as string).action === "rollback_plan"
    );
    expect(JSON.parse(rollbackRequest![1]!.body as string)).toEqual({
      action: "rollback_plan",
      bank_id: "bank-a",
      plan_id: "plan-a",
    });
    expect(
      fetchMock.mock.calls.some(
        ([, options]) =>
          options?.body && JSON.parse(options.body as string).action === "rollback_confirm"
      )
    ).toBe(false);
  });

  it("requires fresh approval for a prepared conditional rollback and binds its new token", async () => {
    const rollback = {
      ...plan,
      mode: "rollback",
      plan_id: "rollback-a",
      plan_hash: "rollback-hash",
      confirmation_token: "rollback-token",
    };
    const rolledBack = {
      ...operation,
      operation_id: "rollback-a",
      mode: "rollback",
      progress: { ...operation.progress, rolled_back: 1 },
    };
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const body = JSON.parse(options!.body as string);
      return response(
        body.action === "plan"
          ? plan
          : body.action === "rollback_plan"
            ? rollback
            : body.plan_id === "rollback-a"
              ? rolledBack
              : operation
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Confirm additive import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview rollback" }));
    const confirm = (await screen.findByRole("button", {
      name: "Confirm guarded rollback",
    })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(
      (screen.getByRole("textbox", { name: "Confirm import bank" }) as HTMLInputElement).value
    ).toBe("");
    expect(
      (screen.getByRole("checkbox", { name: /I reviewed the rollback list/ }) as HTMLInputElement)
        .checked
    ).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
      target: { value: "bank-a" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the rollback list/ }));
    fireEvent.click(confirm);
    expect(await screen.findByText("100% rolled back")).toBeTruthy();
    expect(screen.getByText(/1 owned candidate versions removed/)).toBeTruthy();
    const bodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options!.body as string));
    expect(bodies.at(-1)).toEqual({
      action: "confirm",
      plan_id: "rollback-a",
      plan_hash: "rollback-hash",
      confirmation_token: "rollback-token",
      bank_confirmation: "bank-a",
      acknowledged: true,
    });
    expect(
      bodies.some((body) => body.action === "rollback_plan" && body.bank_id === "bank-a")
    ).toBe(true);
  });

  it("recovers uncertain rollback outcomes without blindly resubmitting deletion", async () => {
    const rollback = {
      ...plan,
      mode: "rollback",
      plan_id: "rollback-uncertain",
      plan_hash: "rollback-hash",
      confirmation_token: "rollback-token",
    };
    const uncertain = {
      ...operation,
      operation_id: "rollback-uncertain",
      mode: "rollback",
      status: "uncertain",
      can_reconcile: true,
      progress: { ...operation.progress, imported: 0, rolled_back: 0, uncertain: 1, remaining: 1 },
    };
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return response({ plan: rollback, operation: uncertain });
      const body = JSON.parse(options.body as string);
      if (body.action === "plan") return response(plan);
      if (body.action === "rollback_plan") return response(rollback);
      if (body.plan_id === "rollback-uncertain" && body.action === "confirm")
        throw new Error("Rollback response lost");
      if (body.action === "reconcile")
        return response({
          ...uncertain,
          status: "completed",
          progress: { ...operation.progress, rolled_back: 1 },
        });
      return response(operation);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<CleanerImportPanel {...props} />);
    await buildPlan();
    acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Confirm additive import" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview rollback" }));
    await screen.findByRole("button", { name: "Confirm guarded rollback" });
    fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
      target: { value: "bank-a" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the rollback list/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm guarded rollback" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Confirm guarded rollback" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recover rollback operation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review rollback reconciliation" }));
    const reconcile = (await screen.findByRole("button", {
      name: "Confirm rollback reconciliation",
    })) as HTMLButtonElement;
    expect(reconcile.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Confirm import bank" }), {
      target: { value: "bank-a" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the saved rollback plan/ }));
    fireEvent.click(reconcile);
    expect(await screen.findByText("100% rolled back")).toBeTruthy();
    const bodies = fetchMock.mock.calls
      .filter(([, options]) => options?.body)
      .map(([, options]) => JSON.parse(options!.body as string));
    expect(
      bodies.filter((body) => body.plan_id === "rollback-uncertain" && body.action === "confirm")
    ).toHaveLength(1);
    expect(bodies.at(-1).action).toBe("reconcile");
  });
});
