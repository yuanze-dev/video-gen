import fs from "node:fs/promises";
import { getJob } from "@/lib/render/jobs";

export const runtime = "nodejs";

// Serves an uploaded asset back to the headless browser during rendering.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string; id: string }> },
) {
  const { jobId, id } = await params;
  const job = getJob(jobId);
  const asset = job?.assets[id];
  if (!asset) return new Response("not found", { status: 404 });
  const buf = await fs.readFile(asset.file);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": asset.mime, "Cache-Control": "no-store" },
  });
}
