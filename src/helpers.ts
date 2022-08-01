import pluralize from "pluralize";
import type { Config } from "./types";
import type { OperationObject } from "@loopback/openapi-v3-types";
import type { Content, Header, PostData, QueryString, Response } from "har-format";
import type {
  HeadersObject,
  ParameterObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SecurityRequirementObject,
} from "openapi3-ts/src/model/OpenApi";
import toOpenApiSchema from "browser-json-schema-to-openapi-schema";
import type { Options } from "browser-json-schema-to-openapi-schema/dist/mjs/src/types";
import { quicktypeJSON } from "./quicktype";
import { cloneDeep } from "lodash-es";
import { STANDARD_HEADERS } from "./utils/headers";
import { capitalize, pad } from "./utils/string";

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
  harParams?.forEach((param) => {
    if (!methodQueryParameters.includes(param.name)) {
      // add query parameter
      parameters.push({
        schema: {
          type: "string",
          default: decodeURIComponent(param.value),
          example: decodeURIComponent(param.value),
        },
        in: "query",
        name: param.name,
        description: param.name,
      });
    }
  });
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

const getFormData = (postData: PostData | Content | undefined): SchemaObject => {
  if (!postData) {
    return {};
  }
  if ("params" in postData && postData?.params?.length && postData.params.length > 0) {
    const properties: SchemaObject["properties"] = {};
    const required: SchemaObject["required"] = postData.params.map((query) => {
      if (query.value == "" || query.value == "(binary)") {
        properties[query.name] = {
          type: "string",
          format: "binary",
        };
        return query.name;
      }
      properties[query.name] = {
        type: "string",
      };
      return query.name;
    });
    return {
      type: "object",
      properties,
      required,
    };
  }
  return {};
};

export const getBody = async (
  postData: PostData | Content | undefined,
  urlPath: string,
  method: string,
): Promise<RequestBodyObject | undefined> => {
  if (!postData || !postData.mimeType) {
    return undefined;
  }

  const param: RequestBodyObject = {
    required: true,
    content: {},
  };
  const text = postData.text;
  const options = {
    cloneSchema: true,
    dereference: true,
    dereferenceOptions: {
      dereference: {
        circular: "ignore",
      },
    },
  } as Options;
  if (postData && text !== undefined) {
    const mimeTypeWithoutExtras = postData.mimeType.split(";")[0];
    const string = mimeTypeWithoutExtras?.split("/");
    const mime = string[1] || string[0];
    // We run the risk of circular references here
    switch (mime.toLocaleLowerCase()) {
      case "form-data":
      case "x-www-form-urlencoded":
        const formSchema = getFormData(postData);
        param.content[mimeTypeWithoutExtras] = {
          // @ts-ignore
          schema: await toOpenApiSchema(formSchema, options),
        };
        break;
        // try and parse plain and text as json as well
      case "plain":
      case "text":
      case "json":
      default:
        try {
          const isBase64Encoded = "encoding" in postData && (<any>postData).encoding == "base64";
          const data = JSON.parse(isBase64Encoded ? Buffer.from(text, "base64").toString() : text);

          try {
            const jsonSchema = await quicktypeJSON("schema", [urlPath, method, "request"].join("-"), text);
            try {
              const schema = await toOpenApiSchema(cloneDeep(jsonSchema), options);

              param.content[mimeTypeWithoutExtras] = {
                // @ts-ignore
                schema,
                example: data,
              };
            } catch (err) {
              console.error(err);
            }
          } catch (err) {
            console.error(err);
          }
        } catch (err) {
          // do nothing on json parse failures
        }
        break;
    }
  } else {
    // binary file sent
    param.content = {
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
    };
  }
  return param;
};

export const getResponseBody = async (
  response: Response,
  urlPath: string,
  method: string,
  filterStandardHeaders?: boolean,
): Promise<ResponseObject> => {
  // lets start with the request one because the code is the same
  const body = await getBody(response.content, urlPath, method);

  const param: ResponseObject = {
    content: body?.["content"] || {},
    description: "",
  };
  const headers = response.headers || [];
  const customHeaders = filterStandardHeaders
    ? headers.filter((header) => {
        return !STANDARD_HEADERS.includes(header.name.toLowerCase());
      })
    : headers;
  if (customHeaders.length) {
    param.headers = customHeaders.reduce<HeadersObject>((acc, header) => {
      acc[header.name] = {
        description: `Custom header ${header.name}`,
        schema: {
          type: "string",
        },
      };
      return acc;
    }, {} as HeadersObject);
  }
  return param;
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
