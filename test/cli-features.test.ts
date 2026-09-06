import type { Har } from "har-format";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../src/cli.js";

const capture = (url: string, body: unknown = { id: 1 }): Har =>
  ({
    log: {
      version: "1.2",
      creator: { name: "cli-test", version: "1" },
      entries: [
        {
          request: {
            method: "GET",
            url,
            headers: [],
            queryString: Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value })),
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: [{ name: "content-type", value: "application/json" }],
            content: { mimeType: "application/json", text: JSON.stringify(body), size: 10 },
          },
        },
      ],
    },
  }) as unknown as Har;

const harness = (files: Record<string, Har | string>, stdin?: Har) => {
  const written = new Map<string, string>();
  const stdout = vi.fn();
  const stderr = vi.fn();
  const readStdin = vi.fn(async () => JSON.stringify(stdin));
  const dependencies = {
    cwd: "/workspace",
    stdinIsTTY: stdin === undefined,
    readStdin,
    readTextFile: async (filePath: string) => {
      const value = files[filePath.replace("/workspace/", "")];
      if (value === undefined) throw new Error(`File not found: ${filePath}`);
      return typeof value === "string" ? value : JSON.stringify(value);
    },
    writeTextFile: async (filePath: string, contents: string) => {
      written.set(filePath, contents);
    },
    ensureDir: async () => undefined,
    stdout,
    stderr,
  };
  return { dependencies, stdout, stderr, written, readStdin };
};

describe("CLI generation features", () => {
  test("merges files and stdin and reports all capture observations", async () => {
    const io = harness(
      { "first.har": capture("https://api.example.com/users", { id: 1 }) },
      capture("https://api.example.com/users", { id: 2, name: "Ada" }),
    );
    const exitCode = await runCli(["first.har", "-", "--format", "json", "--report", "report.json"], io.dependencies);

    expect(exitCode).toBe(0);
    expect(io.readStdin).toHaveBeenCalledOnce();
    const spec = JSON.parse(io.stdout.mock.calls[0][0]);
    const schema = spec.paths["/users"].get.responses[200].content["application/json"].schema;
    expect(schema.properties).toHaveProperty("id");
    expect(schema.properties).toHaveProperty("name");
    expect(JSON.parse(io.written.get("/workspace/report.json")!)).toMatchObject({
      inputCount: 2,
      totalEntries: 2,
      processedEntries: 2,
      failedEntries: 0,
      operations: 1,
      specs: 1,
    });
  });

  test("applies YAML config, CLI overrides, and a separate YAML overlay", async () => {
    const io = harness({
      "capture.har": capture("https://api.example.com/users", { id: 1, token: "secret" }),
      "config.yaml": `reusableSchemas: true
schemaNames:
  /paths/~1users/get/responses/200/content/application~1json/schema: User
examples: multiple
overlay:
  overlay: 1.0.0
  info: {title: Inline, version: 1.0.0}
  actions:
    - target: $.paths['/users'].get
      update: {summary: Inline overlay}
`,
      "overlay.yaml": `overlay: 1.0.0
info: {title: Customizations, version: 1.0.0}
actions:
  - target: $.paths['/users'].get
    update: {operationId: listUsers, summary: List visible users}
`,
    });
    const exitCode = await runCli(
      [
        "capture.har",
        "--config",
        "config.yaml",
        "--overlay",
        "overlay.yaml",
        "--examples",
        "none",
        "--requiredness",
        "observed",
        "--include-inference-evidence",
        "--format",
        "json",
      ],
      io.dependencies,
    );

    expect(exitCode).toBe(0);
    const spec = JSON.parse(io.stdout.mock.calls[0][0]);
    expect(spec.paths["/users"].get).toMatchObject({ operationId: "listUsers", summary: "List visible users" });
    const media = spec.paths["/users"].get.responses[200].content["application/json"];
    expect(media.schema.allOf[0]).toHaveProperty("$ref", "#/components/schemas/User");
    expect(media).not.toHaveProperty("example");
    expect(media).not.toHaveProperty("examples");
    expect(spec.components.schemas.User.required).toContain("id");
    expect(JSON.stringify(spec)).toContain("x-har-observations");
    expect(JSON.stringify(spec)).not.toContain("secret");
  });

  test("bounds multiple examples and masks configured captured fields", async () => {
    const io = harness({
      "one.har": capture("https://api.example.com/users", { id: 1, token: "first-secret" }),
      "two.har": capture("https://api.example.com/users", { id: 2, token: "second-secret" }),
      "config.json": JSON.stringify({ redact: { bodyProperties: ["token"] } }),
    });
    const exitCode = await runCli(
      [
        "one.har",
        "two.har",
        "--examples",
        "multiple",
        "--max-examples",
        "1",
        "--max-example-bytes",
        "1024",
        "--config",
        "config.json",
        "--format",
        "json",
      ],
      io.dependencies,
    );

    expect(exitCode).toBe(0);
    const output = io.stdout.mock.calls[0][0];
    const spec = JSON.parse(output);
    const examples = spec.paths["/users"].get.responses[200].content["application/json"].examples;
    expect(Object.values(examples)).toHaveLength(1);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("first-secret");
    expect(output).not.toContain("second-secret");
  });

  test("keeps reports on stderr separate from spec stdout", async () => {
    const io = harness({}, capture("https://api.example.com/users"));
    const exitCode = await runCli(["--format", "json", "--strict", "--report", "-"], io.dependencies);

    expect(exitCode, io.stderr.mock.calls.map(([message]) => message).join("\n")).toBe(0);
    expect(JSON.parse(io.stdout.mock.calls[0][0])).toHaveProperty("openapi");
    expect(JSON.parse(io.stderr.mock.calls[0][0])).toMatchObject({ inputCount: 1, operations: 1, specs: 1 });
  });

  test("writes a report with source locations when strict conversion fails", async () => {
    const malformed = capture("https://api.example.com/users");
    malformed.log.entries[0].response.content.text = "{invalid json";
    const io = harness({ "broken.har": malformed });
    const exitCode = await runCli(["broken.har", "--strict", "--report", "failed.json"], io.dependencies);

    expect(exitCode).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    const report = JSON.parse(io.written.get("/workspace/failed.json")!);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ inputIndex: 0, entryIndex: 0, sourceName: "broken.har" }),
        }),
      ]),
    );
  });

  test("writes the report when strict multi-spec conversion produces no output", async () => {
    const empty = capture("https://api.example.com/users");
    empty.log.entries = [];
    const io = harness({ "empty.har": empty });
    expect(await runCli(["empty.har", "--multi-spec", "--strict", "--report", "empty.json"], io.dependencies)).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(io.written.get("/workspace/empty.json")!)).toMatchObject({ totalEntries: 0, specs: 0 });
  });

  test("reports malformed and unreadable inputs without exposing captured content", async () => {
    const io = harness({
      "valid.har": capture("https://api.example.com/users"),
      "broken.har": '{"token":"private-captured-value"',
    });
    expect(
      await runCli(["valid.har", "broken.har", "missing.har", "--strict", "--report", "inputs.json"], io.dependencies),
    ).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    const reportContents = io.written.get("/workspace/inputs.json")!;
    expect(JSON.parse(reportContents)).toMatchObject({
      inputCount: 3,
      totalEntries: 0,
      processedEntries: 0,
      operations: 0,
      specs: 0,
      diagnostics: [
        { code: "invalid-har-json", source: { inputIndex: 1, sourceName: "broken.har" } },
        { code: "input-read-failed", source: { inputIndex: 2, sourceName: "missing.har" } },
      ],
    });
    expect(reportContents).not.toContain("private-captured-value");
    expect(io.stderr.mock.calls.flat().join("\n")).not.toContain("private-captured-value");
  });

  test("validates the final document after applying an overlay", async () => {
    const io = harness({
      "capture.har": capture("https://api.example.com/users"),
      "invalid-overlay.json": JSON.stringify({
        overlay: "1.0.0",
        info: { title: "Invalid version", version: "1.0.0" },
        actions: [{ target: "$.info", update: { version: 123 } }],
      }),
    });
    expect(
      await runCli(
        ["capture.har", "--overlay", "invalid-overlay.json", "--validate", "--report", "invalid.json"],
        io.dependencies,
      ),
    ).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(JSON.parse(io.written.get("/workspace/invalid.json")!).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "error" })]),
    );
  });

  test("exposes repeated-key and bracket parameter controls", async () => {
    const io = harness({
      "capture.har": capture("https://api.example.com/users?tag=a&tag=b&filter[name]=Ada"),
    });
    expect(await runCli(["capture.har", "--parse-bracket-parameters", "--format", "json"], io.dependencies)).toBe(0);
    const spec = JSON.parse(io.stdout.mock.calls[0][0]);
    expect(spec.paths["/users"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tag", schema: expect.objectContaining({ type: "array" }) }),
        expect.objectContaining({ name: "filter", style: "deepObject" }),
      ]),
    );
    io.stdout.mockClear();
    expect(await runCli(["capture.har", "--no-infer-array-parameters", "--format", "json"], io.dependencies)).toBe(0);
    expect(JSON.parse(io.stdout.mock.calls[0][0]).paths["/users"].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "tag", schema: expect.objectContaining({ type: "string" }) }),
        expect.objectContaining({ name: "filter[name]" }),
      ]),
    );
  });

  test.each([
    ["--examples", "unknown"],
    ["--requiredness", "always"],
    ["--max-examples", "0"],
    ["--max-example-bytes", "1.5"],
    ["--max-example-bytes", "Infinity"],
    ["--report"],
    ["-", "-"],
    ["--report", "same.json", "--output", "same.json"],
  ])("rejects invalid arguments %j", async (...args: string[]) => {
    const io = harness({ "capture.har": capture("https://api.example.com/users") });
    expect(await runCli(["capture.har", ...args], io.dependencies)).toBe(1);
    expect(io.stdout).not.toHaveBeenCalled();
    expect(io.stderr).toHaveBeenCalled();
  });
});
