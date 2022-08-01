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
import type { Options } from "@openapi-contrib/json-schema-to-openapi-schema";
import { quicktypeJSON } from "./quicktype";
import { cloneDeep } from "lodash-es";

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
  if (postData && text) {
    const mimeTypeWithoutExtras = postData.mimeType.split(";")[0];
    const string = mimeTypeWithoutExtras?.split("/");
    const mime = string[1] || string[0];
    // We run the risk of circular references here
    switch (mime.toLocaleLowerCase()) {
      // try and parse plain and text as json as well
      case "plain":
      case "text":
      case "json":
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
      case "form-data":
      case "x-www-form-urlencoded":
        const formSchema = getFormData(postData);
        param.content[mimeTypeWithoutExtras] = {
          // @ts-ignore
          schema: await toOpenApiSchema(formSchema, options),
        };
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

const STANDARD_HEADERS = [
  "A-IM",
  "Accept",
  "Accept-Charset",
  "Accept-Encoding",
  "Accept-Language",
  "Accept-Datetime",
  "Access-Control-Request-Method",
  "Access-Control-Request-Headers",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Length",
  "Content-Type",
  "Cookie",
  "Date",
  "Expect",
  "Forwarded",
  "From",
  "Host",
  "If-Match",
  "If-Modified-Since",
  "If-None-Match",
  "If-Range",
  "If-Unmodified-Since",
  "Max-Forwards",
  "Origin",
  "Pragma",
  "Proxy-Authorization",
  "Range",
  "Referer",
  "TE",
  "User-Agent",
  "Upgrade",
  "Via",
  "Warning",
  "X-Frame-Options",
  "X-XSS-Protection",
].map((header) => header.toLowerCase());

export const getResponseBody = async (response: Response, urlPath: string, method: string): Promise<ResponseObject> => {
  // lets start with the request one because the code is the same
  const body = await getBody(response.content, urlPath, method);

  const param: ResponseObject = {
    content: body?.["content"] || {},
    description: "",
  };
  const customHeaders = (response.headers || []).filter((header) => {
    return !STANDARD_HEADERS.includes(header.name.toLowerCase());
  });
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
