import { describe, test } from "vitest";
import { generateSpec } from "../src";
import type { PathItemObject } from "@loopback/openapi-v3-types";
import { loadImpact } from "./test-utils";
import OpenAPISchemaValidator from "openapi-schema-validator";

const loginRequestTag = "Login Request";
const loginRequestTagTwo = "Second Login Request Tag";
const loginTag = "login";
const har = loadImpact();
const validator = new OpenAPISchemaValidator({
  version: 3,
});
describe("Tags", async () => {
  test(`Adds tags to paths - single string array`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [[loginTag]] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginTag]);
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });
  test(`Adds tags to paths - single string`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [loginTag] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginTag]);
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });

  test(`Adds tags to paths - string array with tag name`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [[loginTag, loginRequestTag]] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginRequestTag]);
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });

  test(`Adds tags to paths - multiple tags`, async ({ expect }) => {
    const data = await generateSpec(har, {
      tags: [[loginTag, loginRequestTag], [loginTag, loginRequestTagTwo], loginTag],
    });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginRequestTag, loginRequestTagTwo, loginTag]);
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });
  test(`Adds tags to paths - function tag`, async ({ expect }) => {
    const data = await generateSpec(har, {
      tags: (path: string) => {
        if (path.includes(loginTag)) {
          return loginTag;
        }
      },
    });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginTag]);
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });
  test(`Adds tags to paths - function tag with no response`, async ({ expect }) => {
    const data = await generateSpec(har, {
      tags: () => {
        return;
      },
    });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).not.toBeDefined();
    const result = validator.validate(data.spec as any);
    expect(result.errors).toHaveLength(0);
  });
});
