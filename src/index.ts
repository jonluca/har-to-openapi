import type { OpenApiSpec, OperationObject } from "@loopback/openapi-v3-types";
import { createEmptyApiSpec } from "@loopback/openapi-v3-types";
import type { Har } from "har-format";
import YAML from "js-yaml";
import sortJson from "sort-json";
import toOpenApiSchema from "browser-json-schema-to-openapi-schema";
import {
  addMethod,
  addPath,
  addQueryStringParams,
  addResponse,
  filterUrl,
  mergeRequestExample,
  mergeResponseExample,
  quicktypeJSON,
  validateExampleList,
  getExamples,
} from "./utils";
import type { Config, ExampleFile } from "./types";
import type { PathItemObject } from "openapi3-ts/src/model/OpenApi";

const generateSpec = <T extends Har>(har: T, config?: Config) => {
  // decode base64 now before writing pretty har file
  har.log.entries.forEach((item, index) => {
    if (item.response.content.encoding === "base64") {
      har.log.entries[index].response.content.text = Buffer.from(item.response.content.text || "", "base64").toString();
      delete har.log.entries[index].response.content.encoding;
    }
  });
  // loop through har entries
  const spec = createEmptyApiSpec();
  const methodList: string[] = [];
  const { ignoreBodiesForStatusCodes, apiBasePath } = config || {};
  har.log.entries.sort().forEach((item) => {
    // only care about urls that match target api
    if (apiBasePath && !item.request.url.includes(apiBasePath)) {
      return;
    }

    // filter and collapse path urls
    const filteredUrl = filterUrl(config, item.request.url);

    // continue if url is blank
    if (!filteredUrl) {
      return;
    }

    // create path
    if (!spec.paths[filteredUrl]) {
      addPath(filteredUrl, spec);
    }
    const path = spec.paths[filteredUrl] as PathItemObject;

    // create method
    const method = item.request.method.toLowerCase();
    if (!path[method]) {
      addMethod(method, filteredUrl, item.request.url, methodList, spec, config);
    }
    const specMethod = path[method] as OperationObject;

    // set original path to last request received
    specMethod.meta.originalPath = item.request.url;
    // generate response
    const status = item.response.status;
    addResponse(status, method, specMethod);

    // add query string parameters
    addQueryStringParams(specMethod, item.request.queryString);

    // merge request example
    const shouldUseRequestAndResponse = !ignoreBodiesForStatusCodes || !ignoreBodiesForStatusCodes.includes(status);
    if (item.request.bodySize > 0 && status < 400) {
      if (shouldUseRequestAndResponse && item.request.postData) {
        mergeRequestExample(specMethod, item.request.postData);
      }
    }

    // merge response example
    if (item.response.bodySize > 0) {
      if (shouldUseRequestAndResponse && item.response.content) {
        mergeResponseExample(specMethod, status.toString(), item.response.content);
      }
    }
  });

  // sort paths
  spec.paths = sortJson(spec.paths, { depth: 200 });

  const yamlSpec = YAML.dump(spec);

  const { sortedExamples, yamlExamples } = getExamples(spec);
  return { spec, yamlSpec, sortedExamples, yamlExamples };
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
        methodObject.requestBody.content["application/json"].schema = await toOpenApiSchema(jsonSchema).catch((err) => {
          console.log("ERROR CONVERTING TO OPENAPI SCHEMA, USING JSON SCHEMA");
          methodObject.requestBody.content["application/json"].schema = jsonSchema;
        });
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

export { generateSpec, generateSchema };
