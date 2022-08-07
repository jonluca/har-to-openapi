import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { invalidUrl } from "./test-utils";

const invalidHar = invalidUrl();

describe("Option filters", async () => {
  test(`Doesn't crash on invalid json`, async ({ expect }) => {
    const data = await generateSpec(invalidHar, { filterStandardHeaders: true });
    expect(data).toBeDefined();
  });
  test(`Doesn't crash on invalid json`, async ({ expect }) => {
    const data = await generateSpec(invalidHar, { filterStandardHeaders: true });
    expect(data).toBeDefined();
  });
});
