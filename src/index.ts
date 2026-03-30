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
import YAML from "js-yaml";
import { cloneDeep, groupBy } from "lodash-es";
import {
  addMethod,
  addQueryStringParams,
  addRequestHeaders,
  getBody,
  getResponseBody,
  getSecurity,
} from "./helpers.js";
import type { HarToOpenAPIConfig, HarToOpenAPISpec, InternalConfig } from "./types.js";
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
      ...(current.content ?? {}),
      ...(next.content ?? {}),
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
      ...(current.headers ?? {}),
      ...(next.headers ?? {}),
    },
    content: {
      ...(current.content ?? {}),
      ...(next.content ?? {}),
    },
  };
};

const getConfig = (config?: HarToOpenAPIConfig): InternalConfig => {
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

function tryGetHostname(url: string, logErrors: boolean | undefined, fallback: string): string;
function tryGetHostname(url: string, logErrors: boolean | undefined): string | undefined;
function tryGetHostname(url: string, logErrors?: boolean, fallback?: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    if (logErrors) {
      console.error(`Error parsing url ${url}`);
    }
  }
  return fallback;
}

const tryParseUrl = (url: string, logErrors: boolean | undefined) => {
  try {
    return new URL(url);
  } catch {
    if (logErrors) {
      console.error(`Error parsing url ${url}`);
    }
  }
  return undefined;
};

const generateSpecs = async <T extends Har>(har: T, config?: HarToOpenAPIConfig): Promise<HarToOpenAPISpec[]> => {
  if (!har?.log?.entries?.length) {
    return [];
  }

  // decode base64 now
  har.log.entries.forEach((item) => {
    const response = item.response;
    if (response && response.content?.encoding === "base64") {
      response.content.text = Buffer.from(response.content.text || "", "base64").toString();
      delete response.content.encoding;
    }
  });

  const internalConfig = getConfig(config);
  const {
    ignoreBodiesForStatusCodes,
    mimeTypes,
    securityHeaders,
    forceAllRequestsInSameSpec,
    urlFilter,
    relaxedMethods,
    logErrors,
    attemptToParameterizeUrl,
    minLengthForNumericPath,
    dropPathsWithoutSuccessfulResponse,
    pathReplace,
    infoDescription,
    infoTitle,
    infoVersion,
    inferParameterTypes,
    openapiVersion,
  } = internalConfig;

  const filteredEntries = har.log.entries
    .map((entry) => {
      const parsedUrl = tryParseUrl(entry.request.url, logErrors);
      if (!parsedUrl) {
        return undefined;
      }

      const domain = parsedUrl.hostname;
      if (!shouldIncludeDomain(domain, internalConfig)) {
        return undefined;
      }

      return {
        entry,
        parsedUrl,
        domain,
      };
    })
    .filter(
      (
        item,
      ): item is {
        entry: Entry;
        parsedUrl: URL;
        domain: string;
      } => Boolean(item),
    );

  const groupedByHostname = groupBy(filteredEntries, (entry) => {
    if (forceAllRequestsInSameSpec) {
      return "specs";
    }
    return entry.domain;
  });
  const specs: HarToOpenAPISpec[] = [];

  for (const domain in groupedByHostname) {
    try {
      const spec = createApiSpec(openapiVersion);

      const harEntriesForDomain = groupedByHostname[domain];

      const securitySchemes: NonNullable<OpenApiSpec["components"]>["securitySchemes"] = {};
      const firstUrl = harEntriesForDomain[0]?.parsedUrl;
      const labeledDomain = firstUrl?.hostname ?? domain;
      const generatedAt = new Date().toISOString();
      const infoTemplateValues = {
        domain: labeledDomain ?? domain ?? "unknown-domain",
        generatedAt,
      };

      spec.info.title = fillInfoTemplate(infoTitle ?? DEFAULT_INFO_TITLE, infoTemplateValues);
      spec.info.version = fillInfoTemplate(infoVersion ?? spec.info.version, infoTemplateValues);
      spec.info.description = fillInfoTemplate(infoDescription ?? DEFAULT_INFO_DESCRIPTION, infoTemplateValues);

      for (const { entry: item, parsedUrl: sourceUrl } of harEntriesForDomain) {
        try {
          const urlObj = new URL(sourceUrl.href);

          if (pathReplace) {
            for (const key in pathReplace) {
              urlObj.pathname = urlObj.pathname.replace(new RegExp(key, "g"), pathReplace[key]);
            }
          }

          let urlPath = urlObj.pathname;
          let pathParams: ParameterObject[] = [];
          if (attemptToParameterizeUrl) {
            const { path, parameters } = parameterizeUrl(urlPath, minLengthForNumericPath, inferParameterTypes);
            urlPath = path;
            pathParams = parameters;
          }

          const queryParams = urlObj.search;

          if (urlFilter) {
            const isValid = await checkPathFromFilter(urlObj.href, item, urlFilter);
            if (!isValid) {
              continue;
            }
          }
          const mimeType = getResponseMimeType(item.response);
          const isValidMimetype = !mimeTypes || (mimeType && mimeTypes.includes(mimeType));
          if (!isValidMimetype) {
            continue;
          }

          // create method
          const method = item.request.method.toLowerCase();
          // if its not standard and we're not in relaxed mode, skip it
          if (!relaxedMethods && !isStandardMethod(method)) {
            continue;
          }
          // create path if it doesn't exist
          spec.paths[urlPath] ??= {} as PathItemObject;
          const path = spec.paths[urlPath] as PathItemObject;
          mergePathParameters(path, pathParams);

          path[method] ??= addMethod(method, urlObj, internalConfig);
          const specMethod = path[method] as OperationObject;
          // generate response
          const status = item.response?.status;
          if (status) {
            specMethod.responses[status] ??= addResponse(status, method);
          }

          const requestHeaders = item.request.headers;
          if (securityHeaders?.length && requestHeaders?.length) {
            const security = getSecurity(requestHeaders, securityHeaders, item.request.cookies);
            if (security) {
              Object.assign(securitySchemes, security.schemes);
              specMethod.security = [security.requirement];
            }
          }

          // add query string parameters
          if (item.request.queryString?.length) {
            addQueryStringParams(specMethod, item.request.queryString, internalConfig);
          }
          if (queryParams) {
            // try and parse from the url if the har is malformed
            const queryStrings: QueryString[] = [];
            for (const entry of urlObj.searchParams.entries()) {
              queryStrings.push({ name: entry[0], value: entry[1] });
            }
            addQueryStringParams(specMethod, queryStrings, internalConfig);
          }
          if (requestHeaders?.length) {
            addRequestHeaders(specMethod, requestHeaders, internalConfig);
          }

          const shouldUseRequestAndResponse =
            !ignoreBodiesForStatusCodes || !ignoreBodiesForStatusCodes.includes(status);
          if (shouldUseRequestAndResponse && item.request.postData) {
            specMethod.examples ??= [];
            const requestBody = await getBody(
              item.request.postData,
              {
                urlPath,
                method,
                examples: specMethod.examples,
                headers: item.request.headers,
                suffix: "request",
              },
              internalConfig,
            );
            specMethod.requestBody = mergeRequestBodies(specMethod.requestBody, requestBody);
          }

          if (status && isValidMimetype && shouldUseRequestAndResponse && item.response) {
            specMethod.responseExamples ??= {};
            specMethod.responseExamples[status] ??= [];
            const body = await getResponseBody(
              item.response,
              { urlPath, method, examples: specMethod.responseExamples[status] },
              internalConfig,
            );
            if (body) {
              specMethod.responses[status] = mergeResponseObjects(specMethod.responses[status], body) as any;
            }
          }
        } catch (e) {
          if (logErrors) {
            console.error(`Error parsing ${item.request}`);
            console.error(e);
          }
          // error parsing one entry, move on
        }
      }

      if (dropPathsWithoutSuccessfulResponse) {
        for (const [path, entry] of Object.entries<PathsObject>(spec.paths)) {
          const pathKeys = Object.keys(entry);
          let hadSuccessfulResponse = false;
          for (const maybeMethod of pathKeys) {
            if (isStandardMethod(maybeMethod)) {
              const responses = Object.keys(entry[maybeMethod].responses);
              for (const maybeStatus of responses) {
                // check if any of the responses had a valid status (2xx)
                hadSuccessfulResponse ||= String(maybeStatus).startsWith("2");
              }
            }
          }
          if (!hadSuccessfulResponse) {
            delete spec.paths[path];
          }
        }
      }
      // If there were no valid paths, bail
      if (!Object.keys(spec.paths).length) {
        continue;
      }

      if (Object.keys(securitySchemes).length) {
        spec.components ||= {};
        spec.components.securitySchemes ??= {};
        Object.assign(spec.components.securitySchemes, securitySchemes);
      }

      // remove the examples that we used to build the superset schemas
      for (const path of Object.values(spec.paths)) {
        for (const maybeOperation of Object.values(path)) {
          if (!isOperationObject(maybeOperation)) {
            continue;
          }
          delete maybeOperation.responseExamples;
          delete maybeOperation.examples;
        }
      }
      // sort paths
      spec.paths = sortObject(spec.paths);
      const prefix = firstUrl?.protocol ?? "http:";
      const server: ServerObject = {
        url: `${prefix}//${labeledDomain}`,
      };
      spec.servers = [server];
      const yamlSpec = YAML.dump(spec);
      specs.push({ spec, yamlSpec, domain: labeledDomain });
    } catch (err) {
      if (logErrors) {
        console.error(`Error creating spec for ${domain} - ${err}`);
      }
    }
  }

  return specs;
};
const generateSpec = async <T extends Har>(har: T, config?: HarToOpenAPIConfig): Promise<HarToOpenAPISpec> => {
  const specs = await generateSpecs(har, config);
  if (specs.length) {
    return specs[0];
  }
  const spec = createApiSpec(getConfig(config).openapiVersion);
  spec.info.title = "HarToOpenApi - no valid specs found";
  return { spec, yamlSpec: YAML.dump(spec), domain: undefined };
};

export { generateSpec, generateSpecs };
export type { HarToOpenAPIConfig, HarToOpenAPISpec } from "./types.js";
