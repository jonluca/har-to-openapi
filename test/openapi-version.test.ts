import { describe, test } from "vitest";
import { generateSpec } from "../src/index.js";
import { basePath, createOpenApiValidator } from "./test-utils.js";

describe("OpenAPI version selection", async () => {
  test("emits OpenAPI 3.1.0 when requested", async ({ expect }) => {
    const data = await generateSpec(basePath(), { openapiVersion: "3.1.0" });
    const validator = createOpenApiValidator("3.1.0");

    expect(data.spec.openapi).toBe("3.1.0");
    expect(validator.validate(data.spec as any).errors).toHaveLength(0);
  });
});
