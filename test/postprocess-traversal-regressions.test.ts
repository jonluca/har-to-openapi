import { describe, expect, test } from "vitest";
import { postprocessSpec } from "../src/postprocess.js";
import { validateSpec } from "../src/validation.js";

const document = (): any => ({
  openapi: "3.1.0",
  info: { title: "API", version: "1" },
  paths: {},
});
const response = (schema: unknown) => ({
  get: { responses: { "200": { description: "OK", content: { "application/json": { schema } } } } },
});
const callback = (schema: unknown) => ({
  "{$request.query.callbackUrl}": {
    post: {
      requestBody: { content: { "application/json": { schema } } },
      responses: { "204": { description: "Accepted" } },
    },
  },
});

describe("postprocessing schema traversal regressions", () => {
  test("redacts captured values inside reusable callbacks", () => {
    const spec = document();
    spec.components = {
      callbacks: {
        Notification: callback({
          type: "object",
          properties: { token: { type: "string", example: "callback-secret", enum: ["callback-secret"] } },
        }),
      },
    };
    spec.paths["/subscribe"] = response({ type: "string" });
    spec.paths["/subscribe"].get.callbacks = { notification: { $ref: "#/components/callbacks/Notification" } };

    postprocessSpec(spec, { redact: { bodyPointers: ["/token"] } });

    const schema =
      spec.components.callbacks.Notification["{$request.query.callbackUrl}"].post.requestBody.content[
        "application/json"
      ].schema;
    expect(schema.properties.token).toEqual({ type: "string", example: "[REDACTED]" });
    expect(JSON.stringify(spec)).not.toContain("callback-secret");
  });

  test.each(["#/components/schemas/%53ecret", "#/components/schemas/Container/allOf/0"])(
    "redacts schema samples through local reference %s in the referring body's context",
    (reference) => {
      const spec = document();
      const secret = {
        type: "string",
        example: "reference-secret",
        default: "reference-secret",
        enum: ["reference-secret"],
      };
      spec.components = {
        schemas: reference.includes("allOf") ? { Container: { allOf: [secret] } } : { Secret: secret },
      };
      spec.paths["/users"] = response({ type: "object", properties: { token: { $ref: reference } } });

      postprocessSpec(spec, { redact: { bodyPointers: ["/token"] } });

      expect(secret).toEqual({ type: "string", example: "[REDACTED]", default: "[REDACTED]" });
      expect(JSON.stringify(spec)).not.toContain("reference-secret");
    },
  );

  test("redacts percent-encoded reusable example references in parameter context", () => {
    const spec = document();
    spec.components = { examples: { Credential: { value: "example-secret" } } };
    spec.paths["/users"] = response({ type: "string" });
    spec.paths["/users"].get.parameters = [
      {
        name: "X-Token",
        in: "header",
        schema: { type: "string" },
        examples: { token: { $ref: "#/components/examples/%43redential" } },
      },
    ];

    postprocessSpec(spec, { redact: { headers: ["x-token"] } });

    expect(spec.components.examples.Credential.value).toBe("[REDACTED]");
    expect(JSON.stringify(spec)).not.toContain("example-secret");
  });

  test("validates OpenAPI 3.1 schemas inside reusable callbacks", async () => {
    const spec = document();
    spec.components = { callbacks: { Notification: callback({ type: "invalid-schema-type" }) } };

    expect(await validateSpec(spec)).toContainEqual(
      expect.objectContaining({
        code: "validation-failed",
        message: expect.stringContaining("JSON Schema /components/callbacks/Notification/"),
      }),
    );
  });
});
