import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { binaryHar, htmlHar } from "./test-utils";
import type { HarToOpenAPISpec } from "../src/types";
import type { OperationObject } from "openapi3-ts/src/model/OpenApi";

const har = htmlHar();
const binary = binaryHar();

const getTextExamples = (output: HarToOpenAPISpec) => {
  const paths = Object.values(output.spec.paths);
  const operationObjects = paths.flatMap((l) => [l.get, l.post] as OperationObject[]).filter(Boolean);
  const examples = operationObjects
    .filter(Boolean)
    .flatMap((l: OperationObject) => {
      return Object.values(l.responses || {}).map((k) => k["content"]);
    })
    .flatMap((content) => {
      const keysToCheck = Object.keys(content).filter((l) => !l.includes("json"));
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
  test(`Includes examples for non-json binary responses when option is true`, async ({ expect }) => {
    const data = await generateSpec(binary, { includeNonJsonExampleResponses: true });
    const examples = getTextExamples(data);
    expect(examples).not.toHaveLength(0);
  });
});
