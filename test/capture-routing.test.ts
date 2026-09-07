import type { Entry, Har } from "har-format";
import { describe, expect, test } from "vitest";
import { generateSpec, generateSpecsWithReport } from "../src/index.js";

const entry = (url: string, status: number = 200): Entry =>
  ({
    request: { url, method: "GET", headers: [], queryString: [], cookies: [] },
    response: {
      status,
      headers: [],
      cookies: [],
      content: { mimeType: "application/json", text: '{"ok":true}', size: 11 },
    },
  }) as unknown as Entry;
const capture = (...entries: Entry[]): Har => ({ log: { entries } }) as Har;

describe("capture routing regressions", () => {
  test.each(["g", "y"])("evaluates a %s URL filter independently for every entry", async (flags) => {
    const urlFilter = new RegExp("https://api\\.test/items", flags);
    urlFilter.lastIndex = 5;
    const { report } = await generateSpecsWithReport(
      capture(...Array.from({ length: 3 }, () => entry("https://api.test/items"))),
      { urlFilter },
    );

    expect(report).toMatchObject({ processedEntries: 3, filteredEntries: 0, operations: 1 });
    expect(urlFilter.lastIndex).toBe(5);
  });

  test("preserves trailing slashes and empty segments when parameterizing paths", async () => {
    const paths = ["/items/123", "/items/123/", "/items//123", "/items//"];
    const { spec } = await generateSpec(capture(...paths.map((path) => entry(`https://api.test${path}`))), {
      attemptToParameterizeUrl: true,
      minLengthForNumericPath: 0,
      validate: true,
    });

    expect(Object.keys(spec.paths).sort()).toEqual(["/items/{id}", "/items/{id}/", "/items//{id}", "/items//"].sort());
    expect(spec.paths["/items//"].parameters).toBeUndefined();
  });

  test("does not infer response bodies under invalid HTTP status keys", async () => {
    const statuses = [-1, 99, 600, 200.5, "200" as unknown as number, 200];
    const { specs, report } = await generateSpecsWithReport(
      capture(...statuses.map((status) => entry("https://api.test/items", status))),
    );

    expect(Object.keys(specs[0].spec.paths["/items"].get.responses)).toEqual(["200"]);
    expect(report.diagnostics.filter((diagnostic) => diagnostic.code === "response-missing")).toHaveLength(5);
  });

  test("retains all observed servers for a merged operation", async () => {
    const { spec } = await generateSpec(
      capture(
        entry("https://api.test:8443/items"),
        entry("http://api.test:8080/items"),
        entry("https://other.test/items"),
        entry("https://api.test:8443/items"),
        entry("https://unrelated.test/other"),
      ),
      { forceAllRequestsInSameSpec: true, addServersToPaths: true, validate: true },
    );

    expect(spec.paths["/items"].get.servers).toEqual([
      { url: "https://api.test:8443" },
      { url: "http://api.test:8080" },
      { url: "https://other.test" },
    ]);
    expect(spec.paths["/other"].get.servers).toEqual([{ url: "https://unrelated.test" }]);
  });
});
