import type { OperationObject } from "@loopback/openapi-v3-types";
import { createEmptyApiSpec } from "@loopback/openapi-v3-types";
import type { Entry, Har, QueryString } from "har-format";
import YAML from "js-yaml";
import sortJson from "sort-json";
import {
  addMethod,
  addQueryStringParams,
  addRequestHeaders,
  getBody,
  getPathAndParamsFromUrl,
  getResponseBody,
  getSecurity,
} from "./helpers";
import type { Config, IGenerateSpecResponse } from "./types";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";
import { groupBy } from "lodash-es";
import { addResponse } from "./utils/baseResponse";

const checkPathFromFilter = async (urlPath: string, filter: Config["urlFilter"]) => {
  if (!filter) {
    return true;
  }
  if (typeof filter === "string") {
    return urlPath.includes(filter);
  }
  if (filter instanceof RegExp) {
    return filter.test(urlPath);
  }
  return filter(urlPath);
};
const generateSpecs = async <T extends Har>(har: T, config?: Config): Promise<IGenerateSpecResponse[]> => {
  if (!har?.log?.entries?.length) {
    return [];
  }
  // decode base64 now before writing pretty har file
  har.log.entries.forEach((item, index) => {
    const response = item.response;
    if (response && response.content.encoding === "base64") {
      har.log.entries[index].response.content.text = Buffer.from(response.content.text || "", "base64").toString();
      delete har.log.entries[index].response.content.encoding;
    }
  });

  const groupedByHostname = groupBy(har.log.entries, (entry: Entry) => {
    try {
      const url = new URL(entry.request.url);
      return url.hostname;
    } catch (e) {
      console.error(`Error parsing url ${entry.request.url}`);
      return undefined;
    }
  });
  const specs: IGenerateSpecResponse[] = [];
  const {
    ignoreBodiesForStatusCodes,
    apiBasePath,
    mimeTypes,
    securityHeaders,
    filterStandardHeaders = true,
    urlFilter,
  } = config || {};
  for (const domain in groupedByHostname) {
    try {
      // loop through har entries
      const spec = createEmptyApiSpec();
      spec.info.title = "HarToOpenApi";

      for (const item of har.log.entries) {
        const url = item.request.url;
        // if the config specified a base path, we'll only generate specs for urls that include it
        if (apiBasePath && !url.includes(apiBasePath)) {
          continue;
        }
        const mimeType = item.response?.content?.mimeType;
        const isValidMimetype = !mimeTypes || (mimeType && mimeTypes.includes(mimeType));
        if (!isValidMimetype) {
          continue;
        }

        // filter and collapse path urls
        const urlObj = new URL(url);
        const urlPath = urlObj.pathname;

        const queryParams = urlObj.search;
        // continue if url is blank
        if (!urlPath) {
          continue;
        }

        if (urlFilter) {
          const isValid = await checkPathFromFilter(urlPath, urlFilter);
          if (!isValid) {
            continue;
          }
        }

        // create path if it doesn't exist
        spec.paths[urlPath] ??= getPathAndParamsFromUrl(urlPath);
        const path = spec.paths[urlPath] as PathItemObject;

        // create method
        const method = item.request.method.toLowerCase();
        path[method] ??= addMethod(method, urlPath, config);
        const specMethod = path[method] as OperationObject;
        // generate response
        const status = item.response?.status;
        if (status) {
          specMethod.responses[status] ??= addResponse(status, method);
        }

        const requestHeaders = item.request.headers;
        if (securityHeaders && requestHeaders) {
          const security = getSecurity(requestHeaders, securityHeaders);
          specMethod.security = [security];
        }

        // add query string parameters
        if (item.request.queryString) {
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

        // merge request example
        const shouldUseRequestAndResponse = !ignoreBodiesForStatusCodes || !ignoreBodiesForStatusCodes.includes(status);
        if (shouldUseRequestAndResponse && item.request.postData) {
          specMethod.requestBody = await getBody(item.request.postData, urlPath, method);
        }

        // merge response example
        if (status && isValidMimetype && shouldUseRequestAndResponse && item.response) {
          specMethod.responses[status] = await getResponseBody(item.response, urlPath, method, filterStandardHeaders);
        }
      }

      // If there were no valid paths, bail
      if (Object.keys(spec.paths).length === 0) {
        continue;
      }
      // sort paths
      spec.paths = sortJson(spec.paths, { depth: 200 });
      const yamlSpec = YAML.dump(spec);
      specs.push({ spec, yamlSpec });
    } catch (err) {
      console.error(`Error creating spec for ${domain}`);
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
  return { spec, yamlSpec: YAML.dump(spec) };
};

export { generateSpec, generateSpecs };
