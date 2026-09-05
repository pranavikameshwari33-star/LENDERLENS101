import type { NextConfig } from "next";

/**
 * The compiled entity index and the model artifacts are read from disk at
 * request time with `fs.readFileSync`, which the bundler cannot see. Without
 * these entries the files are left out of a standalone or serverless build and
 * every verification fails at runtime with "not built" — on the deployed site
 * only, which is the worst place to discover it.
 *
 * The raw XLSX workbooks are deliberately NOT included. They are build-time
 * inputs to `npm run build:data`; nothing reads them on a request.
 */
const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/**": [
      "./data/index/entity-index.json",
      "./ml/artifacts/model.json",
      "./ml/artifacts/metrics.json",
    ],
  },

  /**
   * Security headers. The application serves no third-party script, embeds
   * nothing, and posts nowhere, so the policy can be strict. `unsafe-inline`
   * for styles is required by Next's own inlined critical CSS.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
