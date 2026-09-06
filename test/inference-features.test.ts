import { describe, expect, test } from "vitest";
import type { OpenApiSpec, OperationObject } from "@loopback/openapi-v3-types";
import type { Content, Har, Response } from "har-format";
import { addQueryStringParams, buildRequestBodyFromSamples, buildResponseBodyFromSamples } from "../src/helpers.js";
import type { BodySample } from "../src/helpers.js";
import type { ConversionDiagnostic, InternalConfig } from "../src/types.js";
import { validateSpec } from "../src/validation.js";
import { generateSpec } from "../src/index.js";

const config = (overrides: Partial<InternalConfig> = {}): InternalConfig =>
  ({
    inferParameterTypes: true,
    relaxedContentTypeJsonParse: true,
    ...overrides,
  }) as InternalConfig;
const details = { urlPath: "/items", method: "post" };
const json = (value: unknown, mimeType = "application/json"): BodySample => ({
  postData: { mimeType, text: JSON.stringify(value) },
});
const body = async (samples: BodySample[], overrides: Partial<InternalConfig> = {}) =>
  (await buildRequestBodyFromSamples(samples, details, config(overrides)))!;
const operation = () => ({ responses: {}, parameters: [] }) as OperationObject;

describe("capture-based inference features", () => {
  test("keeps native null types in OpenAPI 3.1 and validates nested legacy optional schemas", async () => {
    const samples = [json({ value: null, nested: { name: "one" } }), json({ value: "text", nested: { name: "two" } })];
    for (const openapiVersion of ["3.0.0", "3.1.0"] as const) {
      const requestBody = await body(samples, { openapiVersion, validate: true });
      const schema = requestBody.content["application/json"].schema;
      expect(schema.required).toBeUndefined();
      expect(schema.properties.nested.required).toBeUndefined();
      if (openapiVersion === "3.1.0") {
        expect(schema.$schema).toBeUndefined();
        expect(schema.properties.value.anyOf).toContainEqual({ type: "null" });
        expect(JSON.stringify(schema)).not.toContain('"nullable"');
      } else {
        expect(JSON.stringify(schema)).toContain('"nullable":true');
      }
      const spec = {
        openapi: openapiVersion,
        info: { title: "Test", version: "1" },
        paths: {
          "/items": { post: { requestBody, responses: { "200": { description: "Success" } } } },
        },
      } as OpenApiSpec;
      expect(await validateSpec(spec)).toEqual([]);
    }
    const withEvidence = await body(samples, { openapiVersion: "3.1.0", includeInferenceEvidence: true });
    const nullableSchema = withEvidence.content["application/json"].schema.properties.value;
    expect(nullableSchema.anyOf.find((schema: any) => schema.type === "null")["x-har-observations"].sampleCount).toBe(
      1,
    );
  });

  test("isolates JSON and form observations by media type", async () => {
    const result = await body([
      json({ standard: true }),
      json({ problem: "failed" }, "application/problem+json"),
      { postData: { mimeType: "application/x-www-form-urlencoded", text: "first=true" } },
      { postData: { mimeType: "multipart/form-data", params: [{ name: "second", value: "42" }] } },
    ]);
    expect(result.content["application/json"].schema.properties).toHaveProperty("standard");
    expect(result.content["application/problem+json"].schema.properties).not.toHaveProperty("standard");
    expect(result.content["multipart/form-data"].schema.properties).toEqual({ second: { type: "integer" } });
  });

  test("deduplicates and names bounded body examples independently of capture order", async () => {
    const samples = [json({ b: 2, a: 1 }), json({ a: 1, b: 2 }), json({ a: 2 }), json({ a: "x".repeat(100) })];
    const settings = { examples: "multiple" as const, maxExamples: 2, maxExampleBytes: 40 };
    const first = (await body(samples, settings)).content["application/json"];
    const reversed = (await body([...samples].reverse(), settings)).content["application/json"];
    expect(first.example).toBeUndefined();
    expect(first.examples).toEqual(reversed.examples);
    expect(Object.keys(first.examples)).toEqual(["sample_1", "sample_2"]);
    expect(Object.values(first.examples).map((item: any) => item.value)).toEqual([{ a: 1, b: 2 }, { a: 2 }]);
  });

  test("preserves latest single example and omits all body examples when disabled", async () => {
    const samples = [json({ value: 1 }), json({ value: 2 })];
    expect((await body(samples)).content["application/json"].example).toEqual({ value: 2 });
    const hidden = (await body(samples, { examples: "none" })).content["application/json"];
    expect(hidden.example).toBeUndefined();
    expect(hidden.examples).toBeUndefined();
    expect(hidden.schema.properties.value).toBeDefined();
  });

  test("retains heterogeneous JSON and malformed samples independent of capture order", async () => {
    const samples = [json({ id: 1 }), { postData: { mimeType: "application/json", text: "invalid-json" } }];
    const first = (await body(samples)).content["application/json"].schema;
    const reverse = (await body([...samples].reverse())).content["application/json"].schema;
    expect(first).toEqual(reverse);
    expect(first.anyOf).toHaveLength(2);
    expect(first.anyOf[0].properties.id).toBeDefined();
    expect(first.anyOf[1].type).toBe("string");
  });

  test("records nested observations and opt-in requiredness without contaminating cached schemas", async () => {
    const samples = [
      json({ id: 1, profile: { name: "one", nickname: "a" }, items: [{ id: 1 }] }),
      json({ id: 2, profile: { name: "two" }, items: [{ id: 2, extra: true }], extra: true }),
    ];
    const observed = (await body(samples, { requiredness: "observed", includeInferenceEvidence: true })).content[
      "application/json"
    ].schema;
    expect(observed.required).toEqual(["id", "items", "profile"]);
    expect(observed.properties.profile.required).toEqual(["name"]);
    expect(observed.properties.items.items.required).toEqual(["id"]);
    expect(observed["x-har-observations"]).toEqual({
      sampleCount: 2,
      fields: {
        extra: { presentCount: 1, presenceRatio: 0.5 },
        id: { presentCount: 2, presenceRatio: 1 },
        items: { presentCount: 2, presenceRatio: 1 },
        profile: { presentCount: 2, presenceRatio: 1 },
      },
    });
    const legacy = (await body(samples)).content["application/json"].schema;
    expect(legacy.required ?? []).toEqual([]);
    expect(legacy["x-har-observations"]).toBeUndefined();
  });

  test("infers repeated query arrays only within a request and widens their item types", () => {
    const op = operation();
    addQueryStringParams(
      op,
      [
        { name: "id", value: "1" },
        { name: "id", value: "2" },
      ],
      config(),
    );
    addQueryStringParams(op, [{ name: "id", value: "three" }], config());
    const repeated: any = op.parameters![0];
    expect(repeated.schema).toEqual({ type: "array", items: { type: "string" }, default: ["three"] });
    expect(repeated).toMatchObject({ style: "form", explode: true, example: ["three"] });
    const scalar = operation();
    addQueryStringParams(scalar, [{ name: "id", value: "1" }], config());
    addQueryStringParams(scalar, [{ name: "id", value: "2" }], config());
    expect((scalar.parameters![0] as any).schema.type).toBe("integer");
    const disabled = operation();
    addQueryStringParams(
      disabled,
      [
        { name: "id", value: "1" },
        { name: "id", value: "2" },
      ],
      config({ inferArrayParameters: false }),
    );
    expect((disabled.parameters![0] as any).schema.type).toBe("integer");
  });

  test("parses one-level bracket query objects and preserves ambiguous or nested spellings", () => {
    const op = operation();
    addQueryStringParams(
      op,
      [
        { name: "filter[active]", value: "true" },
        { name: "filter[count]", value: "2" },
      ],
      config({ parseBracketParameters: true }),
    );
    expect(op.parameters).toEqual([
      {
        in: "query",
        name: "filter",
        description: "filter",
        style: "deepObject",
        explode: true,
        schema: {
          type: "object",
          properties: { active: { type: "boolean" }, count: { type: "integer" } },
          default: { active: true, count: 2 },
        },
        example: { active: true, count: 2 },
      },
    ]);
    const ambiguous = operation();
    const names = ["filter", "filter[name]", "nested[value][name]", "indexed[0]", "unsafe[__proto__]"];
    addQueryStringParams(
      ambiguous,
      names.map((name) => ({ name, value: "x" })),
      config({ parseBracketParameters: true }),
    );
    expect(ambiguous.parameters!.map((item: any) => item.name)).toEqual(names);
    const bracketArray = operation();
    addQueryStringParams(bracketArray, [{ name: "tags[]", value: "one" }], config({ parseBracketParameters: true }));
    expect(bracketArray.parameters![0]).toMatchObject({
      name: "tags[]",
      style: "form",
      explode: true,
      schema: { type: "array", items: { type: "string" } },
    });
    const crossRequest = operation();
    addQueryStringParams(
      crossRequest,
      [{ name: "filter[active]", value: "true" }],
      config({ parseBracketParameters: true }),
    );
    addQueryStringParams(crossRequest, [{ name: "filter", value: "all" }], config({ parseBracketParameters: true }));
    addQueryStringParams(
      crossRequest,
      [{ name: "filter[name]", value: "one" }],
      config({ parseBracketParameters: true }),
    );
    expect(crossRequest.parameters!.map((item: any) => item.name)).toEqual([
      "filter[active]",
      "filter",
      "filter[name]",
    ]);
    const nestedFirst = operation();
    addQueryStringParams(
      nestedFirst,
      [{ name: "filter[nested][name]", value: "one" }],
      config({ parseBracketParameters: true }),
    );
    addQueryStringParams(
      nestedFirst,
      [{ name: "filter[active]", value: "true" }],
      config({ parseBracketParameters: true }),
    );
    expect(nestedFirst.parameters!.map((item: any) => item.name)).toEqual(["filter[nested][name]", "filter[active]"]);
  });

  test("infers repeated form fields as arrays and optional mode removes requiredness", async () => {
    const samples = [
      { postData: { mimeType: "application/x-www-form-urlencoded", text: "tag=a&tag=b&active=true" } },
      { postData: { mimeType: "application/x-www-form-urlencoded", text: "tag=c" } },
    ];
    const result = await body(samples, { examples: "multiple", includeInferenceEvidence: true });
    const content = result.content["application/x-www-form-urlencoded"];
    expect(content.schema.properties.tag).toEqual({ type: "array", items: { type: "string" } });
    expect(content.schema.required).toEqual(["tag"]);
    expect(content.schema["x-har-observations"].fields.active).toEqual({ presentCount: 1, presenceRatio: 0.5 });
    expect(content.examples.sample_1.value).toEqual({ tag: ["a", "b"], active: true });
    const optional = await body(samples, { requiredness: "optional" });
    expect(optional.required).toBe(false);
    expect(optional.content["application/x-www-form-urlencoded"].schema.required).toBeUndefined();
  });

  test("counts restored bracket aliases across all captured requests", async () => {
    const queries = ["filter[active]=true", "filter[active]=false&filter[name]=a", "filter=all", "filter[name]=b"];
    const capture = (values: string[]) =>
      ({
        log: {
          entries: values.map((query) => ({
            request: { method: "GET", url: `https://api.example.com/items?${query}`, headers: [] },
            response: { status: 200, headers: [], content: { mimeType: "application/json", size: 2, text: "{}" } },
          })),
        },
      }) as Har;
    const settings = {
      parseBracketParameters: true,
      requiredness: "observed" as const,
      includeInferenceEvidence: true,
      validate: true,
    };
    const result = await generateSpec(capture(queries), settings);
    const parameters = result.spec.paths["/items"].get.parameters as any[];
    expect(
      Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter["x-har-observations"]])),
    ).toEqual({
      "filter[active]": { sampleCount: 4, present: 2, ratio: 0.5 },
      "filter[name]": { sampleCount: 4, present: 2, ratio: 0.5 },
      filter: { sampleCount: 4, present: 1, ratio: 0.25 },
    });
    expect(parameters.every((parameter) => parameter.required === false)).toBe(true);
    const unambiguous = await generateSpec(capture(queries.slice(0, 2)), settings);
    expect(unambiguous.spec.paths["/items"].get.parameters[0]).toMatchObject({
      name: "filter",
      style: "deepObject",
      required: true,
      "x-har-observations": { sampleCount: 2, present: 2, ratio: 1 },
    });
  });

  test("reports uncaptured bodies and invalid JSON with source location but no body contents", async () => {
    const diagnostics: ConversionDiagnostic[] = [];
    const source = { inputIndex: 1, entryIndex: 2, sourceName: "capture.har" };
    const responses = [
      { status: 200, source, headers: [], content: { mimeType: "application/json", size: 42 } as Content },
      {
        status: 200,
        source,
        headers: [],
        content: { mimeType: "application/json", text: "secret-invalid-json", size: 19 } as Content,
      },
    ];
    const result = await buildResponseBodyFromSamples(
      responses as Array<Response & { source: typeof source }>,
      details,
      config({ onDiagnostic: (item) => diagnostics.push(item) }),
    );
    expect(diagnostics.map((item) => item.code)).toEqual(["body-missing", "schema-fallback"]);
    expect(diagnostics[0]).toMatchObject({ source, path: "/items", method: "post", status: 200 });
    expect(JSON.stringify(diagnostics)).not.toContain("secret-invalid-json");
    expect(result!.content!["application/json"].schema).toEqual({ type: "string", format: undefined });
  });

  test("does not warn about uncaptured bodies on HEAD, no-content, or not-modified responses", async () => {
    const diagnostics: ConversionDiagnostic[] = [];
    const settings = config({ onDiagnostic: (item) => diagnostics.push(item) });
    const response = (status: number) =>
      ({ status, headers: [], content: { mimeType: "application/json", size: 42 } }) as Response;
    await buildResponseBodyFromSamples([response(204), response(304)], details, settings);
    await buildResponseBodyFromSamples([response(200)], { ...details, method: "HEAD" }, settings);
    expect(diagnostics).toEqual([]);
  });

  test("strict conversion accepts bodyless responses and retains their response headers", async () => {
    const cases = [
      { method: "HEAD", status: 200 },
      { method: "GET", status: 204 },
      { method: "GET", status: 304 },
      { method: "GET", status: 200 },
    ];
    const capture = {
      log: {
        entries: cases.map(({ method, status }, index) => ({
          request: { method, url: `https://api.example.com/empty-${index}`, headers: [] },
          response: {
            status,
            headers: [{ name: "X-Trace-Id", value: "trace" }],
            content: { mimeType: "application/json", size: 0, text: "" },
          },
        })),
      },
    } as Har;
    const result = await generateSpec(capture, { strict: true, includeReport: true });
    expect(result.report!.diagnostics).toEqual([]);
    for (const [{ method, status }, index] of cases.map((item, index) => [item, index] as const)) {
      const response = result.spec.paths[`/empty-${index}`][method.toLowerCase()].responses[status];
      expect(Object.keys(response.content ?? {})).toEqual([]);
      expect(response.headers["X-Trace-Id"].schema).toEqual({ type: "string" });
    }
    const request = await buildRequestBodyFromSamples(
      [json({ input: true })],
      { ...details, method: "HEAD" },
      config(),
    );
    expect(request!.content["application/json"].schema.properties.input).toBeDefined();
  });
});
