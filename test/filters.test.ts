import { describe, test } from "vitest";
import { generateSpec } from "../src";
import type { OperationObject, PathItemObject, ResponseObject } from "openapi3-ts/src/model/OpenApi";
import type { OpenApiSpec } from "@loopback/openapi-v3-types";
import { sampleHar } from "./test-utils";

const har = sampleHar();
const getResponses = (spec: OpenApiSpec): ResponseObject[] => {
  const paths = spec.paths;
  const values = Object.values(paths) as PathItemObject[];
  return values.flatMap((path) => {
    return Object.values(path)
      .flatMap((method: OperationObject) => method?.responses)
      .flatMap((response) => Object.values(response || {}));
  });
};

describe("Option filters", async () => {
  test(`Filters out standard headers`, async ({ expect }) => {
    const data = await generateSpec(har, { filterStandardHeaders: true });
    const responses = getResponses(data.spec);
    for (const response of Object.values(responses)) {
      expect(response.headers).not.toHaveProperty("content-type");
    }
  });

  test(`Keeps out standard headers`, async ({ expect }) => {
    const data = await generateSpec(har, { filterStandardHeaders: false });
    let hadContentType = false;
    const responses = getResponses(data.spec);
    for (const response of Object.values(responses)) {
      if (response.headers) {
        hadContentType ||= response.headers["content-type"] !== undefined;
      }
    }
    expect(hadContentType).toBe(true);
  });

  test(`Filters to mimetype`, async ({ expect }) => {
    const data = await generateSpec(har, { mimeTypes: ["application/json"], relaxedContentTypeJsonParse: false });
    const responses = getResponses(data.spec);
    for (const response of responses) {
      if (response.content) {
        const types = Object.keys(response.content);
        if (types.length) {
          expect(types).toEqual(["application/json"]);
        }
      }
    }
  });
  test(`Ignores bodies for status codes`, async ({ expect }) => {
    const data = await generateSpec(har, { mimeTypes: ["application/json"], ignoreBodiesForStatusCodes: [200] });
    const responses = getResponses(data.spec);
    for (const response of responses) {
      if (response.content) {
        const types = Object.keys(response.content);
        if (types.length) {
          expect(types).toEqual(["application/json"]);
        }
      }
    }
  });
});
