import { describe, test } from "vitest";
import { generateSpec } from "../src";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";
import type { OpenApiSpec } from "@loopback/openapi-v3-types";
import { customMethod } from "./test-utils";
import { isStandardMethod } from "../src/utils/methods";

const har = customMethod();
const pathItemKeysNotMethods = ["$ref", "summary", "description", "parameters", "servers"];
const getMethods = (spec: OpenApiSpec): string[] => {
  const paths = spec.paths;
  const values = Object.values(paths) as PathItemObject[];
  const methods = new Set<string>();
  values.flatMap((path) => {
    Object.keys(path).forEach((l) => pathItemKeysNotMethods.includes(l) || methods.add(l));
  });
  return Array.from(methods);
};

describe("Relaxed methods", async () => {
  test(`Only includes valid spec methods by default`, async ({ expect }) => {
    const data = await generateSpec(har);
    const methods = getMethods(data.spec);
    const abnormalMethods = methods.filter((l) => !isStandardMethod(l));
    expect(abnormalMethods).toHaveLength(0);
  });
  test(`Includes any method when relaxed methods is true`, async ({ expect }) => {
    const data = await generateSpec(har, { relaxedMethods: true });
    const methods = getMethods(data.spec);
    const abnormalMethods = methods.filter((l) => !isStandardMethod(l));
    expect(abnormalMethods).toHaveLength(1);
  });
});
