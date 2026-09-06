import path from "node:path";
import type { Har } from "har-format";
import { describe, expect, test } from "vitest";

import { runCli } from "../src/cli.js";
import { generateSpec } from "../src/index.js";
import { parameterizeUrl } from "../src/utils/string.js";

const entry = ({
  method = "GET",
  url,
  headers = [],
  queryString = [],
}: {
  method?: string;
  url: string;
  headers?: Array<{ name: string; value: string }>;
  queryString?: Array<{ name: string; value: string }>;
}) => ({
  startedDateTime: "2025-01-01T00:00:00.000Z",
  time: 1,
  request: {
    method,
    url,
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers,
    queryString,
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status: 200,
    statusText: "OK",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [{ name: "Content-Type", value: "application/json" }],
    content: { size: 11, mimeType: "application/json", text: '{"ok":true}' },
    redirectURL: "",
    headersSize: -1,
    bodySize: 11,
  },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});

const har = (...entries: ReturnType<typeof entry>[]) =>
  ({
    log: {
      version: "1.2",
      creator: { name: "witness", version: "1.0" },
      entries,
    },
  }) as unknown as Har;

describe("definite bug regressions", () => {
  test("keeps successful relaxed methods when filtering failed paths", async () => {
    const result = await generateSpec(har(entry({ method: "CUSTOM", url: "https://api.example.com/login" })), {
      relaxedMethods: true,
      dropPathsWithoutSuccessfulResponse: true,
    });

    expect(result.spec.paths["/login"].custom.responses[200].content?.["application/json"]).toBeDefined();
  });

  test("counts every numeric character when parameterizing decimal paths", () => {
    expect(parameterizeUrl("/category/1.2", 2).path).toBe("/category/{id}");
    expect(parameterizeUrl("/measurements/12.3").path).toBe("/measurements/{id}");
  });

  test("does not decode URL query values twice", async () => {
    const result = await generateSpec(
      har(
        entry({
          url: "https://api.example.com/items?q=100%25",
          queryString: [{ name: "q", value: "100%25" }],
        }),
      ),
    );

    expect(result.spec.paths["/items"].get.responses[200].content?.["application/json"]).toBeDefined();
  });

  test("filters the standard Priority request header", async () => {
    const result = await generateSpec(
      har(entry({ url: "https://api.example.com/items", headers: [{ name: "Priority", value: "u=0" }] })),
    );
    const parameters = result.spec.paths["/items"].get.parameters ?? [];

    expect(parameters.some((parameter) => "name" in parameter && parameter.name === "Priority")).toBe(false);
  });

  test("writes IPv6 domains to distinct reversible filenames", async () => {
    const input = har(entry({ url: "http://[2001:db8::1:2]/alpha" }), entry({ url: "http://[2001:db8:1::2]/beta" }));
    const writtenPaths: string[] = [];
    const exitCode = await runCli(["capture.har", "--multi-spec", "--output-dir", "generated"], {
      cwd: "/tmp/har-to-openapi-test",
      stdinIsTTY: true,
      readStdin: async () => "",
      readTextFile: async () => JSON.stringify(input),
      ensureDir: async () => undefined,
      writeTextFile: async (filePath) => {
        writtenPaths.push(filePath);
      },
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(writtenPaths.map((filePath) => path.basename(filePath))).toEqual([
      "%5B2001%3Adb8%3A%3A1%3A2%5D.yaml",
      "%5B2001%3Adb8%3A1%3A%3A2%5D.yaml",
    ]);
  });
});
