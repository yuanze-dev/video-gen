import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the heavy Remotion server packages out of the Next bundle; they are
  // required at runtime from node_modules by the render API route.
  serverExternalPackages: ["@remotion/bundler", "@remotion/renderer"],
};

export default nextConfig;
