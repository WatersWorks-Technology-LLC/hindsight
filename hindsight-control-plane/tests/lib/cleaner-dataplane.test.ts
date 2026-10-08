import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configured(url: string) {
  vi.stubEnv("HINDSIGHT_CP_DATAPLANE_API_URL", url);
  vi.resetModules();
  return import("@/lib/cleaner-dataplane");
}

describe("cleaner dataplane boundary", () => {
  it.each(["http://localhost:8888", "http://127.0.0.1:9010", "https://[::1]:9443"])(
    "uses explicit loopback configuration: %s",
    async (url) => {
      expect((await configured(url)).cleanerBankUrl("test/bank")).toBe(
        `${url}/v1/default/banks/test%2Fbank/documents`
      );
    }
  );
  it.each([
    "https://example.org",
    "http://localhost.example.org",
    "file:///tmp/service",
    "http://user:password@localhost",
    "http://localhost?token=fixture",
    "http://localhost#fragment",
    "http://localhost/proxy",
    "http://localhost:0",
  ])("rejects unsafe configuration before fetch: %s", async (url) => {
    const module = await configured(url);
    expect(() => module.cleanerBankUrl("fixture-bank")).toThrow();
  });
  it("keeps synthetic authentication on server-side fetches and rejects redirects", async () => {
    await configured("http://127.0.0.1:9010");
    vi.stubEnv("HINDSIGHT_CP_DATAPLANE_API_KEY", "synthetic-test-value");
    vi.resetModules();
    const { enumerateBank } = await import("@/lib/cleaner-jobs");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [], total: 0, offset: 0, limit: 100 }))
      );
    await enumerateBank("fixture-bank", fetcher, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:9010/v1/default/banks/fixture-bank/documents?limit=100&offset=0",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: { Authorization: "Bearer synthetic-test-value" },
      })
    );
  });
});
