import { describe, test } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import { generateSpec } from "../src";
import { fileURLToPath } from "url";
import * as path from "path";
import { dirname } from "path";
import fs from "fs";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Snapshots and validity", async () => {
  const readDirectory = (dir: string) => {
    const files = fs.readdirSync(dir);
    const all = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      const contents = JSON.parse(fs.readFileSync(filePath, { encoding: "utf8" }));
      all.push({ file, har: contents });
    }
    return all;
  };

  const hars = readDirectory(path.join(__dirname, "data"));

  const validator = new OpenAPISchemaValidator({
    version: 3,
  });
  await Promise.all(
    hars.map(async (entry) => {
      const { file, har } = entry;
      const spec = await generateSpec(har);
      test(`Sample API ${file} matches snapshot`, async ({ expect }) => {
        expect(spec).toMatchSnapshot();
      });
      test(`Sample API ${file} is valid schema`, async ({ expect }) => {
        const result = validator.validate(spec.spec as any);
        expect(result.errors).toHaveLength(0);
      });
    }),
  );
});
