import { describe, test } from "vitest";
import { generateSpec } from "../src/index.js";
import { mediaTypesHar } from "./test-utils.js";

describe("Media type compatibility", async () => {
  test("normalizes structured json content types and falls back to Content-Type headers", async ({ expect }) => {
    const data = await generateSpec(mediaTypesHar());

    expect(data.spec.paths["/problem"].post.requestBody.content["application/problem+json"]).toBeDefined();
    expect(data.spec.paths["/problem"].post.responses["400"].content["application/problem+json"]).toBeDefined();
    expect(data.spec.paths["/vendor"].get.responses["200"].content["application/vnd.api+json"]).toBeDefined();
    expect(data.spec.paths["/text-json"].get.responses["200"].content["text/json"]).toBeDefined();
    expect(data.spec.paths["/header-json"].get.responses["200"].content["application/json"]).toBeDefined();
  });

  test("keeps xml-like payloads as string content instead of forcing json inference", async ({ expect }) => {
    const data = await generateSpec(mediaTypesHar(), { includeNonJsonExampleResponses: true });
    expect(data.spec.paths["/xml"].get.responses["200"].content["application/xml"]).toEqual({
      schema: {
        type: "string",
      },
      example: "<note><body>hello</body></note>",
    });
  });
});
