import { describe, expect, test } from "vitest";
import type { OperationObject, ParameterObject } from "@loopback/openapi-v3-types";
import { addQueryStringParams, buildRequestBodyFromSamples } from "../src/helpers.js";
import type { BodySample } from "../src/helpers.js";
import type { InternalConfig } from "../src/types.js";

const config = (overrides: Partial<InternalConfig> = {}): InternalConfig =>
  ({ inferParameterTypes: true, ...overrides }) as InternalConfig;
const operation = () => ({ responses: {}, parameters: [] }) as OperationObject;
const details = { urlPath: "/items", method: "post" };

describe("inference regressions", () => {
  test.each(["1e309", "-1e309"])("keeps non-finite numeric query value %s as a string", (value) => {
    const op = operation();
    addQueryStringParams(op, [{ name: "value", value }], config());

    expect(op.parameters![0]).toMatchObject({
      example: value,
      schema: { type: "string", default: value },
    });
    expect(JSON.parse(JSON.stringify(op)).parameters[0].example).toBe(value);
  });

  test.each(["1e3", "+12", "TRUE", " 12 "])(
    "preserves the captured spelling %s after a query schema widens",
    (value) => {
      const op = operation();
      addQueryStringParams(op, [{ name: "value", value: "all" }], config());
      addQueryStringParams(op, [{ name: "value", value }], config());

      expect(op.parameters![0]).toMatchObject({
        example: value,
        schema: { type: "string", default: value },
      });
    },
  );

  test("preserves raw repeated and bracket property examples when their item schemas widen", () => {
    const op = operation();
    const settings = config({ parseBracketParameters: true });
    addQueryStringParams(
      op,
      [
        { name: "values", value: "all" },
        { name: "filter[count]", value: "all" },
      ],
      settings,
    );
    addQueryStringParams(
      op,
      [
        { name: "values", value: "1e3" },
        { name: "values", value: "+12" },
        { name: "filter[count]", value: "1e3" },
      ],
      settings,
    );

    const parameters = op.parameters as ParameterObject[];
    expect(parameters.find((item) => item.name === "values")).toMatchObject({
      schema: { type: "array", items: { type: "string" } },
      example: ["1e3", "+12"],
    });
    expect(parameters.find((item) => item.name === "filter")).toMatchObject({
      style: "deepObject",
      schema: { type: "object", properties: { count: { type: "string" } } },
      example: { count: "1e3" },
    });
  });

  test.each(["text", "params"])(
    "counts empty forms captured through %s when inferring required fields",
    async (representation) => {
      const mimeType = "application/x-www-form-urlencoded";
      const empty = representation === "text" ? { mimeType, text: "" } : { mimeType, params: [] };
      const result = await buildRequestBodyFromSamples(
        [{ postData: { mimeType, text: "tag=one" } }, { postData: empty }],
        details,
        config({ requiredness: "observed", includeInferenceEvidence: true, examples: "multiple" }),
      );
      const content = result!.content[mimeType];
      expect(content.schema).toMatchObject({
        properties: { tag: { type: "string" } },
        "x-har-observations": {
          sampleCount: 2,
          fields: { tag: { presentCount: 1, presenceRatio: 0.5 } },
        },
      });
      expect(content.schema).not.toHaveProperty("required");
      expect(content.examples).toBeDefined();
      expect(Object.values(content.examples!).map((item: any) => item.value)).toContainEqual({});
    },
  );

  test("decodes base64 form content before interpreting its fields", async () => {
    const mimeType = "application/x-www-form-urlencoded";
    const result = await buildRequestBodyFromSamples(
      [
        {
          postData: {
            mimeType,
            encoding: "base64",
            size: 10,
            text: Buffer.from("count=2&active=true").toString("base64"),
          },
        } as BodySample,
      ],
      details,
      config({ examples: "multiple" }),
    );
    expect(result!.content[mimeType]).toMatchObject({
      schema: { properties: { count: { type: "integer" }, active: { type: "boolean" } } },
      examples: { sample_1: { value: { count: 2, active: true } } },
    });
  });
});
