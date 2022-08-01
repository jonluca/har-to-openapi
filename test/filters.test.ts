import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { dirname } from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type { Har } from "har-format";
import * as path from "path";
import type { OperationObject } from "openapi3-ts/src/model/OpenApi";
import type { OpenApiSpec } from "@loopback/openapi-v3-types";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";
import type { ResponseObject } from "openapi3-ts/src/model/OpenApi";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contents = JSON.parse(
  fs.readFileSync(path.join(__dirname, "./data/sample.har"), { encoding: "utf8" }),
) as unknown as Har;

const getResponses = (spec: OpenApiSpec): ResponseObject[] => {
  const paths = spec.paths;
  const values = Object.values(paths) as PathItemObject[];
  return values.flatMap((path) => {
    return Object.values(path)
      .flatMap((method: OperationObject) => method?.responses)
      .filter(Boolean)
      .flatMap((response) => Object.values(response));
  });
};

describe("Option filters", async () => {
  test(`Filters out standard headers`, async ({ expect }) => {
    const data = await generateSpec(contents, { filterStandardHeaders: true });
    const responses = getResponses(data.spec);
    for (const response of Object.values(responses)) {
      expect(response.headers).not.toHaveProperty("content-type");
    }
  });
  test(`Keeps out standard headers`, async ({ expect }) => {
    const data = await generateSpec(contents, { filterStandardHeaders: false });
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
    const data = await generateSpec(contents, { mimeTypes: ["application/json"] });
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
