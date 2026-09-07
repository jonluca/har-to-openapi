import type {
  OpenApiSpec,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ResponseObject,
  ServerObject,
} from "@loopback/openapi-v3-types";
import type { Entry, Har, QueryString, Response } from "har-format";
import * as YAML from "js-yaml";
import { cloneDeep, groupBy } from "lodash-es";
import {
  addMethod,
  addQueryStringParams,
  addRequestHeaders,
  buildRequestBodyFromSamples,
  buildResponseBodyFromSamples,
  getSecurity,
} from "./helpers.js";
import type {
  CaptureSource,
  ConversionDiagnostic,
  ConversionReport,
  HarToOpenAPIConfig,
  HarToOpenAPISpec,
  InternalConfig,
} from "./types.js";
import { postprocessSpec } from "./postprocess.js";
import { validateSpec } from "./validation.js";
import { validateConfig } from "./config.js";
import { ConversionError } from "./diagnostics.js";
import { addResponse } from "./utils/baseResponse.js";
import { DEFAULT_AUTH_HEADERS } from "./utils/headers.js";
import { mergeScalarSchemas } from "./utils/inference.js";
import { isStandardMethod } from "./utils/methods.js";
import { createApiSpec } from "./utils/spec.js";
import { parameterizeUrl } from "./utils/string.js";
import { sortObject } from "./utils/sort-object.js";

const DEFAULT_INFO_TITLE = "HarToOpenApi";
const DEFAULT_INFO_DESCRIPTION = "OpenAPI spec generated from HAR data for {domain} on {generatedAt}";

const checkPathFromFilter = async (urlPath: string, harEntry: Entry, filter: HarToOpenAPIConfig["urlFilter"]) => {
  if (typeof filter === "string") {
    return urlPath.includes(filter);
  }
  if (filter instanceof RegExp) {
    // Global and sticky expressions otherwise resume at the previous match.
    filter.lastIndex = 0;
    return filter.test(urlPath);
  }
  if (typeof filter === "function") {
    return filter(urlPath, harEntry);
  }
};

const normalizeDomains = (domains: string[] | undefined) => {
  if (!domains?.length) {
    return undefined;
  }

  return Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)));
};

const shouldIncludeDomain = (domain: string | undefined, config: InternalConfig) => {
  if (config.includeDomains?.length) {
    if (!domain) {
      return false;
    }
    if (!config.includeDomains.includes(domain.toLowerCase())) {
      return false;
    }
  }

  if (domain && config.excludeDomains?.includes(domain.toLowerCase())) {
    return false;
  }

  return true;
};

const fillInfoTemplate = (template: string, values: Record<string, string>) => {
  return template.replace(/\{(domain|generatedAt)\}/g, (_, key: "domain" | "generatedAt") => values[key]);
};

const getResponseMimeType = (response: Response | undefined) => {
  if (!response) {
    return undefined;
  }

  const explicitMimeType = response.content?.mimeType?.trim();
  if (explicitMimeType) {
    return explicitMimeType.split(";")[0].trim().toLowerCase();
  }

  const headerMimeType = response.headers
    ?.find((header) => header.name.trim().toLowerCase() === "content-type")
    ?.value?.trim();
  return headerMimeType?.split(";")[0].trim().toLowerCase();
};

const mergePathParameters = (pathItem: PathItemObject, pathParams: ParameterObject[]) => {
  if (!pathParams.length) {
    return;
  }

  pathItem.parameters ??= [];
  for (const nextParam of pathParams) {
    const existingParam = pathItem.parameters.find(
      (param) => "$ref" in param === false && "in" in param && param.in === "path" && param.name === nextParam.name,
    );
    if (existingParam && !("$ref" in existingParam)) {
      const mergedSchema = mergeScalarSchemas(existingParam.schema as any, nextParam.schema as any);
      const nextDefault = nextParam.schema && !("$ref" in nextParam.schema) ? nextParam.schema.default : undefined;
      existingParam.schema = {
        ...mergedSchema,
        default: nextDefault,
      } as ParameterObject["schema"];
      existingParam.example = nextParam.example;
      continue;
    }

    pathItem.parameters.push(nextParam);
  }
};

const isOperationObject = (value: unknown): value is OperationObject => {
  return Boolean(value && typeof value === "object" && "responses" in (value as Record<string, unknown>));
};

const ensureUniqueOperationIds = (paths: PathsObject) => {
  const usedOperationIds = new Set<string>();

  for (const pathKey of Object.keys(paths).sort()) {
    const pathItem = paths[pathKey];
    if (!pathItem) {
      continue;
    }

    for (const method of Object.keys(pathItem).sort()) {
      const operation = pathItem[method as keyof PathItemObject];
      if (!isOperationObject(operation) || !operation.operationId) {
        continue;
      }

      const baseOperationId = operation.operationId;
      let operationId = baseOperationId;
      let suffix = 2;
      while (usedOperationIds.has(operationId)) {
        operationId = `${baseOperationId}_${suffix}`;
        suffix += 1;
      }

      operation.operationId = operationId;
      usedOperationIds.add(operationId);
    }
  }
};

const mergeRequestBodies = (
  current: OperationObject["requestBody"] | undefined,
  next: OperationObject["requestBody"] | undefined,
) => {
  if (!next) {
    return current;
  }

  if (!current || "$ref" in current || "$ref" in next) {
    return next;
  }

  return {
    ...current,
    ...next,
    content: {
      ...current.content,
      ...next.content,
    },
  };
};

const mergeResponseObjects = (current: ResponseObject | undefined, next: ResponseObject | undefined) => {
  if (!next) {
    return current;
  }

  if (!current || "$ref" in current) {
    return next;
  }

  return {
    ...current,
    ...next,
    headers: {
      ...current.headers,
      ...next.headers,
    },
    content: {
      ...current.content,
      ...next.content,
    },
  };
};

const getConfig = (config?: HarToOpenAPIConfig): InternalConfig => {
  validateConfig(config);
  const internalConfig = cloneDeep(config || {}) as InternalConfig;
  // set up some defaults
  internalConfig.openapiVersion ??= "3.0.0";
  internalConfig.filterStandardHeaders ??= true;
  internalConfig.relaxedContentTypeJsonParse ??= true;
  internalConfig.guessAuthenticationHeaders ??= true;
  internalConfig.inferParameterTypes ??= true;
  // default false
  internalConfig.forceAllRequestsInSameSpec ??= false;
  internalConfig.dropPathsWithoutSuccessfulResponse ??= false;
  internalConfig.attemptToParameterizeUrl ??= false;
  internalConfig.minLengthForNumericPath ??= 3;
  internalConfig.relaxedMethods ??= false;
  internalConfig.logErrors ??= false;
  internalConfig.includeDomains = normalizeDomains(internalConfig.includeDomains);
  internalConfig.excludeDomains = normalizeDomains(internalConfig.excludeDomains);

  if (internalConfig.guessAuthenticationHeaders) {
    internalConfig.securityHeaders ??= [];
    internalConfig.securityHeaders.push(...DEFAULT_AUTH_HEADERS);
  }
  if (internalConfig.securityHeaders) {
    internalConfig.securityHeaders = Array.from(new Set(internalConfig.securityHeaders.map((l) => l.toLowerCase())));
  }

  return Object.freeze(internalConfig);
};

type CapturedResponse = Response & { source?: CaptureSource };
interface CapturedEntry {
  entry: Entry;
  parsedUrl: URL;
  domain: string;
  source: CaptureSource;
}

const validNameValues = (value: unknown, optionalValue = false): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        (typeof item.value === "string" || (optionalValue && item.value === undefined)),
    ));

const validEntryData = (entry: Entry): boolean => {
  const request = entry.request;
  const response = entry.response;
  const postData = request.postData;
  const content = response?.content;
  return (
    validNameValues(request.headers) &&
    validNameValues(request.queryString) &&
    validNameValues(request.cookies) &&
    validNameValues(response?.headers) &&
    validNameValues(response?.cookies) &&
    (postData === undefined ||
      (postData !== null &&
        typeof postData === "object" &&
        !Array.isArray(postData) &&
        validNameValues(postData.params, true) &&
        (postData.text === undefined || typeof postData.text === "string") &&
        (postData.mimeType === undefined || typeof postData.mimeType === "string"))) &&
    (content === undefined ||
      (content !== null &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        (content.text === undefined || typeof content.text === "string") &&
        (content.mimeType === undefined || typeof content.mimeType === "string")))
  );
};

/** Merge observations from one or more captures and retain a report even when output is empty. */
const generateSpecsWithReport = async <T extends Har>(
  har: T | readonly T[],
  config?: HarToOpenAPIConfig,
): Promise<{ specs: HarToOpenAPISpec[]; report: ConversionReport }> => {
  const inputs: readonly T[] = Array.isArray(har) ? har : [har as T];
  const report: ConversionReport = {
    inputCount: inputs.length,
    totalEntries: 0,
    processedEntries: 0,
    filteredEntries: 0,
    failedEntries: 0,
    operations: 0,
    specs: 0,
    diagnostics: [],
  };
  const diagnose = (diagnostic: ConversionDiagnostic) => {
    report.diagnostics.push(diagnostic);
  };
  const finishReport = () => {
    for (const diagnostic of report.diagnostics) {
      if (typeof config?.onDiagnostic === "function") {
        config.onDiagnostic(diagnostic);
      }
      if (config?.logErrors && diagnostic.level !== "info") {
        console.error(`[${diagnostic.code}] ${diagnostic.message}`);
      }
    }
    if (typeof config?.onReport === "function") {
      config.onReport(report);
    }
  };
  let internalConfig: InternalConfig;
  let pathReplacements: Array<readonly [RegExp, string]> | undefined;
  try {
    validateConfig(config);
    internalConfig = getConfig({ ...config, onDiagnostic: diagnose });
    pathReplacements = internalConfig.pathReplace
      ? Object.entries(internalConfig.pathReplace).map(
          ([pattern, replacement]) => [new RegExp(pattern, "g"), replacement] as const,
        )
      : undefined;
  } catch (error) {
    diagnose({
      level: "error",
      code: "invalid-config",
      message: error instanceof Error ? error.message : "Invalid configuration.",
    });
    finishReport();
    throw new ConversionError(report);
  }
  const {
    ignoreBodiesForStatusCodes,
    mimeTypes,
    securityHeaders,
    forceAllRequestsInSameSpec,
    urlFilter,
    relaxedMethods,
    attemptToParameterizeUrl,
    minLengthForNumericPath,
    dropPathsWithoutSuccessfulResponse,
    infoDescription,
    infoTitle,
    infoVersion,
    inferParameterTypes,
    openapiVersion,
  } = internalConfig;

  const entries: CapturedEntry[] = [];
  inputs.forEach((input, inputIndex) => {
    if (!input || !Array.isArray(input.log?.entries)) {
      diagnose({
        level: "error",
        code: "invalid-har",
        message: `Input ${inputIndex} must contain a log.entries array.`,
      });
      return;
    }
    report.totalEntries += input.log.entries.length;
    input.log.entries.forEach((original, entryIndex) => {
      const source: CaptureSource = {
        inputIndex,
        entryIndex,
        ...(config?.sourceNames?.[inputIndex] ? { sourceName: config.sourceNames[inputIndex] } : {}),
      };
      if (
        !original?.request ||
        typeof original.request.url !== "string" ||
        typeof original.request.method !== "string" ||
        !original.request.method.trim()
      ) {
        report.failedEntries++;
        diagnose({
          level: "error",
          code: "invalid-entry",
          message: "Entry is missing a request URL or method.",
          source,
        });
        return;
      }
      if (!validEntryData(original)) {
        report.failedEntries++;
        diagnose({
          level: "error",
          code: "invalid-entry",
          message: "Entry contains malformed headers, parameters, cookies, or body data.",
          source,
        });
        return;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(original.request.url);
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("Unsupported protocol");
        }
      } catch {
        report.failedEntries++;
        diagnose({
          level: "error",
          code: "invalid-url",
          message: "Request URL must be an absolute HTTP or HTTPS URL.",
          source,
        });
        return;
      }
      const domain = parsedUrl.hostname;
      if (!shouldIncludeDomain(domain, internalConfig)) {
        report.filteredEntries++;
        diagnose({ level: "info", code: "domain-filtered", message: "Entry excluded by domain filters.", source });
        return;
      }
      // Inference and user callbacks may inspect/mutate entries; never mutate the supplied captures.
      const entry = cloneDeep(original);
      entries.push({ entry, parsedUrl, domain, source });
    });
  });

  const groups = groupBy(entries, (item) => (forceAllRequestsInSameSpec ? "specs" : item.domain));
  const specs: HarToOpenAPISpec[] = [];
  let transformationFailed = false;
  for (const harEntriesForDomain of Object.values(groups)) {
    const spec = createApiSpec(openapiVersion);
    const requestBodySamples = new WeakMap<
      OperationObject,
      Array<{
        postData: NonNullable<Entry["request"]["postData"]>;
        headers?: Entry["request"]["headers"];
        source: CaptureSource;
      }>
    >();
    const responseBodySamples = new WeakMap<OperationObject, Map<number, CapturedResponse[]>>();
    const observations = new WeakMap<
      OperationObject,
      {
        sampleCount: number;
        requestBodyCount: number;
        parameterSamples: Array<{ query: Set<string>; header: Set<string> }>;
      }
    >();
    const securitySchemes: NonNullable<OpenApiSpec["components"]>["securitySchemes"] = {};
    const origins = new Set<string>();
    const labeledDomain = harEntriesForDomain[0].domain;
    const infoValues = { domain: labeledDomain, generatedAt: new Date().toISOString() };
    spec.info.title = fillInfoTemplate(infoTitle ?? DEFAULT_INFO_TITLE, infoValues);
    spec.info.version = fillInfoTemplate(infoVersion ?? spec.info.version, infoValues);
    spec.info.description = fillInfoTemplate(infoDescription ?? DEFAULT_INFO_DESCRIPTION, infoValues);

    for (const { entry: item, parsedUrl: sourceUrl, source } of harEntriesForDomain) {
      try {
        const urlObj = pathReplacements?.length ? new URL(sourceUrl.href) : sourceUrl;
        for (const [matcher, replacement] of pathReplacements ?? []) {
          urlObj.pathname = urlObj.pathname.replace(matcher, replacement);
        }
        let urlPath = urlObj.pathname;
        let pathParams: ParameterObject[] = [];
        if (attemptToParameterizeUrl) {
          const parameterized = parameterizeUrl(urlPath, minLengthForNumericPath, inferParameterTypes);
          urlPath = parameterized.path;
          pathParams = parameterized.parameters;
        }
        const skip = (code: string, message: string) => {
          report.filteredEntries++;
          diagnose({ level: "info", code, message, source });
        };
        if (urlFilter && !(await checkPathFromFilter(urlObj.href, item, urlFilter))) {
          skip("url-filtered", "Entry excluded by URL filter.");
          continue;
        }
        const mimeType = getResponseMimeType(item.response);
        if (mimeTypes && (!mimeType || !mimeTypes.includes(mimeType))) {
          skip("mime-filtered", "Entry excluded by response media type filter.");
          continue;
        }
        const method = item.request.method.toLowerCase();
        if (
          (!relaxedMethods && !isStandardMethod(method)) ||
          ["__proto__", "prototype", "constructor", "parameters", "servers", "$ref", "summary", "description"].includes(
            method,
          )
        ) {
          skip("method-filtered", "Entry excluded because its HTTP method is unsupported.");
          continue;
        }
        const queryStrings: QueryString[] = urlObj.search
          ? Array.from(urlObj.searchParams, ([name, value]) => ({ name, value }))
          : (item.request.queryString ?? []);
        const requestHeaders = item.request.headers;
        // Invalid producer data should fail this entry before creating an operation.
        if (!Array.isArray(queryStrings) || (requestHeaders !== undefined && !Array.isArray(requestHeaders))) {
          throw new Error("Invalid parameters");
        }
        spec.paths[urlPath] ??= {} as PathItemObject;
        const path = spec.paths[urlPath] as PathItemObject;
        mergePathParameters(path, pathParams);
        path[method] ??= addMethod(method, urlObj, internalConfig);
        const operation = path[method] as OperationObject;
        if (internalConfig.addServersToPaths) {
          operation.servers ??= [];
          if (!operation.servers.some((server) => server.url === sourceUrl.origin)) {
            operation.servers.push({ url: sourceUrl.origin });
          }
        }
        const status = item.response?.status;
        const hasValidResponse = Number.isInteger(status) && status >= 100 && status <= 599;
        if (hasValidResponse) {
          operation.responses[status] ??= addResponse(status, method);
        } else {
          diagnose({
            level: "warning",
            code: "response-missing",
            message: "No completed HTTP response was captured.",
            source,
            path: urlPath,
            method,
          });
        }
        if (securityHeaders?.length && requestHeaders?.length) {
          const security = getSecurity(requestHeaders, securityHeaders, item.request.cookies);
          if (security) {
            Object.assign(securitySchemes, security.schemes);
            operation.security = [security.requirement];
          }
        }
        if (queryStrings.length) {
          addQueryStringParams(operation, queryStrings, internalConfig);
        }
        if (requestHeaders?.length) {
          addRequestHeaders(operation, requestHeaders, internalConfig);
        }
        const observation = observations.get(operation) ?? {
          sampleCount: 0,
          requestBodyCount: 0,
          parameterSamples: [],
        };
        observation.sampleCount++;
        if (item.request.postData) {
          observation.requestBodyCount++;
        }
        observation.parameterSamples.push({
          query: new Set(queryStrings.map((parameter) => parameter.name)),
          header: new Set(requestHeaders?.map((header) => header.name.toLowerCase())),
        });
        observations.set(operation, observation);

        const useBodies = !ignoreBodiesForStatusCodes?.includes(status);
        if (!useBodies) {
          diagnose({
            level: "info",
            code: "bodies-filtered",
            message: "Bodies excluded by status code filter.",
            source,
            path: urlPath,
            method,
            status,
          });
        }
        if (useBodies && item.request.postData) {
          const samples = requestBodySamples.get(operation) ?? [];
          samples.push({ postData: item.request.postData, headers: requestHeaders, source });
          requestBodySamples.set(operation, samples);
        }
        if (hasValidResponse && useBodies && item.response) {
          const samplesByStatus = responseBodySamples.get(operation) ?? new Map<number, CapturedResponse[]>();
          const samples = samplesByStatus.get(status) ?? [];
          // Response content is optional in real-world partial HAR exports.
          if (item.response.content) {
            samples.push({ ...item.response, source });
          } else if (method !== "head" && status !== 204 && status !== 304) {
            diagnose({
              level: "warning",
              code: "body-missing",
              message: "Response content was not captured.",
              source,
              path: urlPath,
              method,
              status,
            });
          }
          samplesByStatus.set(status, samples);
          responseBodySamples.set(operation, samplesByStatus);
        }
        origins.add(sourceUrl.origin);
        report.processedEntries++;
      } catch {
        report.failedEntries++;
        diagnose({
          level: "error",
          code: "entry-failed",
          message: "Entry could not be converted because its request or response data is invalid.",
          source,
        });
      }
    }

    if (dropPathsWithoutSuccessfulResponse) {
      for (const [path, pathItem] of Object.entries(spec.paths)) {
        const success = Object.values(pathItem).some(
          (value) => isOperationObject(value) && Object.keys(value.responses).some((status) => status.startsWith("2")),
        );
        if (!success) {
          delete spec.paths[path];
          diagnose({
            level: "info",
            code: "path-filtered",
            message: "Path excluded because no successful response was captured.",
            path,
          });
        }
      }
    }
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!isOperationObject(operation)) {
          continue;
        }
        const observation = observations.get(operation);
        if (observation) {
          if (internalConfig.includeInferenceEvidence) {
            operation["x-har-observations"] = {
              sampleCount: observation.sampleCount,
              requestBodyCount: observation.requestBodyCount,
            };
          }
          for (const parameter of operation.parameters ?? []) {
            if ("$ref" in parameter || parameter.in === "path") {
              continue;
            }
            const literalArrayNameExists = operation.parameters?.some(
              (p) => !("$ref" in p) && p.in === "query" && p.name === `${parameter.name}[]`,
            );
            const present = observation.parameterSamples.filter((sample) => {
              if (parameter.in === "header") {
                return sample.header.has(parameter.name.toLowerCase());
              }
              if (parameter.in !== "query") {
                return false;
              }
              if (sample.query.has(parameter.name)) {
                return true;
              }
              if (!internalConfig.parseBracketParameters) {
                return false;
              }
              if (parameter.style === "deepObject") {
                return Array.from(sample.query).some((name) => name.startsWith(`${parameter.name}[`));
              }
              return !literalArrayNameExists && sample.query.has(`${parameter.name}[]`);
            }).length;
            if (internalConfig.requiredness === "observed") {
              parameter.required = present === observation.sampleCount;
            }
            if (internalConfig.requiredness === "optional") {
              parameter.required = false;
            }
            if (internalConfig.includeInferenceEvidence) {
              (parameter as ParameterObject & Record<string, unknown>)["x-har-observations"] = {
                sampleCount: observation.sampleCount,
                present,
                ratio: present / observation.sampleCount,
              };
            }
          }
        }
        const requestSamples = requestBodySamples.get(operation);
        if (requestSamples?.length) {
          try {
            operation.requestBody = mergeRequestBodies(
              operation.requestBody,
              await buildRequestBodyFromSamples(requestSamples, { urlPath: pathKey, method }, internalConfig),
            );
            if (operation.requestBody && !("$ref" in operation.requestBody)) {
              if (internalConfig.requiredness === "optional") {
                operation.requestBody.required = false;
              }
              if (internalConfig.requiredness === "observed" && observation) {
                operation.requestBody.required = observation.requestBodyCount === observation.sampleCount;
              }
            }
          } catch {
            diagnose({
              level: "error",
              code: "schema-failed",
              message: "Request schema inference failed.",
              source: requestSamples[0].source,
              path: pathKey,
              method,
            });
          }
        }
        for (const [status, samples] of responseBodySamples.get(operation) ?? []) {
          if (!samples.length) {
            continue;
          }
          try {
            const body = await buildResponseBodyFromSamples(samples, { urlPath: pathKey, method }, internalConfig);
            if (body) {
              operation.responses[status] = mergeResponseObjects(operation.responses[status], body) as ResponseObject;
            }
          } catch {
            diagnose({
              level: "error",
              code: "schema-failed",
              message: "Response schema inference failed.",
              source: samples[0].source,
              path: pathKey,
              method,
              status,
            });
          }
        }
      }
    }
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!Object.values(item).some(isOperationObject)) {
        delete spec.paths[path];
      }
    }
    if (!Object.keys(spec.paths).length) {
      continue;
    }
    if (Object.keys(securitySchemes).length) {
      spec.components = { ...spec.components, securitySchemes };
    }
    spec.paths = sortObject(spec.paths);
    ensureUniqueOperationIds(spec.paths);
    spec.servers = Array.from(origins, (url): ServerObject => ({ url }));
    try {
      postprocessSpec(spec, internalConfig);
    } catch (error) {
      transformationFailed = true;
      diagnose({
        level: "error",
        code: "transformation-failed",
        message: error instanceof Error ? error.message : "Spec customization failed.",
      });
      continue;
    }
    if (internalConfig.validate || internalConfig.strict) {
      const validationDiagnostics = await validateSpec(spec);
      for (const diagnostic of validationDiagnostics) {
        diagnose(diagnostic);
      }
      if (validationDiagnostics.some((diagnostic) => diagnostic.level === "error")) {
        continue;
      }
    }
    specs.push({ spec, yamlSpec: YAML.dump(spec), domain: labeledDomain });
  }
  report.specs = specs.length;
  report.operations = specs.reduce(
    (count, { spec }) =>
      count +
      Object.values(spec.paths ?? {}).reduce(
        (n, path) => n + Object.values(path ?? {}).filter(isOperationObject).length,
        0,
      ),
    0,
  );
  if (!specs.length) {
    diagnose({
      level: "warning",
      code: "no-specs",
      message: "No OpenAPI operations were generated from the supplied captures.",
    });
  }
  if (config?.includeReport) {
    for (const spec of specs) {
      spec.report = report;
    }
  }
  finishReport();
  if (
    transformationFailed ||
    (internalConfig.strict && report.diagnostics.some((d) => d.level !== "info")) ||
    (internalConfig.validate && report.diagnostics.some((d) => d.level === "error"))
  ) {
    throw new ConversionError(report);
  }
  return { specs, report };
};

const generateSpecs = async <T extends Har>(
  har: T | readonly T[],
  config?: HarToOpenAPIConfig,
): Promise<HarToOpenAPISpec[]> => {
  return (await generateSpecsWithReport(har, config)).specs;
};

const generateSpec = async <T extends Har>(
  har: T | readonly T[],
  config?: HarToOpenAPIConfig,
): Promise<HarToOpenAPISpec> => {
  const { specs, report } = await generateSpecsWithReport(har, config);
  if (specs.length) {
    return specs[0];
  }
  const spec = createApiSpec(getConfig(config).openapiVersion);
  spec.info.title = "HarToOpenApi - no valid specs found";
  return { spec, yamlSpec: YAML.dump(spec), domain: undefined, ...(config?.includeReport ? { report } : {}) };
};

export { generateSpec, generateSpecs, generateSpecsWithReport, ConversionError };
export type {
  CaptureSource,
  ConversionDiagnostic,
  ConversionReport,
  HarToOpenAPIConfig,
  HarToOpenAPISpec,
  OpenApiOverlay,
  RedactionConfig,
} from "./types.js";
