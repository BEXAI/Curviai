import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@curvi/ui", "@curvi/specs", "@curvi/db", "@curvi/pipeline", "@curvi/ai"],
  serverExternalPackages: ["sharp", "exiftool-vendored", "archiver", "postgres"],
  eslint: {
    // Linting runs at the repo root with the shared flat config.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
