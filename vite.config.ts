import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    dir: "test",
    update: true,
    watch: false,
  },
});
