import type { OperationObject } from "@loopback/openapi-v3-types";
import { createEmptyApiSpec } from "@loopback/openapi-v3-types";
import type { Entry, Har, QueryString } from "har-format";
import YAML from "js-yaml";
import sortJson from "sort-json";
import { addMethod, addQueryStringParams, addRequestHeaders, getBody, getResponseBody, getSecurity } from "./helpers";
import type { Config, IGenerateSpecResponse, InternalConfig } from "./types";
import type {
  PathItemObject,
  PathsObject,
  SecurityRequirementObject,
  ServerObject,
} from "openapi3-ts/src/model/OpenApi";
import { cloneDeep, groupBy } from "lodash-es";
import { addResponse } from "./utils/baseResponse";
import { isStandardMethod } from "./utils/methods";

const checkPathFromFilter = async (urlPath: string, filter: Config["urlFilter"]) => {
  if (typeof filter === "string") {
    return urlPath.includes(filter);
  }
  if (filter instanceof RegExp) {
    return filter.test(urlPath);
  }
  if (typeof filter === "function") {
    return filter(urlPath);
  }
};

const getConfig = (config?: Config): InternalConfig => {
  const internalConfig = cloneDeep(config || {}) as InternalConfig;
  // set up some defaults
  internalConfig.filterStandardHeaders ??= true;
  internalConfig.relaxedContentTypeJsonParse ??= true;
  internalConfig.forceAllRequestsInSameSpec ??= false;
  internalConfig.relaxedMethods ??= false;
  internalConfig.logErrors ??= false;
  if (internalConfig.securityHeaders) {
    internalConfig.securityHeaders = internalConfig.securityHeaders.map((l) => l.toLowerCase());
  }
  return internalConfig;
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

const generateSpecs = async <T extends Har>(har: T, config?: Config): Promise<IGenerateSpecResponse[]> => {
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
    filterStandardHeaders,
    forceAllRequestsInSameSpec,
    urlFilter,
    relaxedMethods,
    logErrors,
  } = internalConfig;

  const groupedByHostname = groupBy(har.log.entries, (entry: Entry) => {
    if (forceAllRequestsInSameSpec) {
      return "specs";
    }
    return tryGetHostname(entry.request.url, logErrors);
  });
  const specs: IGenerateSpecResponse[] = [];

  for (const domain in groupedByHostname) {
    try {
      // loop through har entries
      const spec = createEmptyApiSpec();
      spec.info.title = "HarToOpenApi";

      const harEntriesForDomain = groupedByHostname[domain];

      const securitySchemas: SecurityRequirementObject[] = [];
      const firstUrl = harEntriesForDomain[0].request.url;

      for (const item of harEntriesForDomain) {
        try {
          const url = item.request.url;

          if (!url) {
            continue;
          }

          // filter and collapse path urls
          const urlObj = new URL(url);
          const urlPath = urlObj.pathname;

          const queryParams = urlObj.search;

          if (urlFilter) {
            const isValid = await checkPathFromFilter(urlObj.href, urlFilter);
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
          spec.paths[urlPath] ??= { parameters: [] } as PathsObject;
          const path = spec.paths[urlPath] as PathItemObject;

          path[method] ??= addMethod(method, urlObj, config);
          const specMethod = path[method] as OperationObject;
          // generate response
          const status = item.response?.status;
          if (status) {
            specMethod.responses[status] ??= addResponse(status, method);
          }

          const requestHeaders = item.request.headers;
          if (securityHeaders?.length && requestHeaders?.length) {
            const security = getSecurity(requestHeaders, securityHeaders);
            if (security) {
              securitySchemas.push(security);
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
            addRequestHeaders(specMethod, requestHeaders, filterStandardHeaders);
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
      // If there were no valid paths, bail
      if (!Object.keys(spec.paths).length) {
        continue;
      }

      if (securitySchemas.length) {
        spec.components ||= {};
        spec.components.securitySchemes = {};
        securitySchemas.forEach((schema) => {
          const schemaName = Object.keys(schema)[0];
          spec.components!.securitySchemes![schemaName] = {
            type: "http",
            name: schemaName,
            in: "header",
          };
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
      spec.paths = sortJson(spec.paths, { depth: 200 });
      const yamlSpec = YAML.dump(spec);
      const labeledDomain = tryGetHostname(firstUrl, logErrors, domain);
      const prefix = firstUrl?.startsWith("https://") ? "https://" : "http://";
      const server: ServerObject = {
        url: `${prefix}${labeledDomain}`,
      };
      spec.servers = [server];
      specs.push({ spec, yamlSpec, domain: labeledDomain });
    } catch (err) {
      if (logErrors) {
        console.error(`Error creating spec for ${domain}`);
      }
    }
  }

  return specs;
};
const generateSpec = async <T extends Har>(har: T, config?: Config): Promise<IGenerateSpecResponse> => {
  const specs = await generateSpecs(har, config);
  if (specs.length) {
    return specs[0];
  }
  const spec = createEmptyApiSpec();
  spec.info.title = "HarToOpenApi - no valid specs found";
  return { spec, yamlSpec: YAML.dump(spec), domain: undefined };
};

export { generateSpec, generateSpecs };
