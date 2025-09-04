import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { invalidUrl, largeHar } from "./test-utils.js";
import { generateSpec } from "../src/index.js";

const largeHarBody = largeHar();
const invalidUrlHar = invalidUrl();
const original = console.error;

describe("Body and header tests", async () => {
  beforeAll(async () => {
    const interceptedError = () => {
      // no op
    };
    console.error = interceptedError;
    vi.spyOn(console, "error");
  });
  afterAll(async () => {
    console.error = original;
  });
  test(`Logs errors for invalid urls`, async ({ expect }) => {
    const dataTwo = await generateSpec(invalidUrlHar, { logErrors: true });
    expect(dataTwo).toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });

  test(`works on large hars`, async ({ expect }) => {
    const dataTwo = await generateSpec(largeHarBody, { logErrors: true });
    expect(dataTwo).toBeDefined();
    expect(console.error).toHaveBeenCalled();
  });
});
