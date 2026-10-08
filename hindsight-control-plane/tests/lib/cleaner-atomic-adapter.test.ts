import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanerAtomicAdapter } from "@/lib/cleaner-atomic-adapter";
import {
  canonical,
  hash,
  createImportService,
  type AtomicGuard,
  type Condition,
  type RollbackCommand,
} from "@/lib/cleaner-import";
vi.mock("@/lib/hindsight-client", () => ({
  DATAPLANE_URL: "http://127.0.0.1:8888",
  getDataplaneHeaders: (extra?: Record<string, string>) => ({
    ...extra,
    Authorization: "Bearer SYNTHETIC_TEST_AUTH",
  }),
}));
afterEach(() => vi.useRealTimers());
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture() {
  const condition: Condition = {
    execution_config_sha256: hash("config"),
    bank_id: "bank/with:scope",
    source_id: "original.md",
    source_sha256: hash("source"),
    source_updated_at: "2026-10-07T00:00:00+00:00",
    source_metadata_sha256: hash("{}"),
    target_id: "cleaner-v1-" + hash("target").slice(0, 48),
    target_sha256: hash("candidate 🧭"),
    owner_key: hash("owner"),
    operation_id: "12345678-1234-5678-a123-123456789abc",
    payload_sha256: "",
  };
  const payload = {
    async: true,
    operation_id: condition.operation_id,
    items: [
      {
        document_id: condition.target_id,
        content: "candidate 🧭",
        timestamp: "unset",
        metadata: {
          cleaner_owner: "hindsight-cleaner-v1",
          cleaner_owner_key: condition.owner_key,
          cleaner_operation_id: condition.operation_id,
          cleaner_source_id: condition.source_id,
          cleaner_source_sha256: condition.source_sha256,
          cleaner_source_updated_at: condition.source_updated_at,
          cleaner_source_metadata_sha256: condition.source_metadata_sha256,
          cleaner_candidate_sha256: condition.target_sha256,
        },
        tags: [],
      },
    ],
  };
  const payloadJson = JSON.stringify(payload);
  condition.payload_sha256 = hash(payloadJson);
  const receipt = {
    condition_sha256: hash(canonical(condition)),
    operation_id: condition.operation_id,
    payload_sha256: condition.payload_sha256,
    target_id: condition.target_id,
    owner_key: condition.owner_key,
    target_sha256: condition.target_sha256,
    metadata_sha256: hash("metadata"),
    graph_sha256: hash("graph"),
    updated_at: "2026-10-07T01:00:00+00:00",
    status: "completed",
    created: true,
    rollback_operation_id: null as string | null,
    rollback_payload_sha256: null as string | null,
    created_receipt_sha256: null as string | null,
  };
  const rollbackBinding = {
    condition,
    expected_document_metadata_sha256: receipt.metadata_sha256,
    expected_updated_at: receipt.updated_at,
    rollback_operation_id: "87654321-1234-5678-a123-123456789abc",
    created_receipt_sha256: hash(canonical(receipt)),
  };
  const rollback: RollbackCommand = {
    ...rollbackBinding,
    rollback_payload_sha256: hash(canonical(rollbackBinding)),
  };
  const caps = {
    atomic_create: true,
    atomic_source_check: true,
    conditional_delete: true,
    contract_id: "cleaner-atomic-v1",
    reason: null,
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
    if (String(url).endsWith("/capabilities")) return json(caps);
    if (options?.method === "POST" && String(url).endsWith("/rollback"))
      return json({ deleted: true, rollback_operation_id: rollback.rollback_operation_id });
    if (options?.method === "POST")
      return json({ accepted: true, operation_id: condition.operation_id, reused: false });
    return json(receipt);
  }) as unknown as typeof fetch;
  const adapter = new CleanerAtomicAdapter({ fetcher });
  const signal = new AbortController().signal;
  return { condition, payload, payloadJson, receipt, rollback, caps, fetcher, adapter, signal };
}
describe("loopback atomic cleaner adapter", () => {
  it("uses bank-scoped encoded endpoints, existing auth and exact backed-up create bytes", async () => {
    const f = fixture();
    await f.adapter.create({ condition: f.condition, payload_json: f.payloadJson }, f.signal);
    const calls = vi.mocked(f.fetcher).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toContain("/banks/bank%2Fwith%3Ascope/cleaner/capabilities");
    const options = calls[1][1]!;
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer SYNTHETIC_TEST_AUTH", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(options.body))).toEqual({
      condition: f.condition,
      payload_json: f.payloadJson,
    });
  });
  it("rejects non-loopback origins, URL credentials and path/query redirects before transport", () => {
    for (const baseUrl of [
      "http://localhost:0",
      "https://example.org",
      "http://127.0.0.1.evil.test:8888",
      "file:///tmp",
      "http://user:pass@localhost:8888",
      "http://localhost:8888/path",
      "http://localhost:8888/?token=x",
    ])
      expect(() => new CleanerAtomicAdapter({ baseUrl })).toThrow("loopback");
    for (const baseUrl of ["http://localhost:8888/", "http://[::1]:8888"])
      expect(() => new CleanerAtomicAdapter({ baseUrl })).not.toThrow();
  });
  it("fails closed on absent, malformed, disabled or mismatched capabilities without mutation", async () => {
    for (const response of [
      () => json({}, 404),
      () => json({ atomic_create: true }),
      () => json({ ...fixture().caps, contract_id: "future" }),
      () => json({ ...fixture().caps, atomic_source_check: false }),
    ]) {
      const f = fixture();
      f.fetcher = vi.fn(async () => response()) as typeof fetch;
      const adapter = new CleanerAtomicAdapter({ fetcher: f.fetcher });
      expect((await adapter.capabilities("bank")).atomic_source_check).toBe(false);
      await expect(
        adapter.create({ condition: f.condition, payload_json: f.payloadJson }, f.signal)
      ).rejects.toThrow("capability");
      expect(
        vi.mocked(f.fetcher).mock.calls.every(([, options]) => options?.method === "GET")
      ).toBe(true);
    }
  });
  it("preserves every receipt field and verifies original condition and payload bindings", async () => {
    const f = fixture();
    const receipt = await f.adapter.operation(f.condition, f.signal);
    expect(receipt).toEqual(f.receipt);
    expect(hash(canonical(receipt))).toBe(f.rollback.created_receipt_sha256);
    for (const changed of [
      { condition_sha256: hash("different config") },
      { payload_sha256: hash("different") },
      { owner_key: hash("external") },
      { target_id: "original.md" },
      { created: false },
    ]) {
      const adapter = new CleanerAtomicAdapter({
        fetcher: async () => json({ ...f.receipt, ...changed }),
      });
      await expect(adapter.operation(f.condition, f.signal)).rejects.toThrow("receipt");
    }
  });
  it("rejects missing nullable receipt fields and unknown schema instead of hashing a reconstructed subset", async () => {
    const f = fixture();
    for (const key of [
      "rollback_operation_id",
      "rollback_payload_sha256",
      "created_receipt_sha256",
    ]) {
      const receipt = { ...f.receipt } as Record<string, unknown>;
      delete receipt[key];
      await expect(
        new CleanerAtomicAdapter({ fetcher: async () => json(receipt) }).operation(
          f.condition,
          f.signal
        )
      ).rejects.toThrow("fields");
    }
    await expect(
      new CleanerAtomicAdapter({
        fetcher: async () => json({ ...f.receipt, unexpected: true }),
      }).operation(f.condition, f.signal)
    ).rejects.toThrow("fields");
  });
  it("treats a missing receipt as pending, never completed or created", async () => {
    const f = fixture();
    const adapter = new CleanerAtomicAdapter({ fetcher: async () => json({}, 404) });
    expect(await adapter.operation(f.condition, f.signal)).toMatchObject({
      status: "pending",
      created: false,
    });
    expect(await adapter.rollbackOperation(f.rollback, f.signal)).toMatchObject({
      status: "pending",
      deleted: false,
    });
  });
  it("rejects mutated payload, provenance, semantic timestamp and oversized bytes before any network call", async () => {
    const f = fixture();
    await expect(
      f.adapter.create({ condition: f.condition, payload_json: f.payloadJson + " " }, f.signal)
    ).rejects.toThrow("payload");
    for (const change of [
      (item: (typeof f.payload.items)[0]) => {
        item.timestamp = "2026-10-07";
      },
      (item: (typeof f.payload.items)[0]) => {
        item.metadata.cleaner_owner = "external";
      },
    ]) {
      const payload = structuredClone(f.payload);
      change(payload.items[0]);
      const payloadJson = JSON.stringify(payload);
      await expect(
        f.adapter.create(
          {
            condition: { ...f.condition, payload_sha256: hash(payloadJson) },
            payload_json: payloadJson,
          },
          f.signal
        )
      ).rejects.toThrow("Atomic");
    }
    const large = "x".repeat(8 * 1024 * 1024 + 1);
    await expect(
      f.adapter.create(
        { condition: { ...f.condition, payload_sha256: hash(large) }, payload_json: large },
        f.signal
      )
    ).rejects.toThrow("payload");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("never retries mutation on quota, conflict, lost acknowledgement or mismatched acknowledgement", async () => {
    const f = fixture();
    for (const reply of [
      () => json({ raw: "SYNTHETIC_PRIVATE_VALUE" }, 429),
      () => json({}, 409),
      () => Promise.reject(new Error("SYNTHETIC_PRIVATE_VALUE")),
      () => json({ accepted: true, operation_id: "different", reused: false }),
    ]) {
      const fetcher = vi.fn(async (url: RequestInfo | URL) =>
        String(url).endsWith("/capabilities") ? json(f.caps) : reply()
      ) as typeof fetch;
      const adapter = new CleanerAtomicAdapter({ fetcher });
      await expect(
        adapter.create({ condition: f.condition, payload_json: f.payloadJson }, f.signal)
      ).rejects.toThrow();
      expect(vi.mocked(fetcher).mock.calls).toHaveLength(2);
    }
  });
  it("submits only hash-bound conditional rollback and validates exact acknowledgements", async () => {
    const f = fixture();
    await expect(f.adapter.remove(f.rollback, f.signal)).resolves.toMatchObject({
      deleted: true,
      rollback_operation_id: f.rollback.rollback_operation_id,
    });
    const calls = vi.mocked(f.fetcher).mock.calls;
    expect(
      String(calls[1][0]).endsWith(`/cleaner/operations/${f.condition.operation_id}/rollback`)
    ).toBe(true);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual(f.rollback);
    await expect(
      f.adapter.remove({ ...f.rollback, expected_updated_at: "2026-10-08T00:00:00Z" }, f.signal)
    ).rejects.toThrow("binding");
    expect(calls).toHaveLength(2);
  });
  it("maps only a matching durable tombstone to deleted; a completed creation receipt is still pending rollback", async () => {
    const f = fixture();
    expect(await f.adapter.rollbackOperation(f.rollback, f.signal)).toMatchObject({
      status: "pending",
      deleted: false,
    });
    Object.assign(f.receipt, {
      status: "rolled_back",
      rollback_operation_id: f.rollback.rollback_operation_id,
      rollback_payload_sha256: f.rollback.rollback_payload_sha256,
      created_receipt_sha256: f.rollback.created_receipt_sha256,
    });
    expect(await f.adapter.rollbackOperation(f.rollback, f.signal)).toMatchObject({
      status: "completed",
      deleted: true,
    });
    f.receipt.rollback_operation_id = "11111111-1234-5678-a123-123456789abc";
    await expect(f.adapter.rollbackOperation(f.rollback, f.signal)).rejects.toThrow("tombstone");
  });
  it("bounds responses and scrubs upstream values from errors", async () => {
    const f = fixture();
    for (const reply of [
      () => new Response("SYNTHETIC_PRIVATE_VALUE", { status: 500 }),
      () => new Response("x".repeat(65537)),
      () => new Response("{bad json"),
    ]) {
      const adapter = new CleanerAtomicAdapter({ fetcher: async () => reply() });
      try {
        await adapter.operation(f.condition, f.signal);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).toContain("Atomic");
        expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
      }
    }
  });
  it("honors cancellation and times out once without retrying or changing operation IDs", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          })
        )
    ) as typeof fetch;
    const adapter = new CleanerAtomicAdapter({ fetcher, timeoutMilliseconds: 5 });
    const pending = expect(adapter.operation(f.condition, f.signal)).rejects.toThrow("transport");
    await vi.advanceTimersByTimeAsync(5);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.operation(f.condition, controller.signal)).rejects.toThrow("transport");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("constructs an opt-in factory adapter and leaves the default or invalid origin fail-closed", async () => {
    const f = fixture();
    const deps = {
      root: "/tmp/cleaner-adapter-factory-test",
      fetcher: f.fetcher,
      getJob: async () => undefined,
      jobActive: () => false,
      verify: async () => ({}),
    };
    const inspect = (service: ReturnType<typeof createImportService>) =>
      (service as unknown as { dependencies: { guard?: AtomicGuard } }).dependencies.guard;
    expect(inspect(createImportService(deps, { enableAtomicGuard: false }))).toBeUndefined();
    expect(
      inspect(
        createImportService(deps, {
          enableAtomicGuard: true,
          adapter: { baseUrl: "https://example.org" },
        })
      )
    ).toBeUndefined();
    const guard = inspect(createImportService(deps, { enableAtomicGuard: true }));
    expect(guard).toBeInstanceOf(CleanerAtomicAdapter);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await guard!.capabilities(f.condition.bank_id)).atomic_create).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("initializes the actual opt-in singleton without import cycles or automatic mutation", async () => {
    const f = fixture();
    const shared = globalThis as typeof globalThis & { cleanerImportService?: unknown };
    const previous = shared.cleanerImportService;
    delete shared.cleanerImportService;
    vi.stubEnv("CLEANER_ENABLE_ATOMIC_IMPORTS", "1");
    vi.stubGlobal("fetch", f.fetcher);
    vi.resetModules();
    try {
      const module = await import("@/lib/cleaner-import");
      const guard = (module.importService as unknown as { dependencies: { guard?: AtomicGuard } })
        .dependencies.guard;
      expect(guard).toBeDefined();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect((await guard!.capabilities(f.condition.bank_id)).contract_id).toBe(
        "cleaner-atomic-v1"
      );
      expect(
        vi.mocked(f.fetcher).mock.calls.every(([, options]) => options?.method === "GET")
      ).toBe(true);
    } finally {
      shared.cleanerImportService = previous;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
  it.each([
    ["ASCII", "x", 49999],
    ["ASCII", "x", 50000],
    ["ASCII", "x", 50001],
    ["astral", "🧭", 49999],
    ["astral", "🧭", 50000],
    ["astral", "🧭", 50001],
  ] as const)(
    "enforces the Unicode admission boundary for %s (%s) at %i code points",
    async (_label, character, count) => {
      const f = fixture();
      const payload = structuredClone(f.payload);
      payload.items[0].content = character.repeat(count);
      const condition = { ...f.condition, target_sha256: hash(payload.items[0].content) };
      payload.items[0].metadata.cleaner_candidate_sha256 = condition.target_sha256;
      const payloadJson = JSON.stringify(payload);
      condition.payload_sha256 = hash(payloadJson);
      if (count <= 50000) {
        await expect(
          f.adapter.create({ condition, payload_json: payloadJson }, f.signal)
        ).resolves.toMatchObject({ accepted: true });
        expect(f.fetcher).toHaveBeenCalledTimes(2);
      } else {
        await expect(
          f.adapter.create({ condition, payload_json: payloadJson }, f.signal)
        ).rejects.toThrow("50,000 Unicode code point");
        expect(f.fetcher).not.toHaveBeenCalled();
      }
      expect(Array.from(payload.items[0].content)).toHaveLength(count);
      if (character === "🧭") expect(payload.items[0].content.length).toBe(count * 2);
    }
  );
});
