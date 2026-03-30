import { describe, test } from "vitest";
import { generateSpec } from "../src/index.js";
import { noSuccessStatusHar } from "./test-utils.js";

const har = noSuccessStatusHar();

describe("Option filters", async () => {
  test(`Includes paths without successful statuses by default`, async ({ expect }) => {
    const data = await generateSpec(har);
    expect(data).toBeDefined();
  });
  test(`Doesn't include paths when no successful responses exist`, async ({ expect }) => {
    const data = await generateSpec(har, { dropPathsWithoutSuccessfulResponse: true });
    expect(data).toBeDefined();
    expect(data.spec.info.title).toEqual("HarToOpenApi - no valid specs found");
  });
});
