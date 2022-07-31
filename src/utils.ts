import pluralize from "pluralize";
import type { Config } from "./types";
import type { OpenApiSpec, OperationObject } from "@loopback/openapi-v3-types";
import type { Content, QueryString } from "har-format";
import type { ParameterObject, ReferenceObject, RequestBodyObject } from "openapi3-ts/src/model/OpenApi";
import type { TargetLanguage } from "quicktype-core/dist/TargetLanguage";
import { InputData, jsonInputForTargetLanguage, quicktype } from "quicktype-core";
import deref from "json-schema-deref-sync";
import sortJson from "sort-json";
import YAML from "js-yaml";
import merge from "deepmerge";
import type { PathsObject } from "openapi3-ts/src/model/OpenApi";
import type { ResponseObject } from "openapi3-ts/src/model/OpenApi";
import type { Header } from "har-format";
import type { SecurityRequirementObject } from "openapi3-ts/src/model/OpenApi";
export const pad = (m: number, width: number, z = "0") => {
  const n = m.toString();
  return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
};
export const capitalize = (s: unknown): string => {
  if (typeof s !== "string") {
    return "";
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const deriveSummary = (method: string, path: string) => {
  const pathParts = path.split("/");
  const lastParam = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";
  const lastLastParam = pathParts.length > 3 ? pathParts[pathParts.length - 4] : "";
  const obj = lastParam.includes("_id") ? lastParam.replace(/[{}]|_id/g, "") : "";
  switch (lastParam) {
    case "login":
      return "Log in";
    case "logout":
      return "Log out";
  }
  if (obj) {
    switch (method) {
      case "get":
        return `${capitalize(obj)} details`;
      case "post":
        return `Create ${obj}`;
      case "patch":
      case "put":
        return `Update ${obj}`;
      case "delete":
        return `Delete ${obj}`;
    }
  }
  const param = pluralize(lastLastParam, 1);
  const spacer = lastLastParam ? " " : "";
  switch (method) {
    case "get":
      return `List ${param}${spacer}${pluralize(lastParam)}`;
    case "post":
      return `Create ${param}${spacer}${pluralize(lastParam, 1)}`;
    case "put":
    case "patch":
      return `Update ${param}${spacer}${pluralize(lastParam)}`;
    case "delete":
      return `Delete ${param}${spacer}${pluralize(lastParam)}`;
  }
  return "SUMMARY";
};

export const deriveTag = (path: string, config?: Config) => {
  const newVar = config?.tags || [];
  for (const item of newVar) {
    if (path.includes(item[0])) {
      return item.length > 1 ? item[1] : capitalize(item[0]);
    }
  }
  return "";
};

export async function quicktypeJSON(targetLanguage: string | TargetLanguage, typeName: string, sampleArray: any[]) {
  const jsonInput = jsonInputForTargetLanguage(targetLanguage);

  await jsonInput.addSource({
    name: typeName,
    samples: sampleArray,
  });

  const inputData = new InputData();
  inputData.addInput(jsonInput);

  const result = await quicktype({
    inputData,
    lang: targetLanguage,
    alphabetizeProperties: true,
    allPropertiesOptional: true,
    ignoreJsonRefs: true,
  });

  const returnJSON = JSON.parse(result.lines.join("\n"));
  return deref(returnJSON); // this one does not contain references
}

export const addMethod = (method: string, path: string, config?: Config): OperationObject => {
  // generate operation id
  let operationId = path.replace(/(^\/|\/$|{|})/g, "").replace(/\//g, "-");
  operationId = `${method}-${operationId}`;

  // create method
  const summary = deriveSummary(method, path);
  const tag = deriveTag(path, config);

  return {
    operationId,
    summary,
    description: "",
    parameters: [],
    responses: {},
    tags: [tag],
  } as OperationObject;
};
export const getPathAndParamsFromUrl = (filteredPath: string): PathsObject => {
  // identify what parameters this path has
  const parameters: (ParameterObject | ReferenceObject)[] = [];
  const parameterList = filteredPath.match(/{.*?}/g);
  if (parameterList) {
    parameterList.forEach((parameter) => {
      const variable = parameter.replace(/[{}]/g, "");
      const variableType = variable.replace(/_id/, "");
      parameters.push({
        description: `Unique ID of the ${variableType} you are working with`,
        in: "path",
        name: variable,
        required: true,
        schema: {
          type: "string",
        },
      });
    });
  }

  // create path with parameters
  return {
    parameters,
  };
};
export const addQueryStringParams = (specMethod: OperationObject, harParams: QueryString[]) => {
  const methodQueryParameters: string[] = [];
  const parameters = (specMethod.parameters ??= []);
  parameters.forEach((param) => {
    if ("in" in param && param.in === "query") {
      methodQueryParameters.push(param.name);
    }
  });
  harParams.forEach((param) => {
    if (!methodQueryParameters.includes(param.name)) {
      // add query parameter
      parameters.push({
        schema: {
          type: "string",
          default: param.value,
          example: param.value,
        },
        in: "query",
        name: param.name,
        description: param.name,
      });
    }
  });
};
// Map some known parameters to their OpenAPI3 counterparts, otherwise just fallback
export const addResponse = (status: number, method: string): ResponseObject => {
  switch (status) {
    case 200:
    case 201:
      switch (method) {
        case "get":
          return { description: "Success" };
        case "delete":
          return { description: "Deleted" };
        case "patch":
          return { description: "Updated" };
        case "post":
          return { description: "Created" };
        default:
          return { description: "Success" };
      }
    case 304:
      return { description: "Not modified" };
    case 400:
      switch (method) {
        case "delete":
          return { description: "Deletion failed" };
        default:
          return { description: "Bad request" };
      }
    case 401:
      return { description: "Unauthorized" };
    case 404:
      return { description: "Not found" };
    case 405:
      return { description: "Not allowed" };
    case 500:
    case 501:
    case 502:
    case 503:
      return { description: "Server error" };
    default:
      if (status > 200 && status < 300) {
        switch (method) {
          case "get":
            return { description: "Success" };
          case "delete":
            return { description: "Deleted" };
          case "patch":
            return { description: "Updated" };
          case "post":
            return { description: "Created" };
        }
      } else if (status >= 300 && status < 400) {
        return { description: "Redirect" };
      } else if (status >= 400 && status < 500) {
        return { description: "Client error" };
      } else if (status >= 500 && status < 600) {
        return { description: "Server error" };
      }
  }
  return { description: "Unknown" };
};

export const getSecurity = (headers: Header[], securityHeaders: string[]): SecurityRequirementObject => {
  const security: SecurityRequirementObject = {};
  headers.forEach(function (header) {
    const headerName = header.name.trim();
    if (headerName.toLocaleLowerCase() === "authorization") {
      security["JWT"] = [];
    }

    if (securityHeaders.includes(headerName)) {
      security[headerName] = [];
    }
  });
  return security;
};
export const mergeRequestExample = (specMethod: OperationObject, postData: any) => {
  if (postData?.text) {
    // data sent
    try {
      const data = JSON.parse(
        postData.encoding == "base64" ? Buffer.from(postData.text, "base64").toString() : postData.text,
      );
      // if (Object.keys(data).length < 1) return;

      specMethod["requestBody"] ??= {
        content: {
          "application/json": {
            examples: {
              "example-0001": {
                value: {},
              },
            },
            schema: {
              properties: {},
              type: "object",
            },
          },
        },
      };
      const requestBody = specMethod.requestBody as RequestBodyObject;
      const examples = requestBody!["content"]["application/json"].examples || {};

      // do not add example if it is duplicate of another example
      const dataString = JSON.stringify(data);
      for (const example in examples) {
        const example2 = examples[example] as RequestBodyObject;
        const compare = JSON.stringify(example2["value"]);
        if (dataString === compare) {
          return;
        }
      }

      // merge this object with other objects found
      const example1 = examples?.["example-0001"] as RequestBodyObject;
      if (example1) {
        example1["value"] = merge(example1["value"], data, {
          arrayMerge: (a, b) => b,
        });
      }

      // also add a new example
      const num = pad(Object.keys(examples).length + 1, 4);
      examples[`example-${num}`] = {
        value: data,
      };
    } catch (err) {
      // dont do anything on JSON parse errors
    }
  } else {
    // binary file sent
    if (!specMethod["requestBody"]) {
      specMethod["requestBody"] = {
        content: {
          "multipart/form-data": {
            schema: {
              properties: {
                filename: {
                  description: "",
                  format: "binary",
                  type: "string",
                },
              },
              type: "object",
            },
          },
        },
      };
    }
  }
};
export const mergeResponseExample = (specMethod: OperationObject, statusString: string, content: Content) => {
  try {
    const isBase64 = content.encoding == "base64";
    const str = content.text || "";
    const data = JSON.parse(isBase64 ? Buffer.from(str, "base64").toString() : str);

    // create response example if it doesn't exist
    if (!specMethod.responses[statusString]["content"]) {
      specMethod.responses[statusString]["content"] = {
        "application/json": {
          examples: {
            "example-0001": {
              value: {},
            },
          },
          schema: {
            properties: {},
            type: "object",
          },
        },
      };
    }

    // const examples = specMethod.responses[statusString].content["application/json"].examples['example-1']
    const examples = specMethod.responses[statusString].content["application/json"].examples;

    // do not add example if it is duplicate of another example
    const dataString = JSON.stringify(data);
    for (const example in examples) {
      const compare = JSON.stringify(examples[example]["value"]);
      if (dataString === compare) {
        return;
      }
    }

    // merge current response into other response examples
    examples["example-0001"]["value"] = merge(examples["example-0001"]["value"], data, {
      arrayMerge: (a, b) => b,
    });

    // also add a new example
    examples[`example-${pad(Object.keys(examples).length + 1, 4)}`] = {
      value: data,
    };
  } catch (err) {
    console.error(err);
  }
};
export const getExamples = (spec: OpenApiSpec) => {
  const specExamples: any = {};
  Object.keys(spec.paths).forEach((path) => {
    specExamples[path] = {};
    Object.keys(spec.paths[path]).forEach((lMethod) => {
      if (lMethod === "parameters") {
        return;
      }
      if (lMethod === "options") {
        return;
      }
      specExamples[path][lMethod] = {
        request: {},
        response: {},
      };
      const method = spec.paths[path][lMethod];

      // find request examples
      let examples = method.requestBody?.content?.["application/json"]?.examples;
      if (examples) {
        // add examples to list
        const exampleCount = Object.keys(examples).length;
        let exampleNum = 0;
        for (const example in examples) {
          exampleNum++;
          if (exampleNum < 2 || exampleCount != 2) {
            specExamples[path][lMethod]["request"][example] = examples[example]["value"];
          }
        }
      }

      // look at responses
      for (const status in method.responses) {
        examples = method.responses?.[status]?.content?.["application/json"]?.examples;
        if (examples) {
          specExamples[path][lMethod]["response"][status] = {};
          const exampleCount = Object.keys(examples).length;
          let exampleNum = 0;
          for (const example in examples) {
            exampleNum++;
            if (exampleNum < 2 || exampleCount != 2) {
              specExamples[path][lMethod]["response"][status][example] = examples[example]["value"];
            }
          }
        }
      }
    });
  });

  // sort examples
  const sortedExamples = sortJson(specExamples, { depth: 200 });
  // dump as yaml
  const yamlExamples = YAML.dump(sortedExamples);

  return { sortedExamples, yamlExamples };
};
export const validateExampleList = (exampleObject: any, exampleObjectName: string) => {
  const exampleCount = Object.keys(exampleObject).length;
  let gexampleCount = 0;
  const allExamples: string[] = [];
  const publishExamplesArray: string[] = [];
  for (const exampleName in exampleObject) {
    allExamples.push(JSON.stringify(exampleObject[exampleName]));
    if (exampleName.includes("gexample")) {
      gexampleCount += 1;
      publishExamplesArray.push(exampleObject[exampleName]);
    }
  }
  if (exampleCount && !gexampleCount) {
    console.log(`${exampleObjectName} has ${exampleCount} examples with no gexamples`);
  }
  // renumber examples
  const padWidth = Math.floor(publishExamplesArray.length / 10) + 1;
  const publishExamples: Record<string, { value: any }> = {};
  let firstExample: any;
  for (let i = 0; i < publishExamplesArray.length; i++) {
    const exampleName = `example-${pad(i + 1, padWidth)}`;
    if (!firstExample) {
      firstExample = publishExamplesArray[i];
    }
    publishExamples[exampleName] = { value: publishExamplesArray[i] };
  }

  return {
    allExamples,
    publishExamples,
    firstExample,
  };
};
