import type { SchemaObject } from "@loopback/openapi-v3-types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BOOLEAN_REGEX = /^(?:true|false)$/i;
const INTEGER_REGEX = /^[+-]?\d+$/;
const NUMBER_REGEX = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const getIntegerDigits = (value: string) => {
  const normalized = value.replace(/^[+-]/, "");
  const [integerPart = normalized] = normalized.split(/[.eE]/);
  return integerPart.replace(/\D/g, "");
};

const hasLeadingZeroes = (value: string) => {
  const normalized = value.replace(/^[+-]/, "");
  if (!normalized.length) {
    return false;
  }

  if (normalized.startsWith("0.") || normalized === "0") {
    return false;
  }

  return /^0\d/.test(normalized);
};

const cloneSchema = (schema: SchemaObject): SchemaObject => {
  return JSON.parse(JSON.stringify(schema)) as SchemaObject;
};

const getComparableScalarSignature = (schema: SchemaObject) => {
  return JSON.stringify({
    type: schema.type,
    format: schema.format,
    pattern: schema.pattern,
  });
};

const isStringSchema = (schema: SchemaObject | undefined) => {
  return Boolean(schema && schema.type === "string" && !schema.format);
};

export const isUuidLike = (value: string) => {
  return UUID_REGEX.test(value);
};

export const isDateLike = (value: string) => {
  return ISO_DATE_REGEX.test(value);
};

export const isDateTimeLike = (value: string) => {
  return ISO_DATE_TIME_REGEX.test(value);
};

export const isBooleanLike = (value: string) => {
  return BOOLEAN_REGEX.test(value);
};

export const isIntegerLike = (value: string) => {
  return INTEGER_REGEX.test(value);
};

export const isNumberLike = (value: string) => {
  return NUMBER_REGEX.test(value);
};

export const getNumericCharacterCount = (value: string) => {
  return value.replace(/\D/g, "").length;
};

export const inferScalarSchema = (rawValue: string, inferParameterTypes = true): SchemaObject => {
  if (!inferParameterTypes) {
    return { type: "string" };
  }

  const value = rawValue.trim();

  if (!value.length) {
    return { type: "string" };
  }

  if (isBooleanLike(value)) {
    return { type: "boolean" };
  }

  if (isUuidLike(value)) {
    return { type: "string", format: "uuid" };
  }

  if (isDateTimeLike(value)) {
    return { type: "string", format: "date-time" };
  }

  if (isDateLike(value)) {
    return { type: "string", format: "date" };
  }

  if (isIntegerLike(value) && !hasLeadingZeroes(value)) {
    return { type: "integer" };
  }

  if (isNumberLike(value) && !hasLeadingZeroes(value)) {
    return { type: "number" };
  }

  return { type: "string" };
};

export const coerceExampleValue = (rawValue: string, schema: SchemaObject) => {
  const value = rawValue.trim();
  switch (schema.type) {
    case "boolean":
      return value.toLowerCase() === "true";
    case "integer":
    case "number":
      return Number(value);
    default:
      return rawValue;
  }
};

export const mergeScalarSchemas = (current: SchemaObject | undefined, next: SchemaObject): SchemaObject => {
  if (!current) {
    return cloneSchema(next);
  }

  if (getComparableScalarSignature(current) === getComparableScalarSignature(next)) {
    return cloneSchema(current);
  }

  if (
    (current.type === "integer" && next.type === "number") ||
    (current.type === "number" && next.type === "integer")
  ) {
    return { type: "number" };
  }

  if (isStringSchema(current) || isStringSchema(next)) {
    return { type: "string" };
  }

  if (current.type === "string" && next.type === "string") {
    return current.format === next.format ? cloneSchema(current) : { type: "string" };
  }

  return { type: "string" };
};

export const getNumericParameterSchema = (rawValue: string, inferParameterTypes: boolean): SchemaObject => {
  if (!inferParameterTypes) {
    return { type: "string" };
  }

  const inferred = inferScalarSchema(rawValue, true);
  if (inferred.type === "integer" || inferred.type === "number") {
    return inferred;
  }

  return { type: "string" };
};

export const getIntegerDigitCount = (value: string) => {
  return getIntegerDigits(value).length;
};
