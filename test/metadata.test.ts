import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { basePath } from "./test-utils";

describe("Generated spec metadata", async () => {
  test("supports metadata templates with domain and timestamp placeholders", async ({ expect }) => {
    const data = await generateSpec(basePath(), {
      forceAllRequestsInSameSpec: true,
      infoTitle: "Captured {domain}",
      infoVersion: "build-{generatedAt}",
      infoDescription: "Spec for {domain} generated at {generatedAt}",
    });

    expect(data.spec.info.title).toBe("Captured example.com");
    expect(data.spec.info.version).toBe("build-2022-01-01T00:00:00.000Z");
    expect(data.spec.info.description).toBe("Spec for example.com generated at 2022-01-01T00:00:00.000Z");
  });
});
