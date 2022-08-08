import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { parameterizedUrlHar } from "./test-utils";
import OpenAPISchemaValidator from "openapi-schema-validator";

const har = parameterizedUrlHar();
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
});
