import { describe, test } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import { generateSpec } from "../src";
import { fileURLToPath } from "url";
import * as path from "path";
import { dirname } from "path";
import fs from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const readDirectory = async (dir: string) => {
  const files = await fs.readdir(dir);

  const values = files.flatMap(async (file) => {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return;
    }
    return fs.readFile(filePath);
  }) as Array<Promise<Buffer>>;

  const buffers = await Promise.all(values);
  const contents = buffers.filter(Boolean).map((l) => JSON.parse(l.toString()));
  return contents;
};

const hars = await readDirectory(path.join(__dirname, "data"));

const validator = new OpenAPISchemaValidator({
  version: 3,
  // optional
  extensions: {
    /* place any properties here to extend the schema. */
  },
});
describe("har-to-openapi", () => {
  hars.map((har, index) => {
    test.concurrent(`Sample API ${index + 1} matches snapshot`, async ({ expect }) => {
      expect(await generateSpec(har)).toMatchSnapshot();
    });
    test.concurrent(`Sample API ${index + 1} is valid schema`, async ({ expect }) => {
      const spec = await generateSpec(har);
      const result = validator.validate(spec.spec as any);
      expect(result.errors).toHaveLength(0);
    });
  });
});
