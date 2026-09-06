import type { HarToOpenAPIConfig } from "./types.js";

/** Validate JSON/YAML callers as well as typed library callers before processing captures. */
export const validateConfig = (config: HarToOpenAPIConfig = {}) => {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Configuration must be an object.");
  }
  const enums = {
    openapiVersion: ["3.0.0", "3.1.0"],
    examples: ["single", "multiple", "none"],
    requiredness: ["legacy", "optional", "observed"],
  } as const;
  for (const [key, values] of Object.entries(enums)) {
    const value = config[key as keyof typeof enums];
    if (value !== undefined && !(values as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${key}; expected ${values.join(", ")}.`);
    }
  }
  for (const key of ["maxExamples", "maxExampleBytes", "minLengthForNumericPath"] as const) {
    const value = config[key];
    const minimum = key === "minLengthForNumericPath" ? 0 : 1;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new Error(`${key} must be an integer of at least ${minimum}.`);
    }
  }
  for (const key of [
    "reusableSchemas",
    "inferArrayParameters",
    "parseBracketParameters",
    "includeInferenceEvidence",
    "includeReport",
    "strict",
    "validate",
    "forceAllRequestsInSameSpec",
    "addServersToPaths",
    "guessAuthenticationHeaders",
    "relaxedMethods",
    "relaxedContentTypeJsonParse",
    "includeNonJsonExampleResponses",
    "inferParameterTypes",
    "filterStandardHeaders",
    "logErrors",
    "attemptToParameterizeUrl",
    "dropPathsWithoutSuccessfulResponse",
  ] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new Error(`${key} must be a boolean.`);
    }
  }
  for (const key of ["includeDomains", "excludeDomains", "mimeTypes", "securityHeaders", "sourceNames"] as const) {
    if (
      config[key] !== undefined &&
      (!Array.isArray(config[key]) || config[key].some((value) => typeof value !== "string"))
    ) {
      throw new Error(`${key} must be an array of strings.`);
    }
  }
  for (const key of ["infoTitle", "infoVersion", "infoDescription"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") {
      throw new Error(`${key} must be a string.`);
    }
  }
  for (const key of ["onReport", "onDiagnostic"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "function") {
      throw new Error(`${key} must be a function.`);
    }
  }
  if (
    config.ignoreBodiesForStatusCodes !== undefined &&
    (!Array.isArray(config.ignoreBodiesForStatusCodes) ||
      config.ignoreBodiesForStatusCodes.some((value) => !Number.isInteger(value) || value < 0 || value > 599))
  ) {
    throw new Error("ignoreBodiesForStatusCodes must contain HTTP status codes.");
  }
  for (const key of ["pathReplace", "schemaNames"] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.values(value).some((entry) => typeof entry !== "string"))
    ) {
      throw new Error(`${key} must map strings to strings.`);
    }
  }
  if (config.redact !== undefined) {
    if (!config.redact || typeof config.redact !== "object" || Array.isArray(config.redact)) {
      throw new Error("redact must be an object.");
    }
    for (const key of ["headers", "queryParameters", "cookies", "bodyProperties", "bodyPointers"] as const) {
      const value = config.redact[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
        throw new Error(`redact.${key} must be an array of strings.`);
      }
    }
    if (config.redact.replacement !== undefined && typeof config.redact.replacement !== "string") {
      throw new Error("redact.replacement must be a string.");
    }
  }
};
