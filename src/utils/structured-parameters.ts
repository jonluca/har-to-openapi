import type { SchemaObject } from "@loopback/openapi-v3-types";
import type { QueryString } from "har-format";
import { coerceExampleValue, inferScalarSchema, mergeScalarSchemas } from "./inference.js";

export const mergeParameterSchemas = (current: SchemaObject | undefined, next: SchemaObject): SchemaObject => {
  if (!current) {
    return structuredClone(next);
  }
  if (current.type === "array" || next.type === "array") {
    const previousItem = current.type === "array" ? current.items : current;
    const nextItem = next.type === "array" ? next.items : next;
    return {
      type: "array",
      items: mergeParameterSchemas(previousItem as SchemaObject | undefined, (nextItem ?? {}) as SchemaObject),
    };
  }
  if (current.type === "object" && next.type === "object") {
    const properties = Object.assign(Object.create(null), current.properties) as NonNullable<
      SchemaObject["properties"]
    >;
    for (const [key, property] of Object.entries(next.properties ?? {})) {
      properties[key] = mergeParameterSchemas(properties[key] as SchemaObject | undefined, property as SchemaObject);
    }
    return { type: "object", properties };
  }
  return mergeScalarSchemas(current, next);
};

export const coerceParameterExample = (value: unknown, schema: SchemaObject): unknown => {
  if (schema.type === "array") {
    return [value].flat().map((item) => coerceParameterExample(item, (schema.items ?? {}) as SchemaObject));
  }
  if (schema.type === "object" && value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        coerceParameterExample(item, (schema.properties?.[key] ?? {}) as SchemaObject),
      ]),
    );
  }
  return coerceExampleValue(String(value), schema);
};

interface ParameterObservation {
  name: string;
  schema: SchemaObject;
  rawExample: unknown;
  style?: "deepObject" | "form";
  explode?: boolean;
}

export const observeQueryParameters = (
  params: QueryString[],
  inferTypes: boolean,
  inferArrays: boolean,
  parseBrackets: boolean,
  blockedBracketRoots: Set<string> = new Set(),
): ParameterObservation[] => {
  const grouped = new Map<string, string[]>();
  for (const param of params) {
    grouped.set(param.name, [...(grouped.get(param.name) ?? []), param.value]);
  }
  const observations: ParameterObservation[] = [];
  for (const [name, values] of grouped) {
    const scalarSchema = values.reduce<SchemaObject | undefined>(
      (current, value) => mergeScalarSchemas(current, inferScalarSchema(value, inferTypes)),
      undefined,
    ) ?? { type: "string" };
    const isArray = inferArrays && values.length > 1;
    const schema: SchemaObject = isArray ? { type: "array", items: scalarSchema } : scalarSchema;
    observations.push({
      name,
      schema,
      // Coerce only after merging all schemas, so widening to string preserves
      // spellings such as 1e3, +12, and TRUE from the capture.
      rawExample: isArray ? values : values.at(-1),
      ...(isArray ? ({ style: "form", explode: true } as const) : {}),
    });
  }
  if (!parseBrackets) {
    return observations;
  }

  // OpenAPI deepObject defines one object level. Nested objects/arrays and
  // mixed scalar/object spellings are intentionally retained as literal keys.
  const bracketGroups = new Map<string, ParameterObservation[]>();
  for (const observation of observations) {
    const root = /^([^[\]]+)\[/.exec(observation.name)?.[1];
    if (root) {
      bracketGroups.set(root, [...(bracketGroups.get(root) ?? []), observation]);
    }
  }
  const replacements = new Map<string, ParameterObservation>();
  const consumed = new Set<string>();
  const unsafe = new Set(["__proto__", "prototype", "constructor"]);
  for (const [root, group] of bracketGroups) {
    if (grouped.has(root) || unsafe.has(root) || blockedBracketRoots.has(root)) {
      continue;
    }
    if (group.length === 1 && group[0].name === `${root}[]` && inferArrays) {
      const original = group[0];
      const schema: SchemaObject =
        original.schema.type === "array" ? original.schema : { type: "array", items: original.schema };
      replacements.set(original.name, {
        // Keep [] in the wire name: form+explode serializes the parameter name
        // verbatim, whereas dropping it would change tags[]=a into tags=a.
        name: original.name,
        schema,
        rawExample: [original.rawExample].flat(),
        style: "form",
        explode: true,
      });
      continue;
    }
    const fields = group.map((item) => /^([^[\]]+)\[([^[\]]+)\]$/.exec(item.name)?.[2]);
    if (
      fields.some(
        (field, index) => !field || /^\d+$/.test(field) || unsafe.has(field) || group[index].schema.type === "array",
      )
    ) {
      continue;
    }
    const properties = Object.fromEntries(group.map((item, index) => [fields[index]!, item.schema]));
    const rawExample = Object.fromEntries(group.map((item, index) => [fields[index]!, item.rawExample]));
    replacements.set(group[0].name, {
      name: root,
      schema: { type: "object", properties },
      rawExample,
      style: "deepObject",
      explode: true,
    });
    for (const item of group.slice(1)) {
      consumed.add(item.name);
    }
  }
  return observations.filter((item) => !consumed.has(item.name)).map((item) => replacements.get(item.name) ?? item);
};
