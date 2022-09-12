import { fileURLToPath } from "url";
import path, { dirname } from "path";
import fs from "fs";
import type { Har } from "har-format";
import { vi } from "vitest";

const date = new Date("01/01/2022 0:00:00 GMT");
vi.useFakeTimers();
vi.setSystemTime(date);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = path.join(__dirname, "data");
const readDirectory = (dir: string): { file: string; har: Har }[] => {
  const files = fs.readdirSync(dir);
  const all = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const contents = JSON.parse(fs.readFileSync(filePath, { encoding: "utf8" })) as unknown as Har;
    all.push({ file, har: contents });
  }
  return all;
};

const readHar = (name: string): Har =>
  JSON.parse(fs.readFileSync(path.join(dataDir, name), { encoding: "utf8" })) as unknown as Har;

export const sampleHar = () => readHar("request-generator-all-status-and-method.har");
export const postDataConflict = () => readHar("post-data-conflict.har");
export const loadImpact = () => readHar("load-impact.har");
export const invalidUrl = () => readHar("invalid-url.har");
export const parameterizedUrlHar = () => readHar("url.har");
export const formDataHar = () => readHar("formdata.har");
export const noSuccessStatusHar = () => readHar("no-success-status.har");
export const securityHar = () => readHar("security.har");
export const basePath = () => readHar("base-path.har");
export const invalidJson = () => readHar("post-json-invalid.har");
export const sameEndpointDiffPayloads = () => readHar("post-same-endpoint-diff-bodies.har");
export const customMethod = () => readHar("custom-method.har");

export const allTestHars = () => readDirectory(path.join(__dirname, "data"));
