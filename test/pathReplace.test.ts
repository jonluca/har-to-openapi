import { describe, test } from "vitest";
import { generateSpec } from "../src";
import { OpenAPISchemaValidator, pathReplaceHar } from "./test-utils";

const har = pathReplaceHar();
const validator = new OpenAPISchemaValidator({
  version: 3,
});
describe("pathReplace URLs", async () => {
  test(`Can parse pathReplace`, async ({ expect }) => {
    const data = await generateSpec(har, {
      attemptToParameterizeUrl: true,
      pathReplace: {
        "9zkhruw7w1zMWOC1J2SGSti2Jf8j": "6d554f25-b415-4f38-b990-a0efcea6fede",
      },
    });
    expect(data).toBeDefined();
    expect(data).toMatchSnapshot();
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });
});
