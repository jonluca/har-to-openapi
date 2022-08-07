import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { formDataHar, invalidJson, sameEndpointDiffPayloads, securityHar } from "./test-utils";
import { getBody } from "../src/helpers";

const invalidHar = invalidJson();
const har = sameEndpointDiffPayloads();
const securityHeader = securityHar();

describe("Body and header tests", async () => {
  test(`Doesn't crash on invalid json`, async ({ expect }) => {
    const data = await generateSpec(invalidHar, { filterStandardHeaders: true });
    expect(data).toBeDefined();
  });
  test(`Merges bodies to same endpoint`, async ({ expect }) => {
    const data = await generateSpec(har, { filterStandardHeaders: true });
    const post = data.spec.paths["/api/users/queries/getCurrentUser"].post;
    const params = post.requestBody.content["application/json"].schema.properties.params;
    const response = post.responses["200"].content["application/json"].schema.properties.result.properties.test;
    expect(params).toBeDefined();
    expect(response).toBeDefined();
    expect(params.anyOf).toBeDefined();
    expect(response).toEqual({
      format: "boolean",
      type: "string",
    });
  });
  test(`Security headers parse properly`, async ({ expect }) => {
    const data = await generateSpec(securityHeader, { securityHeaders: ["X-Auth-Token"] });
    const security = data.spec.paths["/login"].post.security;
    expect(security).toBeDefined();
    expect(security).toHaveLength(1);
    expect(security).toEqual([
      {
        "X-Auth-Token": [],
      },
    ]);
  });
  test(`Not found security headers dont set security property`, async ({ expect }) => {
    const data = await generateSpec(securityHeader, { securityHeaders: ["X-Auth-Token-NoExist"] });
    const security = data.spec.paths["/login"].post.security;
    expect(security).not.toBeDefined();
  });

  test(`Form data with text only is still parsed`, async ({ expect }) => {
    const formHar = formDataHar();
    const data = await generateSpec(formHar);
    const security = data.spec.paths["/loginTwo"].get;
    const requestContent = security.requestBody.content["application/x-www-form-urlencoded"];
    expect(requestContent).toBeDefined();
    expect(requestContent).toEqual({
      schema: {
        properties: {
          foo0: {
            type: "string",
          },
          foo1: {
            type: "string",
          },
        },
        required: ["foo0", "foo1"],
        type: "object",
      },
    });
  });
  test(`Response body getter with no data doesnt crash`, async ({ expect }) => {
    const data = await getBody(undefined, { urlPath: "/", method: "GET", examples: [] }, {} as any);
    expect(data).not.toBeDefined();
  });
  test(`Parses base64 postData`, async ({ expect }) => {
    const buffer = Buffer.from(`{"test":"true"}`);
    const data = await getBody(
      {
        encoding: "base64",
        text: buffer.toString("base64"),
        size: buffer.buffer.byteLength,
        mimeType: "application/json",
      },
      { urlPath: "/", method: "GET", examples: [] },
      {} as any,
    );
    expect(data?.content).toBeDefined();
  });
});
