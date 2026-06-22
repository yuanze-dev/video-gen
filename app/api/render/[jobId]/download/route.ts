import fs from "node:fs/promises";
import { getJob } from "@/lib/render/jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job || job.status !== "done" || !job.outputPath) {
    return new Response("视频尚未就绪", { status: 404 });
  }
  const buf = await fs.readFile(job.outputPath);
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(buf.byteLength),
      "Content-Disposition": `attachment; filename="teleprompter-${jobId}.mp4"`,
    },
  });
}
