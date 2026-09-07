import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli.js";

const capture = (name = "Ada") =>
  JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "cli-input-test", version: "1" },
      entries: [
        {
          request: { method: "GET", url: "https://api.example.com/users", headers: [], queryString: [] },
          response: {
            status: 200,
            statusText: "OK",
            headers: [],
            content: { mimeType: "application/json", text: JSON.stringify({ name }) },
          },
        },
      ],
    },
  });

const harness = (config = "{}") => ({
  cwd: "/workspace",
  stdinIsTTY: true,
  readTextFile: vi.fn(async (filePath: string) => (filePath.endsWith("config.json") ? config : capture())),
  stdout: vi.fn(),
  stderr: vi.fn(),
  ensureDir: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async () => undefined),
});

describe("CLI input regressions", () => {
  test("preserves UTF-8 characters split across stdin chunks", async () => {
    const name = "Café 🌍";
    const input = Buffer.from(capture(name));
    const chunks = Readable.from(Array.from(input, (byte) => Buffer.from([byte])));
    const stdin = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(() => chunks[Symbol.asyncIterator]());
    const io = harness();
    try {
      expect(await runCli(["-", "--format", "json"], io)).toBe(0);
      const spec = JSON.parse(io.stdout.mock.calls[0][0]);
      expect(spec.paths["/users"].get.responses[200].content["application/json"].example).toEqual({ name });
    } finally {
      stdin.mockRestore();
      chunks.destroy();
    }
  });

  test("rejects an output directory without multi-spec mode", async () => {
    const io = harness();
    expect(await runCli(["capture.har", "--output-dir", "generated"], io)).toBe(1);
    expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("--output-dir requires --multi-spec"));
    expect(io.stdout).not.toHaveBeenCalled();
    expect(io.readTextFile).not.toHaveBeenCalled();
  });

  test.each(["--toString", "--constructor", "--__proto__", "--no-toString", "--no-constructor", "--no-__proto__"])(
    "rejects inherited object properties as flags: %s",
    async (flag) => {
      const io = harness();
      expect(await runCli(["capture.har", flag], io)).toBe(1);
      expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining(`Unknown option "${flag}"`));
      expect(io.stdout).not.toHaveBeenCalled();
      expect(io.readTextFile).not.toHaveBeenCalled();
    },
  );

  test.each([
    { urlFilter: {} },
    { urlFilter: true },
    { tags: "users" },
    { tags: [42] },
    { tags: [["users", 42]] },
    { tags: [[]] },
    { tags: [["users", "Users", "extra"]] },
  ])("reports malformed filtering or tagging configuration before processing entries: %j", async (config) => {
    const io = harness(JSON.stringify(config));
    expect(await runCli(["capture.har", "--config", "config.json", "--report", "-"], io)).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    const report = JSON.parse(io.stderr.mock.calls[0][0]);
    expect(report.processedEntries).toBe(0);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "invalid-config",
        message: expect.stringContaining(Object.keys(config)[0]),
      }),
    ]);
  });
});
