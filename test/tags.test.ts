import { describe, test } from "vitest";
import { generateSpec } from "../src";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";
import { loadImpact } from "./test-utils";

const loginRequestTag = "Login Request";
const loginRequestTagTwo = "Second Login Request Tag";
const loginTag = "login";
const har = loadImpact();

describe("Tags", async () => {
  test(`Adds tags to paths - single string array`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [[loginTag]] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginTag]);
  });
  test(`Adds tags to paths - single string`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [loginTag] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginTag]);
  });

  test(`Adds tags to paths - string array with tag name`, async ({ expect }) => {
    const data = await generateSpec(har, { tags: [[loginTag, loginRequestTag]] });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginRequestTag]);
  });

  test(`Adds tags to paths - multiple tags`, async ({ expect }) => {
    const data = await generateSpec(har, {
      tags: [[loginTag, loginRequestTag], [loginTag, loginRequestTagTwo], loginTag],
    });
    const loginPath = data.spec.paths["/login"] as PathItemObject;
    expect(loginPath).toBeDefined();
    expect(loginPath.post?.tags).toEqual([loginRequestTag, loginRequestTagTwo, loginTag]);
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
  });
});
