import { NextRequest, NextResponse } from "next/server";
import {
  MAX_BYTES,
  cancelJob,
  getJob,
  jobView,
  loadReport,
  latestJob,
  resumeJob,
  exportStream,
  isJobActive,
  startJob,
  validBank,
} from "@/lib/cleaner-jobs";

export const runtime = "nodejs";

function permitted(request: NextRequest): boolean {
  // Next's server URL may be normalized to localhost although the browser used
  // 127.0.0.1. Validate the actual Host header, then require that exact origin.
  let url: URL;
  try {
    url = new URL(
      `${request.nextUrl.protocol}//${request.headers.get("host") || request.nextUrl.host}`
    );
  } catch {
    return false;
  }
  const host = url.hostname;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return (
    ["localhost", "127.0.0.1", "[::1]"].includes(host) &&
    (!origin || origin === url.origin) &&
    (!fetchSite || ["same-origin", "none"].includes(fetchSite))
  );
}
const failure = (error: string, status = 400) => NextResponse.json({ error }, { status });

async function boundedRequest(request: NextRequest): Promise<Uint8Array> {
  if (!request.body) throw new Error("Empty body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES + 8192) throw new Error("Body exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function POST(request: NextRequest) {
  if (!permitted(request))
    return failure("Cleaner is restricted to same-origin loopback requests.", 403);
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length > MAX_BYTES + 8192)
    return failure("Upload exceeds 64 MiB.", 413);
  try {
    // Enforce the limit on the actual stream before either parser buffers it.
    // Content-Length is merely an early rejection hint, including for chunked uploads.
    const bytes = await boundedRequest(request);
    let bank: unknown;
    let input: { all?: boolean; ids?: string[]; bytes?: Uint8Array; extension?: string };
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await new Response(bytes.buffer as ArrayBuffer, {
        headers: { "Content-Type": request.headers.get("content-type")! },
      }).formData();
      bank = form.get("bank_id");
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES)
        return failure("Choose a non-empty file up to 64 MiB.");
      const extension = /\.(md|txt|json|zip)$/i.exec(file.name)?.[0]?.toLowerCase();
      if (!extension) return failure("Supported files: .md, .txt, .json, .zip.");
      input = { bytes: new Uint8Array(await file.arrayBuffer()), extension };
    } else {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      bank = body.bank_id;
      if (!validBank(bank)) return failure("Choose an explicit bank/project boundary.");
      if (body.action === "resume" || body.action === "retry") {
        if (typeof body.job_id !== "string") return failure("Choose a saved job to resume.");
        return NextResponse.json(
          jobView(await resumeJob(body.job_id, bank, body.action === "retry")),
          { status: 202 }
        );
      }
      if (body.action === "clean_bank") input = { all: true };
      else {
        const ids: unknown = body.document_ids;
        if (
          !Array.isArray(ids) ||
          ids.length < 1 ||
          ids.length > 25 ||
          ids.some((id) => typeof id !== "string" || !id || id.length > 4096)
        )
          return failure("Select 1–25 documents in one bank.");
        input = { ids: [...new Set(ids as string[])] };
      }
    }
    if (!validBank(bank)) return failure("Choose an explicit bank/project boundary.");
    return NextResponse.json(jobView(await startJob(bank, input)), { status: 202 });
  } catch {
    return failure(
      "Cannot start preview. Check the input, or cancel the running preview before retrying.",
      409
    );
  }
}

export async function GET(request: NextRequest) {
  if (!permitted(request)) return failure("Loopback access only.", 403);
  const bank = request.nextUrl.searchParams.get("bank_id");
  const jobId = request.nextUrl.searchParams.get("job");
  if (bank && !validBank(bank)) return failure("Choose an explicit bank boundary.");
  const job = jobId ? await getJob(jobId) : bank ? await latestJob(bank) : undefined;
  if (!job) return failure("Saved preview not found.", 404);
  if (bank && bank !== job.bank_id) return failure("Saved preview bank boundary mismatch.", 403);
  const view = jobView(job);
  if (!view.report_available)
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  try {
    if (request.nextUrl.searchParams.get("export") === "1") {
      if (request.nextUrl.searchParams.get("reviewed") !== "1")
        return failure("Review the diff and redactions before exporting candidates.", 403);
      if (job.status === "running" || isJobActive(job.id))
        return failure("Cancel or finish the preview before exporting its saved snapshot.", 409);
      if (job.status !== "completed" && request.nextUrl.searchParams.get("partial") !== "1")
        return failure(
          "This preview is incomplete. Acknowledge partial outcomes before exporting.",
          403
        );
      return new NextResponse(await exportStream(job), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="cleaner-${job.id}-${job.status === "completed" ? "CANDIDATE" : "PARTIAL-CANDIDATE"}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json(
      { ...view, report: await loadReport(job) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return failure("Candidate report unavailable. Source copies are preserved locally.", 500);
  }
}

export async function DELETE(request: NextRequest) {
  if (!permitted(request)) return failure("Loopback access only.", 403);
  const id = request.nextUrl.searchParams.get("job") || "";
  if (!(await getJob(id))) return failure("Preview not found.", 404);
  await cancelJob(id);
  return NextResponse.json(jobView((await getJob(id))!));
}
