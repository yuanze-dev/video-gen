export function readDesktopManifestVersion(manifest: string): string | null {
  return manifest.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null;
}

export function isDesktopReleaseReady({
  manifestOk,
  installerOk,
  manifest,
  requiredVersion,
}: {
  manifestOk: boolean;
  installerOk: boolean;
  manifest: string;
  requiredVersion: string;
}): boolean {
  return (
    manifestOk &&
    installerOk &&
    readDesktopManifestVersion(manifest) === requiredVersion.replace(/^v/, "")
  );
}

export function selectDesktopRelease<T extends { required: boolean }>(
  candidates: readonly [T, ...T[]],
): T {
  return candidates.find((candidate) => candidate.required) ?? candidates[candidates.length - 1];
}
