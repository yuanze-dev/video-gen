const REQUIRED_RELEASE_TAG = "v0.2.1";
const UPDATE_MANIFEST = `https://github.com/yuanze-dev/video-gen/releases/download/${REQUIRED_RELEASE_TAG}/latest-mac.yml`;

export async function GET() {
  try {
    // Arm the Web-side forced-update gate only after the signed desktop release
    // is publicly available. This avoids blocking v0.2.0 during the short gap
    // between the production Web deploy and the macOS release workflow.
    const manifest = await fetch(UPDATE_MANIFEST, {
      method: "HEAD",
      redirect: "follow",
      next: { revalidate: 15 },
    });

    return Response.json(
      { required: manifest.ok, version: REQUIRED_RELEASE_TAG },
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
