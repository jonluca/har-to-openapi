import { describe, test } from "vitest";
import { generateSpec } from "../src/index.js";
import type { ParameterObject } from "@loopback/openapi-v3-types";
import { OpenAPISchemaValidator, createOpenApiValidator, parameterizedUrlHar, typedParamsHar } from "./test-utils.js";

const har = parameterizedUrlHar();
const typedHar = typedParamsHar();
const validator = new OpenAPISchemaValidator({
  version: 3,
});
describe("Parameterized URLs", async () => {
  test(`Can parse the parameterized url properly`, async ({ expect }) => {
    const data = await generateSpec(har, { filterStandardHeaders: true, attemptToParameterizeUrl: true });
    expect(data).toBeDefined();
    expect(data).toMatchSnapshot();
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });

  test(`Infers typed query values and keeps hyphenated slugs intact`, async ({ expect }) => {
    const data = await generateSpec(typedHar, {
      attemptToParameterizeUrl: true,
      minLengthForNumericPath: 1,
    });
    const typedValidator = createOpenApiValidator();
    const ordersPath = data.spec.paths["/orders/{id}"];
    const slugPath = data.spec.paths["/posts/spring-sale-2024"];

    expect(ordersPath).toBeDefined();
    expect(slugPath).toBeDefined();
    expect(ordersPath.parameters).toEqual([
      {
        in: "path",
        name: "id",
        required: true,
        schema: {
          type: "string",
          default: "00123",
        },
        example: "00123",
      },
    ]);

    const queryParameters = ordersPath.get.parameters.filter(
      (parameter: ParameterObject) => "in" in parameter && parameter.in === "query",
    );
    expect(queryParameters).toEqual([
      {
        in: "query",
        name: "limit",
        description: "limit",
        example: 25,
        schema: {
          type: "integer",
          default: 25,
        },
      },
      {
        in: "query",
        name: "active",
        description: "active",
        example: false,
        schema: {
          type: "boolean",
          default: false,
        },
      },
      {
        in: "query",
        name: "ratio",
        description: "ratio",
        example: 2.25,
        schema: {
          type: "number",
          default: 2.25,
        },
      },
      {
        in: "query",
        name: "zip",
        description: "zip",
        example: "04567",
        schema: {
          type: "string",
          default: "04567",
        },
      },
    ]);
    expect(typedValidator.validate(data.spec as any).errors).toHaveLength(0);
  });

  test(`Can disable scalar parameter inference`, async ({ expect }) => {
    const data = await generateSpec(typedHar, {
      attemptToParameterizeUrl: true,
      minLengthForNumericPath: 1,
      inferParameterTypes: false,
    });
    const ordersPath = data.spec.paths["/orders/{id}"];
    const queryParameters = ordersPath.get.parameters.filter(
      (parameter: ParameterObject) => "in" in parameter && parameter.in === "query",
    );

    expect(ordersPath.parameters).toEqual([
      {
        in: "path",
        name: "id",
        required: true,
        schema: {
          type: "string",
          default: "00123",
        },
        example: "00123",
      },
    ]);
    expect(queryParameters).toEqual([
      {
        in: "query",
        name: "limit",
        description: "limit",
        example: "25",
        schema: {
          type: "string",
          default: "25",
        },
      },
      {
        in: "query",
        name: "active",
        description: "active",
        example: "false",
        schema: {
          type: "string",
          default: "false",
        },
      },
      {
        in: "query",
        name: "ratio",
        description: "ratio",
        example: "2.25",
        schema: {
          type: "string",
          default: "2.25",
        },
      },
      {
        in: "query",
        name: "zip",
        description: "zip",
        example: "04567",
        schema: {
          type: "string",
          default: "04567",
        },
      },
    ]);
  });
});
