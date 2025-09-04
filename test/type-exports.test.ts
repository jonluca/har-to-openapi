import { describe, it, expect } from "vitest";
import type { HarToOpenAPIConfig, HarToOpenAPISpec } from "../src/index";
import { generateSpec } from "../src/index";

describe("Type exports", () => {
  it("should be able to import HarToOpenAPIConfig type", () => {
    // Test that HarToOpenAPIConfig can be used as a type
    const config: HarToOpenAPIConfig = {
      forceAllRequestsInSameSpec: true,
      guessAuthenticationHeaders: false,
      filterStandardHeaders: true,
      logErrors: false,
    };

    expect(config).toBeDefined();
    expect(config.forceAllRequestsInSameSpec).toBe(true);
    expect(config.guessAuthenticationHeaders).toBe(false);
  });

  it("should be able to import HarToOpenAPISpec type", () => {
    // Test that HarToOpenAPISpec can be used as a type
    const spec: Partial<HarToOpenAPISpec> = {
      domain: "example.com",
      yamlSpec: "openapi: 3.0.0",
    };

    expect(spec).toBeDefined();
    expect(spec.domain).toBe("example.com");
    expect(spec.yamlSpec).toBe("openapi: 3.0.0");
  });

  it("should be able to use HarToOpenAPIConfig with generateSpec function", async () => {
    const config: HarToOpenAPIConfig = {
      forceAllRequestsInSameSpec: true,
      logErrors: false,
    };

    const emptyHar = {
      log: {
        version: "1.2",
        entries: [],
      },
    };

    const result = await generateSpec(emptyHar, config);
    expect(result).toBeDefined();
    expect(result.spec).toBeDefined();
    expect(result.yamlSpec).toBeDefined();
  });
});