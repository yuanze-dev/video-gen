import { NextResponse } from "next/server";
import { getJob } from "@/lib/render/jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ status: "error", error: "任务不存在" }, { status: 404 });
  }
  return NextResponse.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    url: job.status === "done" ? `/api/render/${jobId}/download` : undefined,
  });
}
