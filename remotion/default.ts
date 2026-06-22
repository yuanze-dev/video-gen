import { makeDefaultConfig } from "../lib/config-schema";
import { resolveConfig } from "../lib/resolved";

// Default props for the Remotion Studio / Composition fallback (all built-in).
export const defaultResolvedConfig = resolveConfig(makeDefaultConfig(), {});
