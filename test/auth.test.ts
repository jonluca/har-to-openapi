import { describe, test } from "vitest";
import { generateSpec } from "../src/index.js";
import { authVariantsHar } from "./test-utils.js";

describe("Authentication extraction", async () => {
  test("builds bearer, basic, api key, and auth-like cookie security schemes from HAR headers", async ({ expect }) => {
    const data = await generateSpec(authVariantsHar());
    const schemes = data.spec.components?.securitySchemes;

    expect(schemes).toMatchObject({
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
      basicAuth: {
        type: "http",
        scheme: "basic",
      },
      "X-Api-Key": {
        type: "apiKey",
        in: "header",
        name: "X-Api-Key",
      },
      cookieSessionId: {
        type: "apiKey",
        in: "cookie",
        name: "session_id",
      },
    });
    expect(schemes).not.toHaveProperty("cookieCsrfToken");

    expect(data.spec.paths["/bearer"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(data.spec.paths["/basic"].get.security).toEqual([{ basicAuth: [] }]);
    expect(data.spec.paths["/custom"].get.security).toEqual([{ "X-Api-Key": [] }]);
    expect(data.spec.paths["/cookie"].get.security).toEqual([
      {
        cookieSessionId: [],
      },
    ]);
  });
});
