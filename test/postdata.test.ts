import { describe, test } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import { generateSpec } from "../src";
import type { Har } from "har-format";

const validator = new OpenAPISchemaValidator({
  version: 3,
});
const har = {
  log: {
    entries: [
      {
        index: 0,
        request: {
          method: "POST",
          url: "http://test.loadimpact.com/login",
          headers: [
            {
              name: "Content-Type",
              value: "application/json",
            },
          ],
          postData: {
            mimeType: "application/json",
            text: '{"user":"admin","password":"123"}',
          },
        },
      },
    ],
  },
} as unknown as Har;
describe("har-to-openapi", () => {
  test(`HAR with request postdata matches snapshot`, async ({ expect }) => {
    expect(await generateSpec(har)).toMatchSnapshot();
  });
  test(`HAR with request postdata has correct options`, async ({ expect }) => {
    const { spec } = await generateSpec(har);
    const result = validator.validate(spec as any);
    expect(result.errors).toHaveLength(0);

    const loginPath = spec.paths["/login"];
    expect(loginPath).toBeDefined();
    expect(loginPath).toHaveProperty("post");
    const post = loginPath["post"];
    expect(post).toHaveProperty("requestBody");
    const requestBody = post.requestBody;
    expect(requestBody).toHaveProperty("content");
    expect(requestBody.content).toHaveProperty("application/json");
    const contentElement = requestBody.content["application/json"];
    expect(contentElement).toHaveProperty("schema");
    const schema = contentElement.schema;
    expect(schema).toHaveProperty("type");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
    expect(schema.properties).toHaveProperty("user");
    expect(schema.properties).toHaveProperty("password");
    expect(schema.properties.user).toHaveProperty("type");
    expect(schema.properties.user.type).toBe("string");
    expect(contentElement).toHaveProperty("example");
    expect(contentElement.example.user).toBe("admin");
    expect(schema.properties.password).toHaveProperty("type");
    expect(schema.properties.password.type).toBe("string");
    expect(contentElement.example.password).toBe("123");
  });
});
