import type { SchemaObject } from "@loopback/openapi-v3-types";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

/** Record observations separately from contractual requirements inferred from them. */
export const applyObservations = (
  schema: SchemaObject,
  samples: unknown[],
  requiredness: "legacy" | "optional" | "observed",
  includeEvidence: boolean,
): void => {
  if (requiredness === "optional") {
    delete schema.required;
  }
  const objects = samples.filter(isObject);
  const fields: Record<string, { presentCount: number; presenceRatio: number }> = Object.create(null);
  if (schema.properties) {
    const required: string[] = [];
    for (const [name, property] of Object.entries(schema.properties)) {
      const present = objects.filter((sample) => Object.hasOwn(sample, name));
      fields[name] = {
        presentCount: present.length,
        presenceRatio: objects.length ? present.length / objects.length : 0,
      };
      if (objects.length && present.length === objects.length) {
        required.push(name);
      }
      if (!("$ref" in property)) {
        applyObservations(
          property,
          present.map((sample) => sample[name]),
          requiredness,
          includeEvidence,
        );
      }
    }
    if (requiredness === "observed") {
      if (required.length) {
        schema.required = required;
      } else {
        delete schema.required;
      }
    }
  }
  if (includeEvidence) {
    (schema as Record<string, unknown>)["x-har-observations"] = {
      sampleCount: samples.length,
      ...(schema.properties ? { fields } : {}),
    };
  }
  if (schema.items && !("$ref" in schema.items)) {
    applyObservations(schema.items, samples.filter(Array.isArray).flat(), requiredness, includeEvidence);
  }
  for (const alternatives of [schema.anyOf, schema.oneOf, schema.allOf]) {
    for (const alternative of alternatives ?? []) {
      if ("$ref" in alternative) {
        continue;
      }
      const matching = samples.filter((value) => {
        if ((alternative as { type?: string }).type === "null") {
          return value === null;
        }
        if (value === null && alternative.nullable) {
          return true;
        }
        if (alternative.type === "object") {
          return isObject(value);
        }
        if (alternative.type === "array") {
          return Array.isArray(value);
        }
        if (alternative.type === "integer") {
          return typeof value === "number" && Number.isInteger(value);
        }
        if (alternative.type) {
          return typeof value === alternative.type;
        }
        return true;
      });
      applyObservations(alternative, matching, requiredness, includeEvidence);
    }
  }
};
