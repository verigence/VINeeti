import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // Each file builds its own in-memory database; password hashing makes the first requests slow.
    hookTimeout: 60_000,
  },
});
