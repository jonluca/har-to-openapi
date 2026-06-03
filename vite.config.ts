import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: process.env,
    environment: "node",
    dir: "test",
    watch: false,
    passWithNoTests: true,
    reporters: ["verbose"],
    // These snapshots also include the complete YAML spec, so keep the object view compact.
    snapshotFormat: {
      maxOutputLength: 1_000_000,
    },
    coverage: {
      reporter: ["json", "text", "html", "lcov"],
      provider: "v8",
    },
    deps: {
      interopDefault: true,
    },
    testTimeout: 60 * 1000 * 60,
  },
});
