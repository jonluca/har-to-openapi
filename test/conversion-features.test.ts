import type { Entry, Har } from "har-format";
import { describe, expect, test } from "vitest";
import { ConversionError, generateSpec, generateSpecs, generateSpecsWithReport } from "../src/index.js";
import type { ConversionReport, HarToOpenAPIConfig } from "../src/index.js";

const entry = (url: string, body: unknown = { id: 1 }, method = "GET", requestBody?: unknown): Entry =>
  ({
    request: {
      url,
      method,
      headers: [],
      queryString: [],
      cookies: [],
      ...(requestBody !== undefined
        ? { postData: { mimeType: "application/json", text: JSON.stringify(requestBody) } }
        : {}),
    },
    response: {
      status: 200,
      headers: [],
      cookies: [],
      content: { mimeType: "application/json", text: JSON.stringify(body), size: 12 },
    },
  }) as unknown as Entry;
const capture = (...entries: Entry[]): Har => ({ log: { entries } }) as Har;

describe("Capture merging and conversion reports", () => {
  test("merges observations across files and preserves domain separation", async () => {
    const inputs = [
      capture(entry("https://api.test/users", { id: 1 })),
      capture(entry("https://api.test/users", { name: "Ada" }), entry("https://other.test/items")),
    ];
    const { specs, report } = await generateSpecsWithReport(inputs, { examples: "multiple" });
    expect(specs).toHaveLength(2);
    const media = specs[0].spec.paths["/users"].get!.responses[200].content!["application/json"];
    expect(media.schema!.properties).toHaveProperty("id");
    expect(media.schema!.properties).toHaveProperty("name");
    expect(Object.keys(media.examples!)).toHaveLength(2);
    expect(report).toMatchObject({
      inputCount: 2,
      totalEntries: 3,
      processedEntries: 3,
      filteredEntries: 0,
      failedEntries: 0,
      operations: 2,
      specs: 2,
    });
  });

  test("reports every skipped or invalid entry with its original source index", async () => {
    const malformed = { request: {} } as Entry;
    const { report } = await generateSpecsWithReport(
      [
        capture(entry("https://api.test/users"), entry("not a URL"), malformed),
        capture(entry("https://ignored.test/items"), entry("https://api.test/custom", {}, "CUSTOM")),
      ],
      { includeDomains: ["api.test"], sourceNames: ["login.har", "browse.har"] },
    );
    expect(report).toMatchObject({ totalEntries: 5, processedEntries: 1, failedEntries: 2, filteredEntries: 2 });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid-url",
          source: { inputIndex: 0, entryIndex: 1, sourceName: "login.har" },
        }),
        expect.objectContaining({
          code: "invalid-entry",
          source: { inputIndex: 0, entryIndex: 2, sourceName: "login.har" },
        }),
        expect.objectContaining({
          code: "domain-filtered",
          source: { inputIndex: 1, entryIndex: 0, sourceName: "browse.har" },
        }),
        expect.objectContaining({
          code: "method-filtered",
          source: { inputIndex: 1, entryIndex: 1, sourceName: "browse.har" },
        }),
      ]),
    );
  });

  test("keeps reports available for invalid or empty input and strict failures", async () => {
    const reports: ConversionReport[] = [];
    await expect(
      generateSpecs({} as Har, { strict: true, onReport: (report) => reports.push(report) }),
    ).rejects.toBeInstanceOf(ConversionError);
    expect(reports[0].diagnostics.map((d) => d.code)).toEqual(["invalid-har", "no-specs"]);
    const empty = await generateSpec(capture(), { includeReport: true });
    expect(empty.report).toMatchObject({ totalEntries: 0, specs: 0 });
    expect(empty.spec.paths).toEqual({});
  });

  test("strict mode rejects fallback inference with source provenance and no captured values in diagnostics", async () => {
    const sample = entry("https://api.test/users");
    sample.response.content.text = '{"password":"secret-value"';
    let failure: ConversionError | undefined;
    try {
      await generateSpecs(capture(sample), { strict: true, sourceNames: ["capture.har"] });
    } catch (error) {
      failure = error as ConversionError;
    }
    expect(failure).toBeInstanceOf(ConversionError);
    expect(failure!.report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "schema-fallback",
        level: "warning",
        source: { inputIndex: 0, entryIndex: 0, sourceName: "capture.har" },
      }),
    );
    expect(JSON.stringify(failure!.report)).not.toContain("secret-value");
  });

  test("does not mutate input captures, including base64 content", async () => {
    const sample = entry("https://api.test/users");
    sample.response.content.text = Buffer.from('{"id":123}').toString("base64");
    sample.response.content.encoding = "base64";
    const input = capture(sample);
    const original = structuredClone(input);
    await generateSpec(input, { reusableSchemas: true, examples: "none" });
    expect(input).toEqual(original);
  });

  test("malformed entries cannot leave partial operations in generated output", async () => {
    const malformed = entry("https://api.test/broken");
    malformed.request.headers = [null] as unknown as Entry["request"]["headers"];
    const { specs, report } = await generateSpecsWithReport(capture(malformed, entry("https://api.test/valid")));
    expect(report).toMatchObject({ processedEntries: 1, failedEntries: 1, operations: 1, specs: 1 });
    expect(Object.keys(specs[0].spec.paths)).toEqual(["/valid"]);
  });
});

describe("Inference, customization and validation together", () => {
  test.each([
    { target: "$", update: { openapi: 123 } },
    { target: "$", update: { paths: null } },
    { target: "$.paths['/users'].get", update: { parameters: [{ $ref: 123 }] } },
    {
      target: "$.paths['/users'].get.responses['200'].content['application/json'].schema",
      update: { $ref: "#/info/title" },
    },
  ])("invalid overlay output fails through ConversionError and delivers the report: $target", async (action) => {
    const reports: ConversionReport[] = [];
    await expect(
      generateSpec(capture(entry("https://api.test/users")), {
        validate: true,
        onReport: (report) => reports.push(report),
        overlay: { overlay: "1.0.0", info: { title: "Invalid output", version: "1" }, actions: [action] },
      }),
    ).rejects.toBeInstanceOf(ConversionError);
    expect(reports).toHaveLength(1);
    expect(reports[0].diagnostics.some((d) => d.code === "validation-failed")).toBe(true);
  });

  test("counts query/header/body presence across every operation sample", async () => {
    const first = entry("https://api.test/users?limit=10", {}, "POST", { id: 1, name: "Ada" });
    first.request.headers = [{ name: "X-Trace", value: "abc" }];
    const second = entry("https://api.test/users", {}, "POST");
    const { spec } = await generateSpec([capture(first), capture(second)], {
      requiredness: "observed",
      includeInferenceEvidence: true,
    });
    const operation = spec.paths["/users"].post!;
    expect(operation.requestBody).toMatchObject({ required: false });
    expect(operation["x-har-observations"]).toEqual({ sampleCount: 2, requestBodyCount: 1 });
    for (const parameter of operation.parameters!) {
      expect(parameter).toMatchObject({
        required: false,
        "x-har-observations": { sampleCount: 2, present: 1, ratio: 0.5 },
      });
    }
  });

  test.each(["3.0.0", "3.1.0"] as const)(
    "validates %s output with components, arrays, examples, redaction and overlays",
    async (openapiVersion) => {
      const pointer = "/paths/~1users/get/responses/200/content/application~1json/schema";
      const config: HarToOpenAPIConfig = {
        openapiVersion,
        strict: true,
        reusableSchemas: true,
        schemaNames: { [pointer]: "User" },
        examples: "multiple",
        includeInferenceEvidence: true,
        requiredness: "observed",
        redact: { bodyProperties: ["password"], queryParameters: ["token"] },
        overlay: {
          overlay: "1.0.0",
          info: { title: "Docs", version: "1" },
          actions: [
            {
              target: "$.paths['/users'].get",
              update: { operationId: "listUsers", description: "List captured users." },
            },
          ],
        },
      };
      const { spec } = await generateSpec(
        [
          capture(
            entry("https://api.test/users?tag=a&tag=b&token=private-token", { id: 1, password: "private-password" }),
          ),
          capture(entry("https://api.test/users?tag=c", { id: 2, password: "another-password" })),
        ],
        config,
      );
      expect(spec.components!.schemas).toHaveProperty("User");
      expect(spec.paths["/users"].get!.operationId).toBe("listUsers");
      expect(spec.paths["/users"].get!.parameters).toContainEqual(
        expect.objectContaining({ name: "tag", schema: expect.objectContaining({ type: "array" }) }),
      );
      expect(JSON.stringify(spec)).not.toContain("private-token");
      expect(JSON.stringify(spec)).not.toContain("private-password");
    },
  );

  test("validates overlay output and rejects duplicate operation IDs", async () => {
    const input = capture(entry("https://api.test/users"), entry("https://api.test/items"));
    const config: HarToOpenAPIConfig = {
      validate: true,
      overlay: {
        overlay: "1.0.0",
        info: { title: "Invalid IDs", version: "1" },
        actions: [{ target: "$.paths.*.get", update: { operationId: "duplicate" } }],
      },
    };
    await expect(generateSpec(input, config)).rejects.toThrow("operationId must be unique");
  });

  test("rejects unmatched overlays even without strict mode", async () => {
    await expect(
      generateSpec(capture(entry("https://api.test/users")), {
        overlay: {
          overlay: "1.0.0",
          info: { title: "Stale", version: "1" },
          actions: [{ target: "$.paths['/missing']", update: { summary: "Missing" } }],
        },
      }),
    ).rejects.toBeInstanceOf(ConversionError);
  });

  test("checks path parameter bindings after customizations", async () => {
    await expect(
      generateSpec(capture(entry("https://api.test/users")), {
        validate: true,
        overlay: {
          overlay: "1.0.0",
          info: { title: "Paths", version: "1" },
          actions: [
            {
              target: "$.paths",
              update: {
                "/users/{userId}": { get: { responses: { 200: { description: "OK" } } } },
              },
            },
          ],
        },
      }),
    ).rejects.toThrow("required path parameter");
  });

  test("rejects invalid config before conversion and still returns diagnostics", async () => {
    const reports: ConversionReport[] = [];
    await expect(
      generateSpec(capture(), { maxExamples: 0, onReport: (report) => reports.push(report) }),
    ).rejects.toThrow("maxExamples");
    expect(reports[0].diagnostics[0].code).toBe("invalid-config");
  });

  test("validates OpenAPI 3.1 Schema Objects, including schemas changed by overlays", async () => {
    await expect(
      generateSpec(capture(entry("https://api.test/users")), {
        openapiVersion: "3.1.0",
        validate: true,
        overlay: {
          overlay: "1.0.0",
          info: { title: "Invalid schema", version: "1" },
          actions: [
            {
              target: "$.paths['/users'].get.responses['200'].content['application/json'].schema",
              update: { type: "not-a-json-schema-type" },
            },
          ],
        },
      }),
    ).rejects.toThrow("JSON Schema");
  });

  test.each(["3.0.0", "3.1.0"] as const)(
    "treats literal $ref properties and payload values as data in %s validation",
    async (openapiVersion) => {
      const { spec } = await generateSpec(
        capture(entry("https://api.test/users", { $ref: "captured-value", nested: { $id: "literal-id" } })),
        { openapiVersion, strict: true },
      );
      expect(spec.paths["/users"].get!.responses[200].content!["application/json"].example).toMatchObject({
        $ref: "captured-value",
      });
    },
  );

  test("checks actual local references without including reference values in diagnostics", async () => {
    let report: ConversionReport | undefined;
    await expect(
      generateSpec(capture(entry("https://api.test/users")), {
        validate: true,
        onReport: (value) => {
          report = value;
        },
        overlay: {
          overlay: "1.0.0",
          info: { title: "Reference", version: "1" },
          actions: [
            {
              target: "$.paths['/users'].get.responses['200'].content['application/json'].schema",
              update: { $ref: "#/components/schemas/private-value" },
            },
          ],
        },
      }),
    ).rejects.toThrow("Unresolved local reference");
    expect(JSON.stringify(report)).not.toContain("private-value");
  });
});
