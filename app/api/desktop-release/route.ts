import { isDesktopReleaseReady, selectDesktopRelease } from "@/lib/desktop-release";

const TARGET_RELEASE_TAG = "v0.2.2";
const FALLBACK_RELEASE_TAG = "v0.2.1";
const RELEASE_BASE = "https://github.com/yuanze-dev/video-gen/releases";
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

type DesktopReleaseInfo = {
  required: boolean;
  version: string;
  downloadUrl: string;
  releasePageUrl: string;
  downloadSizeBytes?: number;
};

async function inspectRelease(tag: string): Promise<DesktopReleaseInfo> {
  const version = tag.replace(/^v/, "");
  const manifestUrl = `${RELEASE_BASE}/download/${tag}/latest-mac.yml`;
  const downloadUrl = `${RELEASE_BASE}/download/${tag}/littlestart-${version}-arm64.dmg`;
  const releasePageUrl = `${RELEASE_BASE}/tag/${tag}`;

  try {
    // Never lock an old client until both the updater manifest and the manual
    // escape hatch are public. Reading the manifest body also protects against
    // a mistagged release whose embedded version doesn't match the forced tag.
    const [manifestResponse, installerResponse] = await Promise.all([
      fetch(manifestUrl, {
        redirect: "follow",
        next: { revalidate: 15 },
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(downloadUrl, {
        method: "HEAD",
        redirect: "follow",
        next: { revalidate: 15 },
        signal: AbortSignal.timeout(8_000),
      }),
    ]);
    const manifest = manifestResponse.ok ? await manifestResponse.text() : "";
    const required = isDesktopReleaseReady({
      manifestOk: manifestResponse.ok,
      installerOk: installerResponse.ok,
      manifest,
      requiredVersion: tag,
    });
    const sizeHeader = installerResponse.headers.get("content-length");
    const downloadSizeBytes = sizeHeader ? Number(sizeHeader) : undefined;

    return {
      required,
      version: tag,
      downloadUrl,
      releasePageUrl,
      downloadSizeBytes: Number.isFinite(downloadSizeBytes) ? downloadSizeBytes : undefined,
    };
  } catch {
    return { required: false, version: tag, downloadUrl, releasePageUrl };
  }
}

export async function GET() {
  // Keep the already-live v0.2.1 gate armed during the Web-deploy → desktop-
  // release gap. As soon as every v0.2.2 asset is public, the first candidate
  // wins automatically; only a failure to verify both releases fails open.
  const candidates = await Promise.all([
    inspectRelease(TARGET_RELEASE_TAG),
    inspectRelease(FALLBACK_RELEASE_TAG),
  ]);
  const release = selectDesktopRelease(candidates);
  return Response.json(release, { headers: RESPONSE_HEADERS });
}
