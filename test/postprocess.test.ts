import { describe, expect, test } from "vitest";
import { postprocessSpec, visitSchemas } from "../src/postprocess.js";
import type { OpenApiOverlay } from "../src/types.js";

const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const specWith = (schema: unknown = object({ id: { type: "integer" } }), example?: unknown): any => ({
  openapi: "3.0.0",
  info: { title: "API", version: "1.0.0" },
  paths: {
    "/users": {
      get: {
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema, ...(example === undefined ? {} : { example }) } },
          },
        },
      },
    },
  },
});
const media = (spec: any, path = "/users") => spec.paths[path].get.responses["200"].content["application/json"];
const pointer = "/paths/~1users/get/responses/200/content/application~1json/schema";
const overlay = (actions: OpenApiOverlay["actions"]): OpenApiOverlay => ({
  overlay: "1.0.0",
  info: { title: "Saved API customizations", version: "1" },
  actions,
});

describe("reusable models", () => {
  test("extracts route-named root objects and repeated nested models, deduplicating generated titles", () => {
    const spec = specWith({
      ...object({ user: object({ id: { type: "integer" } }), pagination: object({ cursor: { type: "string" } }) }),
      title: "UsersGetResponse",
    });
    spec.paths["/accounts"] = structuredClone(spec.paths["/users"]);
    media(spec, "/accounts").schema.title = "AccountsGetResponse";
    postprocessSpec(spec, { reusableSchemas: true });
    expect(media(spec).schema.$ref).toBe(media(spec, "/accounts").schema.$ref);
    expect(spec.components.schemas.Account.properties.user).toEqual({ $ref: "#/components/schemas/User" });
    expect(spec.components.schemas.Account.properties.pagination).toEqual({ $ref: "#/components/schemas/Pagination" });
    expect(spec.components.schemas.User.properties.id.type).toBe("integer");
  });

  test("deduplicates structural models while retaining different observation counts at each usage", () => {
    const spec = specWith({
      ...object({
        profile: {
          ...object({ id: { type: "integer", "x-har-observations": { sampleCount: 1 } } }),
          "x-har-observations": { sampleCount: 1, fields: { id: { presentCount: 1, presenceRatio: 1 } } },
        },
      }),
      "x-har-observations": { sampleCount: 1, fields: { profile: { presentCount: 1, presenceRatio: 1 } } },
    });
    spec.paths["/accounts"] = structuredClone(spec.paths["/users"]);
    const account = media(spec, "/accounts").schema;
    account["x-har-observations"].sampleCount = 3;
    account["x-har-observations"].fields.profile.presentCount = 3;
    account.properties.profile["x-har-observations"].sampleCount = 2;
    account.properties.profile.properties.id["x-har-observations"].sampleCount = 2;
    postprocessSpec(spec, {
      reusableSchemas: true,
      schemaNames: { [pointer]: "User", [pointer.replace("~1users", "~1accounts")]: "User" },
    });
    expect(media(spec).schema.allOf).toEqual([{ $ref: "#/components/schemas/User" }]);
    expect(media(spec, "/accounts").schema.allOf).toEqual(media(spec).schema.allOf);
    expect(media(spec).schema["x-har-observations"].sampleCount).toBe(1);
    expect(media(spec, "/accounts").schema["x-har-observations"].sampleCount).toBe(3);
    expect(media(spec, "/accounts").schema["x-har-observations"].schemas["/properties/profile"].sampleCount).toBe(2);
    expect(media(spec).schema["x-har-observations"].schemas["/properties/profile/properties/id"].sampleCount).toBe(1);
    expect(Object.keys(spec.components.schemas)).toEqual(["Profile", "User"]);
    expect(JSON.stringify(spec.components.schemas)).not.toContain("x-har-observations");
  });

  test("extracts list item models even when the root schema is an array", () => {
    const spec = specWith({ type: "array", items: object({ id: { type: "integer" } }) });
    postprocessSpec(spec, { reusableSchemas: true });
    expect(media(spec).schema).toEqual({ type: "array", items: { $ref: "#/components/schemas/User" } });
    expect(spec.components.schemas.User.properties.id.type).toBe("integer");
  });

  test("authoritative names reserve their component before automatic naming", () => {
    const spec = specWith(object({ id: { type: "integer" } }));
    spec.paths["/user"] = structuredClone(spec.paths["/users"]);
    media(spec, "/user").schema = object({ username: { type: "string" } });
    postprocessSpec(spec, { reusableSchemas: true, schemaNames: { [pointer]: "User" } });
    expect(media(spec).schema).toEqual({ $ref: "#/components/schemas/User" });
    expect(media(spec, "/user").schema).toEqual({ $ref: "#/components/schemas/User2" });
    expect(spec.components.schemas.User.properties.id.type).toBe("integer");
  });

  test("extracts explicitly named array schemas without enabling all extraction", () => {
    const spec = specWith({ type: "array", items: object({ id: { type: "integer" } }) });
    postprocessSpec(spec, { schemaNames: { [pointer]: "UserList" } });
    expect(media(spec).schema.$ref).toBe("#/components/schemas/UserList");
    expect(spec.components.schemas.UserList.items.properties.id).toEqual({ type: "integer" });
  });

  test("rejects stale names and conflicting custom names", () => {
    expect(() => postprocessSpec(specWith(), { schemaNames: { "/paths/missing/schema": "User" } })).toThrow(
      "inline schema",
    );
    const spec = specWith();
    spec.paths["/accounts"] = structuredClone(spec.paths["/users"]);
    media(spec, "/accounts").schema = object({ account: { type: "string" } });
    expect(() =>
      postprocessSpec(spec, { schemaNames: { [pointer]: "User", [pointer.replace("~1users", "~1accounts")]: "User" } }),
    ).toThrow("Conflicting schemas");
  });
});

describe("persistent overlays", () => {
  test("updates generated components after extraction and supports safe JSONPath filters", () => {
    const spec = specWith();
    spec.paths["/users"].get.parameters = [
      { name: "limit", in: "query", schema: { type: "integer" } },
      { name: "token", in: "query", schema: { type: "string" } },
    ];
    postprocessSpec(spec, {
      reusableSchemas: true,
      overlay: overlay([
        { target: "$.components.schemas.User", update: { description: "A known user", required: ["id"] } },
        {
          target: "$.paths.*.get.parameters[?(@.name == 'limit')]",
          update: { description: "Page size", schema: { minimum: 1 } },
        },
        { target: "$.paths.*.get", update: { operationId: "listUsers" } },
      ]),
    });
    expect(spec.components.schemas.User.required).toEqual(["id"]);
    expect(spec.paths["/users"].get.operationId).toBe("listUsers");
    expect(spec.paths["/users"].get.parameters[0]).toMatchObject({
      description: "Page size",
      schema: { type: "integer", minimum: 1 },
    });
    expect(spec.paths["/users"].get.parameters[1].description).toBeUndefined();
  });

  test("appends array entries, replaces array properties, and removes selected objects without index drift", () => {
    const spec = specWith();
    spec.paths["/users"].get.tags = ["old"];
    spec.paths["/users"].get.parameters = [
      { name: "a", in: "query" },
      { name: "b", in: "query" },
      { name: "c", in: "query" },
    ];
    postprocessSpec(spec, {
      overlay: overlay([
        { target: "$.paths.*.get", update: { tags: ["new"] } },
        { target: "$.paths.*.get.tags", update: "additional" },
        { target: "$.paths.*.get.parameters[*]", remove: true },
        { target: "$.paths.*.get.parameters", update: { name: "limit", in: "query" } },
      ]),
    });
    expect(spec.paths["/users"].get.tags).toEqual(["new", "additional"]);
    expect(spec.paths["/users"].get.parameters).toEqual([{ name: "limit", in: "query" }]);
  });

  test("rejects stale, primitive, root-removal, and prototype mutation targets", () => {
    expect(() =>
      postprocessSpec(specWith(), { overlay: overlay([{ target: "$.paths.missing", update: {} }]) }),
    ).toThrow("matched no values");
    expect(() =>
      postprocessSpec(specWith(), { overlay: overlay([{ target: "$.info.title", update: "Changed" }]) }),
    ).toThrow("objects or arrays");
    expect(() => postprocessSpec(specWith(), { overlay: overlay([{ target: "$", remove: true }]) })).toThrow(
      "document root",
    );
    const update = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => postprocessSpec(specWith(), { overlay: overlay([{ target: "$", update }]) })).toThrow(
      "Unsafe overlay",
    );
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("example privacy and controls", () => {
  test("redacts recursive properties and pointers after overlays while preserving types", () => {
    const spec = specWith(
      object({
        secret: { type: "number", example: 42, default: 42 },
        nested: object({ enabled: { type: "boolean", example: true } }),
      }),
      { SECRET: "secret", count: 5, users: [{ email: "one@example.com" }, { email: "two@example.com" }] },
    );
    postprocessSpec(spec, {
      redact: { bodyProperties: ["secret"], bodyPointers: ["/users/*/email", "/nested/enabled"] },
      overlay: overlay([
        {
          target: "$.paths['/users'].get.responses['200'].content['application/json']",
          update: { example: { secret: 73, nested: { enabled: true } } },
        },
      ]),
    });
    expect(media(spec).example).toEqual({
      SECRET: "[REDACTED]",
      secret: 0,
      count: 5,
      users: [{ email: "[REDACTED]" }, { email: "[REDACTED]" }],
      nested: { enabled: false },
    });
    expect(media(spec).schema.properties.secret).toMatchObject({ type: "number", example: 0, default: 0 });
    expect(media(spec).schema.properties.nested.properties.enabled.example).toBe(false);
  });

  test("redacts header/query/cookie examples and captured schema defaults", () => {
    const spec = specWith();
    spec.paths["/users"].get.parameters = [
      {
        name: "X-Token",
        in: "header",
        schema: { type: "string", default: "secret", example: "secret" },
        example: "secret",
      },
      { name: "api_key", in: "query", schema: { type: "string", default: "secret" } },
      { name: "session", in: "cookie", example: "cookie-secret", schema: { type: "string" } },
      { name: "Cookie", in: "header", schema: { type: "string", default: "session=secret; visible=ok" } },
      { name: "visible", in: "query", schema: { type: "string", default: "ok" } },
    ];
    postprocessSpec(spec, { redact: { headers: ["x-token"], queryParameters: ["api_key"], cookies: ["session"] } });
    expect(spec.paths["/users"].get.parameters[0]).toMatchObject({
      example: "[REDACTED]",
      schema: { default: "[REDACTED]", example: "[REDACTED]" },
    });
    expect(spec.paths["/users"].get.parameters[1].schema.default).toBe("[REDACTED]");
    expect(spec.paths["/users"].get.parameters[2].example).toBe("[REDACTED]");
    expect(spec.paths["/users"].get.parameters[3].schema.default).toBe("session=[REDACTED]; visible=ok");
    expect(spec.paths["/users"].get.parameters[4].schema.default).toBe("ok");
  });

  test("redacts referenced parameters, response headers, and shared named examples", () => {
    const spec = specWith();
    spec.components = {
      examples: { Credential: { value: "shared-secret" } },
      parameters: {
        Token: {
          name: "X-Token",
          in: "header",
          schema: { type: "string", default: "shared-secret" },
          examples: { token: { $ref: "#/components/examples/Credential" } },
        },
      },
      responses: {
        Result: { description: "OK", headers: { "X-Token": { schema: { type: "string" }, example: "shared-secret" } } },
      },
    };
    spec.paths["/users"].get.parameters = [{ $ref: "#/components/parameters/Token" }];
    spec.paths["/users"].get.responses["200"] = { $ref: "#/components/responses/Result" };
    postprocessSpec(spec, { redact: { headers: ["x-token"] } });
    expect(JSON.stringify(spec)).not.toContain("shared-secret");
    expect(spec.components.examples.Credential.value).toBe("[REDACTED]");
  });

  test("normalizes an overlay's singular example into multiple mode with a byte cap", () => {
    const spec = specWith({ type: "string" });
    postprocessSpec(spec, {
      examples: "multiple",
      overlay: overlay([
        {
          target: "$.paths['/users'].get.responses['200'].content['application/json']",
          update: { example: "overlay example" },
        },
      ]),
    });
    expect(media(spec).example).toBeUndefined();
    expect(media(spec).examples).toEqual({ example1: { value: "overlay example" } });
  });

  test("removes captured sensitive enum/const values while retaining non-sensitive constraints and types", () => {
    const spec = specWith(
      object({
        token: { type: "string", enum: ["captured-secret"] },
        status: { type: "string", enum: ["active", "inactive"] },
        profile: { type: "object", const: { token: "nested-secret", id: 1 } },
      }),
    );
    postprocessSpec(spec, { reusableSchemas: true, redact: { bodyProperties: ["token"] } });
    expect(spec.components.schemas.User.properties.token).toEqual({ type: "string" });
    expect(spec.components.schemas.User.properties.profile).toEqual({ type: "object" });
    expect(spec.components.schemas.User.properties.status.enum).toEqual(["active", "inactive"]);
    expect(JSON.stringify(spec)).not.toContain("secret");
  });

  test("applies body pointers to each enum member rather than an artificial enum array", () => {
    const spec = specWith({ type: "object", enum: [{ token: "enum-secret" }] });
    postprocessSpec(spec, { redact: { bodyPointers: ["/token"] } });
    expect(media(spec).schema).toEqual({ type: "object" });
  });

  test("schema-only removes inferred literal constraints but preserves explicit overlay corrections", () => {
    const spec = specWith(
      object({
        status: { type: "string", enum: ["captured-status"] },
        token: { type: "string", const: "captured-secret" },
      }),
    );
    postprocessSpec(spec, {
      examples: "none",
      overlay: overlay([
        {
          target: "$.paths['/users'].get.responses['200'].content['application/json'].schema.properties.status",
          update: { enum: ["active", "inactive"] },
        },
      ]),
    });
    expect(media(spec).schema.properties.status.enum).toEqual(["active", "inactive"]);
    expect(media(spec).schema.properties.token).toEqual({ type: "string" });
    expect(JSON.stringify(spec)).not.toContain("captured-");
  });

  test("preserves an explicit overlay literal constraint even when it confirms the inferred value", () => {
    const spec = specWith({ type: "string", enum: ["active"] });
    postprocessSpec(spec, {
      examples: "none",
      overlay: overlay([
        {
          target: "$.paths['/users'].get.responses['200'].content['application/json'].schema",
          update: { enum: ["active"] },
        },
      ]),
    });
    expect(media(spec).schema).toEqual({ type: "string", enum: ["active"] });
  });

  test("schema-only strips annotations without deleting payload properties named example/default", () => {
    const spec = specWith(
      object({
        example: { type: "string", example: "private", default: "private" },
        default: object({ token: { type: "string", default: "private" } }),
      }),
      { example: "private" },
    );
    spec.components = { examples: { Secret: { value: "private" } } };
    postprocessSpec(spec, { examples: "none", reusableSchemas: true });
    expect(media(spec).example).toBeUndefined();
    expect(spec.components.examples).toBeUndefined();
    expect(spec.components.schemas.User.properties.example).toEqual({ type: "string" });
    expect(spec.components.schemas.User.properties.default).toMatchObject({
      type: "object",
      properties: { token: { type: "string" } },
    });
    expect(JSON.stringify(spec)).not.toContain("private");
  });

  test("caps and deduplicates named examples after redaction", () => {
    const spec = specWith();
    media(spec).examples = {
      first: { value: { token: "a", id: 1 } },
      duplicate: { value: { token: "b", id: 1 } },
      second: { value: { token: "c", id: 2 } },
      third: { value: { token: "d", id: 3 } },
      huge: { value: "x".repeat(1000) },
    };
    postprocessSpec(spec, {
      examples: "multiple",
      maxExamples: 2,
      maxExampleBytes: 100,
      redact: { bodyProperties: ["token"] },
    });
    expect(Object.keys(media(spec).examples)).toEqual(["first", "second"]);
    expect(media(spec).examples.first.value.token).toBe("[REDACTED]");
  });

  test("keeps legacy single example size unless a cap is explicitly configured", () => {
    const value = "x".repeat(20000);
    const spec = specWith({ type: "string" }, value);
    postprocessSpec(spec, {});
    expect(media(spec).example).toBe(value);
    postprocessSpec(spec, { maxExampleBytes: 10 });
    expect(media(spec).example).toBeUndefined();
  });

  test("redacts schema samples reached through component references and validates pointers", () => {
    const spec = specWith(object({ token: object({ value: { type: "string", example: "secret" } }) }));
    postprocessSpec(spec, { reusableSchemas: true, redact: { bodyProperties: ["token"] } });
    expect(JSON.stringify(spec)).not.toContain("secret");
    expect(() => postprocessSpec(specWith(), { redact: { bodyPointers: ["/invalid~2pointer"] } })).toThrow(
      "Invalid JSON Pointer",
    );
  });
});

test("visitSchemas visits schema positions and skips arbitrary example data and boolean schemas", () => {
  const spec = specWith(object({ example: { type: "string" }, default: { type: "number" }, arbitrary: true }), {
    schema: { type: "invalid" },
    properties: { fake: { type: "invalid" } },
  });
  const visited: string[] = [];
  visitSchemas(spec, (_schema, path) => visited.push(path));
  expect(visited).toEqual([pointer, `${pointer}/properties/example`, `${pointer}/properties/default`]);
});
