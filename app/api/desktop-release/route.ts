import { isDesktopReleaseReady, selectDesktopRelease } from "@/lib/desktop-release";

const TARGET_RELEASE_TAG = "v0.2.3";
const FALLBACK_RELEASE_TAG = "v0.2.2";
const RELEASE_BASE = "https://github.com/yuanze-dev/video-gen/releases";
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

type DesktopReleaseInfo = {
  available: boolean;
  /** Kept false for v0.2.2 Web bundles that still understand the old gate. */
  required: boolean;
  version: string;
  downloadUrl: string;
  releasePageUrl: string;
  downloadSizeBytes?: number;
  minimumSupportedVersion: string | null;
};

async function inspectRelease(tag: string): Promise<DesktopReleaseInfo> {
  const version = tag.replace(/^v/, "");
  const manifestUrl = `${RELEASE_BASE}/download/${tag}/latest-mac.yml`;
  const updaterPath = `littlestart-${version}-arm64-mac.zip`;
  const updaterUrl = `${RELEASE_BASE}/download/${tag}/${updaterPath}`;
  const downloadUrl = `${RELEASE_BASE}/download/${tag}/littlestart-${version}-arm64.dmg`;
  const releasePageUrl = `${RELEASE_BASE}/tag/${tag}`;

  try {
    // Never advertise a release until both the updater manifest and the manual
    // fallback are public. Reading the manifest body also protects against
    // a mistagged release whose embedded version doesn't match the forced tag.
    const [manifestResponse, updaterResponse, installerResponse] = await Promise.all([
      fetch(manifestUrl, {
        redirect: "follow",
        next: { revalidate: 15 },
        signal: AbortSignal.timeout(8_000),
      }),
      fetch(updaterUrl, {
        method: "HEAD",
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
    const available = isDesktopReleaseReady({
      manifestOk: manifestResponse.ok,
      installerOk: installerResponse.ok,
      updaterOk: updaterResponse.ok,
      manifest,
      requiredVersion: tag,
      expectedUpdaterPath: updaterPath,
    });
    const sizeHeader = installerResponse.headers.get("content-length");
    const downloadSizeBytes = sizeHeader ? Number(sizeHeader) : undefined;

    return {
      available,
      required: false,
      version: tag,
      downloadUrl,
      releasePageUrl,
      downloadSizeBytes: Number.isFinite(downloadSizeBytes) ? downloadSizeBytes : undefined,
      minimumSupportedVersion: null,
    };
  } catch {
    return {
      available: false,
      required: false,
      version: tag,
      downloadUrl,
      releasePageUrl,
      minimumSupportedVersion: null,
    };
  }
}

export async function GET() {
  // Keep the already-verified fallback discoverable during the Web-deploy →
  // desktop-release gap. The response advertises availability only after both
  // updater and manual-install assets are public; it never implies UI blocking.
  const candidates = await Promise.all([
    inspectRelease(TARGET_RELEASE_TAG),
    inspectRelease(FALLBACK_RELEASE_TAG),
  ]);
  const release = selectDesktopRelease(candidates);
  return Response.json(release, { headers: RESPONSE_HEADERS });
}
