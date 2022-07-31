import { test, describe } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import fs from "fs";
import { generateSpec } from "../src";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const har = JSON.parse(fs.readFileSync(path.join(__dirname, "./data/sample.har")).toString());

const validator = new OpenAPISchemaValidator({
  version: 3,
  // optional
  extensions: {
    /* place any properties here to extend the schema. */
  },
});
describe("har-to-openapi", () => {
  test.concurrent("Sample API matches snapshot", async ({ expect }) => {
    expect(generateSpec(har)).toMatchSnapshot();
  });
  test.concurrent("Sample API 2 matches snapshot", async ({ expect }) => {
    // expect(foo).toMatchSnapshot();
  });
  test.concurrent("Sample API 2 is valid schema", async ({ expect }) => {
    const spec = generateSpec(har);
    const result = validator.validate(spec.spec as any);
    expect(result.errors).toHaveLength(0);
  });
});
