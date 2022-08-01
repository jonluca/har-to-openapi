import { describe, test } from "vitest";
import OpenAPISchemaValidator from "openapi-schema-validator";
import { generateSpec } from "../src";
import { fileURLToPath } from "url";
import * as path from "path";
import { dirname } from "path";
import fs from "fs/promises";
import type { Har } from "har-format";
import jsonic from "jsonic";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const readDirectory = async (dir: string) => {
  const files = await fs.readdir(dir);

  const values = files.map(async (file) => {
    try {
      const filePath = path.join(dir, file);
      const contents = await fs.readFile(filePath);
      return { file, har: jsonic(contents.toString()) };
    } catch (e) {
      console.error(`Failed to parse ${file}: ${e}`);
      return {};
    }
  }) as Array<Promise<{ file: string; har: Har }>>;

  const contents = await Promise.all(values);
  return contents;
};

const hars = await readDirectory(path.join(__dirname, "data"));

const validator = new OpenAPISchemaValidator({
  version: 3,
});

describe("har-to-openapi", () => {
  for (const entry of hars) {
    const { file, har } = entry;
    test(`Sample API ${file} matches snapshot`, async ({ expect }) => {
      expect(await generateSpec(har)).toMatchSnapshot();
    });
    test(`Sample API ${file} is valid schema`, async ({ expect }) => {
      const spec = await generateSpec(har);
      const result = validator.validate(spec.spec as any);
      expect(result.errors).toHaveLength(0);
    });
  }
});
