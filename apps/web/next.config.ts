import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["@curvi/ui", "@curvi/specs", "@curvi/db", "@curvi/pipeline", "@curvi/ai", "@curvi/trigger"],
  serverExternalPackages: ["sharp", "exiftool-vendored", "archiver", "postgres"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // The ESM @curvi/trigger graph pulls these through transpiled packages;
      // keep the native modules as runtime requires instead of bundling them.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        {
          sharp: "commonjs sharp",
          "exiftool-vendored": "commonjs exiftool-vendored",
          archiver: "commonjs archiver",
          postgres: "commonjs postgres",
        },
      ];
    }
    return config;
  },
  eslint: {
    // Linting runs at the repo root with the shared flat config.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
