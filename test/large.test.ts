import { describe, test } from "vitest";
import { largeHar } from "./test-utils.js";
import { generateSpec } from "../src/index.js";

const largeHarBody = largeHar();

describe("Large har tests", async () => {
  test(`works on large hars`, async ({ expect }) => {
    const dataTwo = await generateSpec(largeHarBody, { logErrors: true });
    expect(dataTwo).toBeDefined();
    expect(dataTwo).toMatchSnapshot();
  });
  test(`parameterizes numeric paths when minLengthForNumericPath is set`, async ({ expect }) => {
    const dataTwo = await generateSpec(largeHarBody, { minLengthForNumericPath: 0, attemptToParameterizeUrl: true });
    expect(dataTwo).toBeDefined();
    expect(dataTwo).toMatchSnapshot();
  });
});
