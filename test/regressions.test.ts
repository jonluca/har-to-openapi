import path from "node:path";
import type { Har } from "har-format";
import { describe, test, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { generateSpec } from "../src/index.js";
import { typedParamsHar } from "./test-utils.js";

const harWithUrls = (urls: string[]): Har => {
  const fixture = typedParamsHar();
  const template = fixture.log.entries[0];
  fixture.log.entries = urls.map((url, index) => {
    const entry = structuredClone(template);
    entry.request.url = url;
    entry.request.queryString = Array.from(new URL(url).searchParams, ([name, value]) => ({ name, value }));
    entry.index = index;
    return entry;
  });
  return fixture;
};

describe("Confirmed bug regressions", () => {
  test("does not decode already-decoded percent query values or discard their responses", async ({ expect }) => {
    const har = harWithUrls(["https://api.example.com/search?marker=%25"]);
    const output = await generateSpec(har);

    expect(output.spec.paths["/search"].get.parameters).toContainEqual(
      expect.objectContaining({ name: "marker", example: "%" }),
    );
    expect(output.spec.paths["/search"].get.responses["200"]).toHaveProperty("content.application/json");
  });

  test("keeps unsafe integer query examples exact by inferring them as strings", async ({ expect }) => {
    const har = harWithUrls(["https://api.example.com/items?id=9007199254740993"]);
    const output = await generateSpec(har);
    const id = output.spec.paths["/items"].get.parameters.find(
      (parameter: { name?: string }) => parameter.name === "id",
    );

    expect(id).toEqual(
      expect.objectContaining({
        example: "9007199254740993",
        schema: { type: "string", default: "9007199254740993" },
      }),
    );
  });

  test("preserves every captured origin, including non-default ports", async ({ expect }) => {
    const har = harWithUrls(["https://api.example.com:8443/one", "http://api.example.com:8080/two"]);
    const output = await generateSpec(har);

    expect(output.spec.servers).toEqual([
      { url: "https://api.example.com:8443" },
      { url: "http://api.example.com:8080" },
    ]);
  });

  test("makes operation IDs unique when distinct paths have the same generated name", async ({ expect }) => {
    const har = harWithUrls(["https://api.example.com/users/123", "https://api.example.com/users/456"]);
    const output = await generateSpec(har);
    const operationIds = Object.values(output.spec.paths).map((pathItem) => pathItem.get.operationId);

    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  test("writes distinct reversible filenames for IPv6 domains", async ({ expect }) => {
    const har = harWithUrls(["https://[2001:db8::1]/one", "https://[2001:db8::2]/two"]);
    const writtenFiles: string[] = [];
    const stderr = vi.fn();
    const exitCode = await runCli(["capture.har", "--multi-spec", "--output-dir", "out"], {
      cwd: "/workspace",
      stdinIsTTY: true,
      readTextFile: async () => JSON.stringify(har),
      ensureDir: async () => undefined,
      writeTextFile: async (filePath) => {
        writtenFiles.push(path.basename(filePath));
      },
      stdout: vi.fn(),
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(writtenFiles.sort()).toEqual(["%5B2001%3Adb8%3A%3A1%5D.yaml", "%5B2001%3Adb8%3A%3A2%5D.yaml"]);
  });
});
