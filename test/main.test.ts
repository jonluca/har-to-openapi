import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { invalidJson, invalidUrl, largeHar, securityHar } from "./test-utils";
import { generateSpec } from "../src";

const securityHeader = securityHar();
const largeHarBody = largeHar();
const invalidJsonHar = invalidJson();
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
  test(`Crash on sort JSON`, async ({ expect }) => {
    vi.mock("../src/utils/sortObject", () => {
      return {
        sortObject: () => {
          throw new Error("asdf");
        },
      };
    });
    const data = await generateSpec(securityHeader, { logErrors: true });
    expect(console.error).toHaveBeenCalled();
    expect(data).toBeDefined();
  });
  test(`Logs errors for invalid json`, async ({ expect }) => {
    const data = await generateSpec(invalidJsonHar, { logErrors: true });
    expect(data).toBeDefined();
    expect(console.error).toHaveBeenCalled();
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
