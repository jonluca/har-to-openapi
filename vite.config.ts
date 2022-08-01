import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    dir: "test",
    watch: false,
    threads: false,
    testTimeout: 5000,
    isolate: true,
    passWithNoTests: true,
  },
});
