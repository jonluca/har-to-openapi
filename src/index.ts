import type {
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
} from "@loopback/openapi-v3-types";
import { createEmptyApiSpec } from "@loopback/openapi-v3-types";
import type { Cookie, Entry, Har, QueryString } from "har-format";
import YAML from "js-yaml";
import { addMethod, addQueryStringParams, addRequestHeaders, getBody, getResponseBody, getSecurity } from "./helpers";
import type { HarToOpenAPIConfig, HarToOpenAPISpec, InternalConfig } from "./types";
import { cloneDeep, groupBy } from "lodash";
import { addResponse } from "./utils/baseResponse";
import { isStandardMethod } from "./utils/methods";
import { DEFAULT_AUTH_HEADERS } from "./utils/headers";
import { getCookieSecurityName, parameterizeUrl } from "./utils/string";
import { sortObject } from "./utils/sortObject";

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

const getConfig = (config?: HarToOpenAPIConfig): InternalConfig => {
  const internalConfig = cloneDeep(config || {}) as InternalConfig;
  // set up some defaults
  internalConfig.filterStandardHeaders ??= true;
  internalConfig.relaxedContentTypeJsonParse ??= true;
  internalConfig.guessAuthenticationHeaders ??= true;
  // default false
  internalConfig.forceAllRequestsInSameSpec ??= false;
  internalConfig.dropPathsWithoutSuccessfulResponse ??= false;
  internalConfig.attemptToParameterizeUrl ??= false;
  internalConfig.minLengthForNumericPath ??= 3;
  internalConfig.relaxedMethods ??= false;
  internalConfig.logErrors ??= false;

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
  } = internalConfig;

  const groupedByHostname = groupBy(har.log.entries, (entry: Entry) => {
    if (forceAllRequestsInSameSpec) {
      return "specs";
    }
    return tryGetHostname(entry.request.url, logErrors);
  });
  const specs: HarToOpenAPISpec[] = [];

  for (const domain in groupedByHostname) {
    try {
      // loop through har entries
      const spec = createEmptyApiSpec();
      spec.info.title = "HarToOpenApi";
      spec.info.description = `OpenAPI spec generated from HAR data for ${domain} on ${new Date().toISOString()}`;

      const harEntriesForDomain = groupedByHostname[domain];

      const securitySchemas: SecurityRequirementObject[] = [];
      const cookies: Cookie[] = [];
      const firstUrl = harEntriesForDomain[0].request.url;

      for (const item of harEntriesForDomain) {
        try {
          const url = item.request.url;

          if (!url) {
            continue;
          }

          // filter and collapse path urls
          const urlObj = new URL(url);

          if (pathReplace) {
            for (const key in pathReplace) {
              urlObj.pathname = urlObj.pathname.replace(new RegExp(key, "g"), pathReplace[key]);
            }
          }

          let urlPath = urlObj.pathname;
          let pathParams: ParameterObject[] = [];
          if (attemptToParameterizeUrl) {
            const { path, parameters } = parameterizeUrl(urlPath, minLengthForNumericPath);
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
          const mimeType = item.response?.content?.mimeType;
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
          spec.paths[urlPath] ??= { parameters: pathParams } as PathsObject;
          const path = spec.paths[urlPath] as PathItemObject;

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
              securitySchemas.push(security);
              if (security.cookie && item.request.cookies?.length) {
                cookies.push(...item.request.cookies);
              }
              specMethod.security = [security];
            }
          }

          // add query string parameters
          if (item.request.queryString?.length) {
            addQueryStringParams(specMethod, item.request.queryString);
          }
          if (queryParams) {
            // try and parse from the url if the har is malformed
            const queryStrings: QueryString[] = [];
            for (const entry of urlObj.searchParams.entries()) {
              queryStrings.push({ name: entry[0], value: entry[1] });
            }
            addQueryStringParams(specMethod, queryStrings);
          }
          if (requestHeaders?.length) {
            addRequestHeaders(specMethod, requestHeaders, internalConfig);
          }

          const shouldUseRequestAndResponse =
            !ignoreBodiesForStatusCodes || !ignoreBodiesForStatusCodes.includes(status);
          if (shouldUseRequestAndResponse && item.request.postData) {
            specMethod.examples ??= [];
            specMethod.requestBody = await getBody(
              item.request.postData,
              { urlPath, method, examples: specMethod.examples },
              internalConfig,
            );
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
              specMethod.responses[status] = body;
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

      if (securitySchemas.length) {
        spec.components ||= {};
        spec.components.securitySchemes ??= {};
        if (cookies.length) {
          cookies.forEach((cookie) => {
            const schemaName = getCookieSecurityName(cookie);
            spec.components!.securitySchemes![schemaName] = {
              type: "apiKey",
              name: cookie.name,
              in: "cookie",
            } as SecuritySchemeObject;
          });
        }
        securitySchemas.forEach((schema) => {
          const schemaName = Object.keys(schema)[0];
          spec.components!.securitySchemes![schemaName] = {
            type: "apiKey",
            name: schemaName,
            in: "header",
          } as SecuritySchemeObject;
        });
      }

      // remove the examples that we used to build the superset schemas
      for (const path of Object.values(spec.paths)) {
        for (const method of Object.values<OperationObject>(path)) {
          delete method.responseExamples;
          delete method.examples;
        }
      }
      // sort paths
      spec.paths = sortObject(spec.paths);
      const labeledDomain = tryGetHostname(firstUrl, logErrors, domain);
      const prefix = firstUrl?.startsWith("https://") ? "https://" : "http://";
      const server: ServerObject = {
        url: `${prefix}${labeledDomain}`,
      };
      spec.servers = [server];
      const yamlSpec = YAML.dump(spec);
      specs.push({ spec, yamlSpec, domain: labeledDomain });
    } catch (err) {
      if (logErrors) {
        console.error(`Error creating spec for ${domain}`);
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
  const spec = createEmptyApiSpec();
  spec.info.title = "HarToOpenApi - no valid specs found";
  return { spec, yamlSpec: YAML.dump(spec), domain: undefined };
};

export { generateSpec, generateSpecs };
