// electron-builder afterSign hook: notarize + staple the signed .app.
//
// Credentials are read from the environment so no secret is ever hard-coded.
// Priority:
//   1. NOTARY_PROFILE                -> a `xcrun notarytool store-credentials` keychain profile
//   2. APPLE_API_KEY/_ID/_ISSUER     -> App Store Connect API key (.p8 path)
//   3. APPLE_ID/_APP_SPECIFIC_PASSWORD/_TEAM_ID -> Apple ID + app-specific password
// If none are present the hook skips notarization (used for signed-only builds).
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileP = promisify(execFile);

exports.default = async function notarizing(context) {
  if (context.electronPlatformName !== "darwin") return;

  const env = process.env;
  const profile = env.NOTARY_PROFILE;
  const hasApiKey = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
  const hasAppleId = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;

  if (!profile && !hasApiKey && !hasAppleId) {
    console.log("  • notarize: skipped — no credentials in env (signed-only build)");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;

  const { notarize } = require("@electron/notarize");
  const base = { tool: "notarytool", appPath };
  const opts = profile
    ? { ...base, keychainProfile: profile }
    : hasApiKey
      ? {
          ...base,
          appleApiKey: env.APPLE_API_KEY,
          appleApiKeyId: env.APPLE_API_KEY_ID,
          appleApiIssuer: env.APPLE_API_ISSUER,
        }
      : {
          ...base,
          appleId: env.APPLE_ID,
          appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
          teamId: env.APPLE_TEAM_ID,
        };

  console.log(`  • notarize: submitting ${appName}.app to Apple…`);
  await notarize(opts);
  // Staple the ticket so Gatekeeper passes offline.
  await execFileP("xcrun", ["stapler", "staple", appPath]);
  console.log("  • notarize: done + stapled");
};
