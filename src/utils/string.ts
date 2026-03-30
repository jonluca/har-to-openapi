import type { Cookie } from "har-format";
import type { ParameterObject, SchemaObject } from "@loopback/openapi-v3-types";
import { camelCase, startCase, uniq } from "lodash-es";
import {
  coerceExampleValue,
  getIntegerDigitCount,
  getNumericParameterSchema,
  inferScalarSchema,
  isBooleanLike,
  isDateLike,
  isDateTimeLike,
  isUuidLike,
} from "./inference.js";

export const getTypenameFromPath = (path: string) => {
  const parts = path.split(/[/|${|-}]/g);
  const partsToKeep = [];
  for (const part of parts) {
    // if its blank, skip
    if (!part.length) {
      continue;
    }
    // if its a UUID, skip it
    if (isUuidLike(part)) {
      partsToKeep.push("By UUID");
      continue;
    }
    if (getIntegerDigitCount(part) >= 3 && !isNaN(Number(part))) {
      partsToKeep.push("By ID");
      continue;
    }
    if (isDateTimeLike(part)) {
      partsToKeep.push("By Date Time");
      continue;
    }
    if (isDateLike(part)) {
      partsToKeep.push("By Date");
      continue;
    }

    if (isBooleanLike(part)) {
      partsToKeep.push(`set${startCase(part)}`);
      continue;
    }
    partsToKeep.push(part);
  }
  // kind of heuristics, but we want to filter out things that are like uuids or just numbers
  return uniq(partsToKeep).join(" ");
};
export const parameterizeUrl = (path: string, minLengthForNumericPath = 3, inferParameterTypes = true) => {
  const parts = path.split("/").filter(Boolean);
  const parameterizedParts = [];
  const parameters: ParameterObject[] = [];
  const addParameter = (id: string, part: string, schema: SchemaObject) => {
    const prefix = id;
    const count = parameters.filter((p) => p.name.startsWith(prefix)).length;
    const suffix = count > 0 ? `${count}` : "";
    const name = `${prefix}${suffix}`;
    const example = coerceExampleValue(part, schema);
    parameters.push({
      in: "path",
      name,
      required: true,
      schema: { ...schema, default: example },
      example,
    } as ParameterObject);
    parameterizedParts.push(`{${name}}`);
  };
  for (const part of parts) {
    if (isUuidLike(part)) {
      addParameter("uuid", part, inferScalarSchema(part, inferParameterTypes));
      continue;
    }
    if (isDateTimeLike(part)) {
      addParameter("dateTime", part, inferScalarSchema(part, inferParameterTypes));
      continue;
    }
    if (isDateLike(part)) {
      addParameter("date", part, inferScalarSchema(part, inferParameterTypes));
      continue;
    }
    if (getIntegerDigitCount(part) >= minLengthForNumericPath && !isNaN(Number(part))) {
      addParameter("id", part, getNumericParameterSchema(part, inferParameterTypes));
      continue;
    }
    if (isBooleanLike(part)) {
      addParameter("bool", part, inferScalarSchema(part, inferParameterTypes));
      continue;
    }
    parameterizedParts.push(part);
  }
  // kind of heuristics, but we want to filter out things that are like uuids or just numbers
  return { path: "/" + parameterizedParts.join("/"), parameters };
};

export const getCookieSecurityName = (cookie: Cookie) => {
  const onlyAlphaNumeric = cookie.name.replace(/_/g, " ").replace(/[^a-zA-Z0-9 ]/g, "");
  return camelCase(`cookie ${onlyAlphaNumeric}`);
};
