import type { OpenApiSpec, OperationObject } from "@loopback/openapi-v3-types";
import { createEmptyApiSpec } from "@loopback/openapi-v3-types";
import type { Entry, Har } from "har-format";
import YAML from "js-yaml";
import sortJson from "sort-json";
import toOpenApiSchema from "browser-json-schema-to-openapi-schema";
import {
  addMethod,
  addQueryStringParams,
  addResponse,
  getBody,
  getPathAndParamsFromUrl,
  getResponseBody,
  getSecurity,
  quicktypeJSON,
  validateExampleList,
} from "./utils";
import type { Config, ExampleFile, IGenerateSpecResponse } from "./types";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";
import { groupBy } from "lodash-es";

const generateSpecs = async <T extends Har>(har: T, config?: Config): Promise<IGenerateSpecResponse[]> => {
  if (!har?.log?.entries?.length) {
    return [];
  }
  // decode base64 now before writing pretty har file
  har.log.entries.forEach((item, index) => {
    if (item.response.content.encoding === "base64") {
      har.log.entries[index].response.content.text = Buffer.from(item.response.content.text || "", "base64").toString();
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

  for (const domain in groupedByHostname) {
    try {
      // loop through har entries
      const spec = createEmptyApiSpec();
      spec.info.title = "HarToOpenApi";
      const { ignoreBodiesForStatusCodes, apiBasePath, mimeTypes, securityHeaders } = config || {};
      for (const item of har.log.entries) {
        const url = item.request.url;
        // if the config specified a base path, we'll only generate specs for urls that include it
        if (apiBasePath && !url.includes(apiBasePath)) {
          continue;
        }

        // filter and collapse path urls
        const urlPath = new URL(url).pathname;

        // continue if url is blank
        if (!urlPath) {
          continue;
        }

        // create path if it doesn't exist
        spec.paths[urlPath] ??= getPathAndParamsFromUrl(urlPath);
        const path = spec.paths[urlPath] as PathItemObject;

        // create method
        const method = item.request.method.toLowerCase();
        path[method] ??= addMethod(method, urlPath, config);
        const specMethod = path[method] as OperationObject;
        // generate response
        const status = item.response.status;
        if (status) {
          specMethod.responses[status] ??= addResponse(status, method);
        }

        if (securityHeaders) {
          const security = getSecurity(item.request.headers, securityHeaders);
          specMethod.security = [security];
        }

        // add query string parameters
        addQueryStringParams(specMethod, item.request.queryString);

        // merge request example
        const shouldUseRequestAndResponse = !ignoreBodiesForStatusCodes || !ignoreBodiesForStatusCodes.includes(status);
        const isValidMimetype = !mimeTypes || mimeTypes.includes(item.response?.content?.mimeType);
        if (shouldUseRequestAndResponse && item.request.postData) {
          specMethod.requestBody = await getBody(item.request.postData, urlPath, method);
        }

        // merge response example
        if (status && isValidMimetype && shouldUseRequestAndResponse && item.response) {
          specMethod.responses[status] = await getResponseBody(item.response, urlPath, method);
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
  return specs[0];
};
const generateSchema = async (oldSpec: OpenApiSpec, masterExamples: ExampleFile) => {
  const newSpec: OpenApiSpec = {
    openapi: oldSpec.openapi,
    info: oldSpec.info,
    servers: oldSpec.servers,
    paths: {},
  };
  for (const path in masterExamples) {
    // start with path object from examples spec
    if (oldSpec.paths[path]) {
      newSpec.paths[path] = oldSpec.paths[path];
    } else {
      newSpec.paths[path] = {};
    }

    for (const method in masterExamples[path]) {
      // create a spec if none exists. i.e. we added an example where there was no unit test
      if (!newSpec.paths[path][method]) {
        let operationId = path.replace(/(^\/|\/$|{|})/g, "").replace(/\//g, "-");
        operationId = `${method}-${operationId}`;
        newSpec.paths[path][method] = {
          operationId,
          summary: operationId,
          description: "",
          parameters: [],
          responses: {},
          tags: ["UNKNOWN"],
          meta: {
            originalPath: `https://app.crunch.io/api${path}`,
          },
        };
      }

      const methodObject = newSpec.paths[path][method];

      const numExamples = Object.keys(masterExamples[path][method].request).length;
      console.log(path, method, "request", numExamples);
      if (numExamples) {
        const exampleStats = validateExampleList(masterExamples[path][method].request, `${path} ${method} requests`);
        const jsonSchema = await quicktypeJSON("schema", [path, method, "request"].join("-"), exampleStats.allExamples);

        if (!methodObject.requestBody) {
          methodObject.requestBody = {
            content: {
              "application/json": {},
            },
          };
        }
        let schema = jsonSchema;
        try {
          schema = await toOpenApiSchema(jsonSchema);
        } catch (err) {
          console.log("ERROR CONVERTING TO OPENAPI SCHEMA, USING JSON SCHEMA");
        }
        methodObject.requestBody.content["application/json"].schema = schema;
        methodObject.requestBody.content["application/json"].examples = exampleStats.publishExamples;
      }

      for (const statusCode in masterExamples[path][method].response) {
        const numExamples = Object.keys(masterExamples[path][method].response[statusCode]).length;
        console.log(path, method, statusCode, numExamples);
        if (numExamples) {
          const exampleStats = validateExampleList(
            masterExamples[path][method].response[statusCode],
            `${path} ${method} requests`,
          );
          const jsonSchema = await quicktypeJSON(
            "schema",
            [path, method, "request"].join("-"),
            exampleStats.allExamples,
          );

          if (!methodObject.responses[statusCode]) {
            methodObject.responses[statusCode] = {
              content: {
                "application/json": {},
              },
            };
          }
          try {
            methodObject.responses[statusCode].content["application/json"].schema = await toOpenApiSchema(jsonSchema);
          } catch (err) {
            console.log("ERROR CONVERTING TO OPENAPI SCHEMA, USING JSON SCHEMA");
            methodObject.responses[statusCode].content["application/json"].schema = jsonSchema;
          }
          methodObject.responses[statusCode].content["application/json"].examples = exampleStats.publishExamples;
        }
      }
    }
  }

  return newSpec;
};

export { generateSpec, generateSchema, generateSpecs };
