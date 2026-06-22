import { NextRequest, NextResponse } from "next/server";
import { createJob, saveAsset, startRender } from "@/lib/render/jobs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const cfgStr = form.get("config");
  if (typeof cfgStr !== "string") {
    return new NextResponse("missing config", { status: 400 });
  }

  let cfgJson: unknown;
  try {
    cfgJson = JSON.parse(cfgStr);
  } catch {
    return new NextResponse("invalid config json", { status: 400 });
  }

  const job = await createJob();
  for (const [key, val] of form.entries()) {
    if (key.startsWith("asset:") && val instanceof File) {
      await saveAsset(job, key.slice("asset:".length), val);
    }
  }

  // Render asynchronously; the client polls the status endpoint.
  void startRender(job, cfgJson, req.nextUrl.origin);

  return NextResponse.json({ jobId: job.id });
}
