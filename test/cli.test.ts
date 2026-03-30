import path from "node:path";
import { describe, test } from "vitest";
import { runCli } from "../src/cli";
import { basePath, sampleHar } from "./test-utils";

type HarnessOptions = {
  stdinIsTTY?: boolean;
  stdinText?: string;
};

const createHarness = (files: Record<string, string>, options: HarnessOptions = {}) => {
  const cwd = "/virtual";
  const stdout: string[] = [];
  const stderr: string[] = [];
  const directories: string[] = [];
  const writes = new Map<string, string>();

  return {
    cwd,
    directories,
    writes,
    readOutput: () => stdout.join(""),
    readErrors: () => stderr.join(""),
    dependencies: {
      cwd,
      stdinIsTTY: options.stdinIsTTY ?? true,
      readStdin: async () => options.stdinText ?? "",
      readTextFile: async (filePath: string) => {
        const file = files[filePath];
        if (file === undefined) {
          throw new Error(`ENOENT: ${filePath}`);
        }
        return file;
      },
      writeTextFile: async (filePath: string, contents: string) => {
        writes.set(filePath, contents);
      },
      ensureDir: async (directoryPath: string) => {
        directories.push(directoryPath);
      },
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
};

describe("CLI", async () => {
  test("prints a YAML spec to stdout for a single HAR", async ({ expect }) => {
    const harness = createHarness({
      [path.join("/virtual", "capture.har")]: JSON.stringify(sampleHar()),
    });

    const exitCode = await runCli(["capture.har"], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.readErrors()).toBe("");
    expect(harness.readOutput()).toContain("openapi:");
    expect(harness.readOutput()).toContain("HarToOpenApi");
  });

  test("writes a JSON spec to an output file", async ({ expect }) => {
    const harness = createHarness({
      [path.join("/virtual", "capture.har")]: JSON.stringify(sampleHar()),
    });
    const outputPath = path.join("/virtual", "openapi.json");

    const exitCode = await runCli(["capture.har", "--format", "json", "--output", "openapi.json"], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.readOutput()).toBe("");
    expect(harness.readErrors()).toBe("");
    expect(harness.writes.has(outputPath)).toBe(true);
    expect(JSON.parse(harness.writes.get(outputPath)!)).toMatchObject({
      info: {
        title: "HarToOpenApi",
      },
      openapi: "3.0.0",
    });
  });

  test("writes one file per domain in multi-spec mode", async ({ expect }) => {
    const harness = createHarness({
      [path.join("/virtual", "capture.har")]: JSON.stringify(basePath()),
    });
    const outputDir = path.join("/virtual", "generated");

    const exitCode = await runCli(["capture.har", "--multi-spec", "--output-dir", "generated"], harness.dependencies);

    expect(exitCode).toBe(0);
    expect(harness.directories).toEqual([outputDir]);
    expect([...harness.writes.keys()].sort()).toEqual(
      [path.join(outputDir, "example.com.yaml"), path.join(outputDir, "exampletwo.com.yaml")].sort(),
    );
  });

  test("reads HAR from stdin and merges config from a JSON file", async ({ expect }) => {
    const harness = createHarness(
      {
        [path.join("/virtual", "har-to-openapi.config.json")]: JSON.stringify({
          forceAllRequestsInSameSpec: true,
        }),
      },
      {
        stdinIsTTY: false,
        stdinText: JSON.stringify(basePath()),
      },
    );

    const exitCode = await runCli(["--config", "har-to-openapi.config.json", "--multi-spec", "--format", "json"], harness.dependencies);
    const output = JSON.parse(harness.readOutput());

    expect(exitCode).toBe(0);
    expect(harness.readErrors()).toBe("");
    expect(output).toHaveLength(1);
  });

  test("rejects incompatible output options", async ({ expect }) => {
    const harness = createHarness({
      [path.join("/virtual", "capture.har")]: JSON.stringify(basePath()),
    });

    const exitCode = await runCli(["capture.har", "--multi-spec", "--output", "openapi.yaml"], harness.dependencies);

    expect(exitCode).toBe(1);
    expect(harness.readOutput()).toBe("");
    expect(harness.readErrors()).toContain("--multi-spec cannot be combined with --output");
  });
});
