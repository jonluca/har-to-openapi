import type { Cookie } from "har-format";
import { camelCase, startCase, uniq } from "lodash";
import type { ParameterObject, SchemaObject } from "@loopback/openapi-v3-types";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const dateRegex =
  /(((20[012]\d|19\d\d)|(1\d|2[0123]))-((0[0-9])|(1[012]))-((0[1-9])|([12][0-9])|(3[01])))|(((0[1-9])|([12][0-9])|(3[01]))-((0[0-9])|(1[012]))-((20[012]\d|19\d\d)|(1\d|2[0123])))|(((20[012]\d|19\d\d)|(1\d|2[0123]))\/((0[0-9])|(1[012]))\/((0[1-9])|([12][0-9])|(3[01])))|(((0[0-9])|(1[012]))\/((0[1-9])|([12][0-9])|(3[01]))\/((20[012]\d|19\d\d)|(1\d|2[0123])))|(((0[1-9])|([12][0-9])|(3[01]))\/((0[0-9])|(1[012]))\/((20[012]\d|19\d\d)|(1\d|2[0123])))|(((0[1-9])|([12][0-9])|(3[01]))\.((0[0-9])|(1[012]))\.((20[012]\d|19\d\d)|(1\d|2[0123])))|(((20[012]\d|19\d\d)|(1\d|2[0123]))\.((0[0-9])|(1[012]))\.((0[1-9])|([12][0-9])|(3[01])))/;

export const getTypenameFromPath = (path: string) => {
  const parts = path.split(/[/|${|-}]/g);
  const partsToKeep = [];
  for (const part of parts) {
    // if its blank, skip
    if (!part.length) {
      continue;
    }
    // if its a UUID, skip it
    if (uuidRegex.test(part)) {
      partsToKeep.push("By UUID");
      continue;
    }
    if (part.length > 3 && !isNaN(Number(part))) {
      partsToKeep.push("By ID");
      continue;
    }
    if (dateRegex.test(part)) {
      partsToKeep.push("By Date");
      continue;
    }

    if (part === "true" || part === "false") {
      partsToKeep.push(`set${startCase(part)}`);
      continue;
    }
    partsToKeep.push(part);
  }
  // kind of heuristics, but we want to filter out things that are like uuids or just numbers
  return uniq(partsToKeep).join(" ");
};
export const parameterizeUrl = (path: string) => {
  const parts = path.split(/[/|${|-}]/g);
  const parameterizedParts = [];
  const parameters: ParameterObject[] = [];
  const addParameter = (
    id: string,
    part: string,
    type: SchemaObject["type"] = "string",
    extraSchemaParts?: Partial<SchemaObject>,
  ) => {
    const prefix = id;
    const count = parameters.filter((p) => p.name.startsWith(prefix)).length;
    const suffix = count > 0 ? `${count}` : "";
    const name = `${prefix}${suffix}`;
    parameters.push({
      in: "path",
      name,
      required: true,
      schema: { type, default: part, ...extraSchemaParts },
      example: part,
    } as ParameterObject);
    parameterizedParts.push(`{${name}}`);
  };
  for (const part of parts) {
    // if its blank, skip
    if (!part.length) {
      continue;
    }
    // if its a UUID, skip it
    if (uuidRegex.test(part)) {
      addParameter("uuid", part, "string", {
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        minLength: 36,
        maxLength: 36,
      });
      continue;
    }
    if (dateRegex.test(part)) {
      addParameter("date", part, "string", { format: "date" });
      continue;
    }
    // if its a number and greater than 3 digits, probably safe to skip?
    if (part.length > 3 && !isNaN(Number(part))) {
      addParameter("id", part, "integer");
      continue;
    }
    if (part === "true" || part === "false") {
      addParameter("bool", part, "boolean");
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
