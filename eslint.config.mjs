import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "cli/dist/**",
    "electron/dist/**",
    "packages/littlestart-cli/dist/**",
    "packages/littlestart-cli/runtime/**",
    "packages/littlestart-cli/*.cjs",
    "public/remotion-site/**",
    "release/**",
    // Node tests bundle subjects into short-lived hidden directories below
    // the repository. Ignoring them prevents eslint's directory walk racing
    // the test cleanup and keeps generated bundles out of source lint.
    ".*-test-*/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
