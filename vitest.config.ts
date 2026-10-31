import { defineConfig } from "vitest/config";

export default defineConfig({
  // The Worker's own modules have no Node equivalent; the suite runs against a stub that refuses to be used.
  resolve: { alias: { "cloudflare:sockets": new URL("./test/stubs/cloudflare-sockets.ts", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // Each file builds its own in-memory database; password hashing makes the first requests slow.
    hookTimeout: 60_000,
  },
});
