import { describe, test } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import { generateSpec } from "../src";
import { allTestHars } from "./test-utils";

describe("Snapshots and validity", async () => {
  const hars = allTestHars();
  const validator = new OpenAPISchemaValidator({
    version: 3,
  });
  await Promise.all(
    hars.map(async (entry) => {
      const { file, har } = entry;
      const spec = await generateSpec(har);
      test(`Sample API ${file} matches snapshot`, ({ expect }) => {
        expect(spec).toMatchSnapshot();
      });
      test(`Sample API ${file} is valid schema`, ({ expect }) => {
        const result = validator.validate(spec.spec as any);
        expect(result.errors).toHaveLength(0);
      });
    }),
  );
});
