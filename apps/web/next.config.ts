import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  transpilePackages: ["@curvi/ui", "@curvi/specs", "@curvi/db", "@curvi/pipeline", "@curvi/ai", "@curvi/trigger"],
  serverExternalPackages: ["sharp", "exiftool-vendored", "archiver", "postgres", "@trigger.dev/sdk"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // serverExternalPackages only externalizes imports issued from
      // node_modules. The inline pack runner is transpiled workspace source
      // (@curvi/trigger -> @curvi/pipeline) whose native and SDK imports must
      // stay require() calls at runtime.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        {
          sharp: "commonjs sharp",
          "exiftool-vendored": "commonjs exiftool-vendored",
          archiver: "commonjs archiver",
          postgres: "commonjs postgres",
          "@trigger.dev/sdk/v3": "commonjs @trigger.dev/sdk/v3",
          "@aws-sdk/client-s3": "commonjs @aws-sdk/client-s3",
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
