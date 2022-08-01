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

const postDataConflict = {
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
              value: "application/x-www-form-urlencoded",
            },
          ],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "foo0=bar0&foo1=bar1",
            params: [
              {
                name: "foo0",
                value: "bar0",
              },
              {
                name: "foo3",
                value: "bar3",
              },
              {
                name: "foo1",
                value: "bar1",
              },
            ],
          },
        },
      },
    ],
  },
} as unknown as Har;
describe("har-to-openapi", async () => {
  const [postDataSpec, postDataSpecWithConflict] = await Promise.all([
    generateSpec(har),
    generateSpec(postDataConflict),
  ]);
  test(`HAR with request with postdata matches snapshot`, async ({ expect }) => {
    expect(postDataSpec).toMatchSnapshot();
  });
  test(`HAR with request with postdata with a mismatch matches snapshot`, async ({ expect }) => {
    expect(postDataSpecWithConflict).toMatchSnapshot();
  });
  test(`HAR with request postdata has correct options`, async ({ expect }) => {
    const { spec } = postDataSpec;
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
  test(`HAR with request with postdata with mismatch has correct options`, async ({ expect }) => {
    const { spec } = postDataSpecWithConflict;
    const result = validator.validate(spec as any);
    expect(result.errors).toHaveLength(0);

    // our parser is pretty permissive, so we want to allow for defined arguments that weren't in the actual query string
    const loginPath = spec.paths["/login"];
    expect(loginPath).toBeDefined();
    expect(loginPath).toHaveProperty("post");
    const post = loginPath["post"];
    expect(post).toHaveProperty("requestBody");
    const requestBody = post.requestBody;
    expect(requestBody).toHaveProperty("content");
    expect(requestBody.content).toHaveProperty("application/x-www-form-urlencoded");
    const contentElement = requestBody.content["application/x-www-form-urlencoded"];
    expect(contentElement).toHaveProperty("schema");
    const schema = contentElement.schema;
    expect(schema).toHaveProperty("type");
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
    expect(schema.properties).toHaveProperty("foo0");
    expect(schema.properties).toHaveProperty("foo1");
    expect(schema.properties).toHaveProperty("foo3");
  });
});
