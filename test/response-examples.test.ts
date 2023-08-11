import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { htmlHar } from "./test-utils";
import type { HarToOpenAPISpec } from "../src/types";

const har = htmlHar();

const getTextExamples = (output: HarToOpenAPISpec) => {
  const examples = Object.values(output.spec.paths)
    .flatMap((l) => l.get)
    .flatMap((l) => l.responses["200"]["content"])
    .flatMap((content) => {
      const keysToCheck = Object.keys(content).filter((l) => l.includes("text"));
      return keysToCheck.map((key) => content[key].example);
    })
    .filter(Boolean);
  return examples;
};
describe("Examples in request bodies option", async () => {
  test(`Does not include examples for non-json text responses`, async ({ expect }) => {
    const data = await generateSpec(har);
    const examples = getTextExamples(data);
    expect(examples).toHaveLength(0);
  });
  test(`Includes examples for non-json text responses when option is true`, async ({ expect }) => {
    const data = await generateSpec(har, { includeNonJsonExampleResponses: true });
    const examples = getTextExamples(data);
    expect(examples).not.toHaveLength(0);
  });
});
