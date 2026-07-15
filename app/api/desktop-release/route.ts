const REQUIRED_RELEASE_TAG = "v0.2.1";
const RELEASE_API = `https://api.github.com/repos/yuanze-dev/video-gen/releases/tags/${REQUIRED_RELEASE_TAG}`;

export async function GET() {
  try {
    // Arm the Web-side forced-update gate only after the signed desktop release
    // is publicly available. This avoids blocking v0.2.0 during the short gap
    // between the production Web deploy and the macOS release workflow.
    const release = await fetch(RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "video-gen-update-gate",
      },
      next: { revalidate: 30 },
    });

    return Response.json(
      { required: release.ok, version: REQUIRED_RELEASE_TAG },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    // Fail open on a transient GitHub outage. The packaged auto-updater still
    // checks independently, and the gate will retry from the client.
    return Response.json(
      { required: false, version: REQUIRED_RELEASE_TAG },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
