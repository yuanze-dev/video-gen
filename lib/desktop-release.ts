export function readDesktopManifestVersion(manifest: string): string | null {
  return manifest.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null;
}

export function readDesktopManifestPath(manifest: string): string | null {
  return manifest.match(/^path:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1] ?? null;
}

export function isDesktopReleaseReady({
  manifestOk,
  installerOk,
  updaterOk,
  manifest,
  requiredVersion,
  expectedUpdaterPath,
}: {
  manifestOk: boolean;
  installerOk: boolean;
  updaterOk: boolean;
  manifest: string;
  requiredVersion: string;
  expectedUpdaterPath: string;
}): boolean {
  return (
    manifestOk &&
    installerOk &&
    updaterOk &&
    readDesktopManifestVersion(manifest) === requiredVersion.replace(/^v/, "") &&
    readDesktopManifestPath(manifest) === expectedUpdaterPath
  );
}

export function selectDesktopRelease<T extends { available: boolean }>(
  candidates: readonly [T, ...T[]],
): T {
  return candidates.find((candidate) => candidate.available) ?? candidates[candidates.length - 1];
}
