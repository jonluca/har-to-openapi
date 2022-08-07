import { describe, test } from "vitest";
import { generateSpecs } from "../src";
import { basePath } from "./test-utils";

const har = basePath();

describe("Spec generator", async () => {
  test(`Returns two specs for a har with two domains`, async ({ expect }) => {
    const data = await generateSpecs(har);
    expect(data).toHaveLength(2);
  });
  test(`Returns one spec for a har with two domains and a string filter`, async ({ expect }) => {
    const data = await generateSpecs(har, { urlFilter: "example.com" });
    expect(data).toHaveLength(1);
  });
  test(`Returns one spec for a har with two domains and a regex filter`, async ({ expect }) => {
    const data = await generateSpecs(har, { urlFilter: /example\.com/ });
    expect(data).toHaveLength(1);
  });
  test(`Returns one spec for a har with two domains and a callback filter`, async ({ expect }) => {
    const data = await generateSpecs(har, { urlFilter: (url) => url.includes("example.com") });
    expect(data).toHaveLength(1);
  });
  test(`Returns one spec for a har with two domains and an async callback filter`, async ({ expect }) => {
    const data = await generateSpecs(har, { urlFilter: async (url) => url.includes("example.com") });
    expect(data).toHaveLength(1);
  });
  test(`Returns one spec for a har with two domains and forceAllRequestsInSameSpec set to true`, async ({ expect }) => {
    const data = await generateSpecs(har, { forceAllRequestsInSameSpec: true });
    expect(data).toHaveLength(1);
  });
});
