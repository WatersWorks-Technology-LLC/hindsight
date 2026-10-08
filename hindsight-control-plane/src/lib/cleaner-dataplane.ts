import { DATAPLANE_URL, dataplaneBankUrl } from "./hindsight-client";

/** Cleaner snapshots stay on the configured local service, including authenticated instances. */
function validatedBase(): URL {
  const base = new URL(DATAPLANE_URL);
  const port = base.port ? Number(base.port) : base.protocol === "https:" ? 443 : 80;
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "Cleaner requires a loopback dataplane URL without credentials, path, query or fragment"
    );
  }
  return base;
}

export function cleanerBankUrl(bank: string, suffix = "/documents"): string {
  validatedBase();
  return dataplaneBankUrl(bank, suffix);
}

export function cleanerServiceUrl(suffix: string): string {
  const base = validatedBase();
  if (!suffix.startsWith("/") || suffix.startsWith("//"))
    throw new Error("Invalid local service path");
  return `${base.origin}${suffix}`;
}
