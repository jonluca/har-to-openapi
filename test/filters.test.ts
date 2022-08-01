import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { dirname } from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type { Har } from "har-format";
import * as path from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contents = JSON.parse(
  fs.readFileSync(path.join(__dirname, "./data/sample.har"), { encoding: "utf8" }),
) as unknown as Har;

describe("Option filters", async () => {
  test(`Filters out standard headers`, async ({ expect }) => {
    const data = await generateSpec(contents, { filterStandardHeaders: true });
  });
  test(`Keeps out standard headers`, async ({ expect }) => {
    const data = await generateSpec(contents, { filterStandardHeaders: false });
  });
  test(`Filters to mimetype`, async ({ expect }) => {
    const data = await generateSpec(contents, { mimeTypes: ["application/json"] });
  });
  test(`Filters to mimetype`, async ({ expect }) => {
    const data = await generateSpec(contents, { filterStandardHeaders: false });
  });
});
