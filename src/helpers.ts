import type { InternalConfig } from "./types";
import type {
  HeadersObject,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SecurityRequirementObject,
} from "@loopback/openapi-v3-types";
import type { Content, Cookie, Header, PostData, PostDataParams, QueryString, Response } from "har-format";
import toOpenApiSchema from "@openapi-contrib/json-schema-to-openapi-schema";
import { quicktypeJSON } from "./quicktype";
import { camelCase, startCase, uniqBy } from "lodash";
import { shouldFilterHeader } from "./utils/headers";
import { URLSearchParams } from "url";
import { getCookieSecurityName, getTypenameFromPath } from "./utils/string";
import MIMEType from "whatwg-mimetype";

export const addMethod = (method: string, url: URL, config: InternalConfig): OperationObject => {
  const path = url.pathname;
  // generate operation id
  const summary = `${method} ${getTypenameFromPath(path)}`;
  const operationId = camelCase(summary);
  const tags = config?.tags || [];
  let pathTags: string[] = [];
  if (typeof tags === "function") {
    const userDefinedTags = tags(path);
    pathTags = [userDefinedTags || []].flat();
  } else {
    for (const tag of tags) {
      const isTagArray = Array.isArray(tag);
      const comparison = isTagArray ? tag[0] : tag;
      if (path.includes(comparison)) {
        const tagToApply: string = isTagArray ? (tag.length === 2 ? tag[1] : tag[0]) : tag;
        pathTags.push(tagToApply);
      }
    }
  }

  const operationsObject = {
    operationId,
    description: "",
    summary: startCase(summary),
    parameters: [],
    responses: {},
  } as OperationObject;
  if (config?.addServersToPaths) {
    const server = {
      url: url.origin,
    };
    operationsObject.servers = [server]; // not perfect but we can try and set the servers property here
  }
  if (pathTags?.length) {
    operationsObject.tags = pathTags;
  }
  return operationsObject;
};

export const addRequestHeaders = (specMethod: OperationObject, headers: Header[], config: InternalConfig) => {
  const parameters = (specMethod.parameters ??= []);
  const { filterStandardHeaders, securityHeaders = [] } = config;
  const customHeaders = filterStandardHeaders
    ? headers.filter((header) => {
        return !shouldFilterHeader(header.name, securityHeaders);
      })
    : headers;
  customHeaders.forEach((header) => {
    parameters.push({
      schema: {
        type: "string",
        default: header.value,
        example: header.value,
      },
      in: "header",
      name: header.name,
      description: header.name,
    } as ParameterObject);
  });
  specMethod.parameters = uniqBy(parameters, (elem: any) => {
    return `${elem.name}:${elem.in}:${elem.$ref}`;
  });
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

export const getSecurity = (
  headers: Header[],
  securityHeaders: string[],
  cookies: Cookie[] | undefined,
): SecurityRequirementObject | undefined => {
  const security: SecurityRequirementObject = {};
  headers.forEach(function (header) {
    const headerName = header.name.trim().toLowerCase();
    if (securityHeaders.includes(headerName)) {
      security[header.name] = [];
      if (headerName === "cookie" && cookies?.length) {
        cookies.forEach((cookie) => {
          const securityName = getCookieSecurityName(cookie);

          security["cookie"]?.push(securityName);
        });
      }
    }
  });
  if (Object.keys(security).length === 0) {
    return undefined;
  }
  return security;
};

const mapParams = (params: PostDataParams["params"]): SchemaObject => {
  const properties: SchemaObject["properties"] = {};
  const required: SchemaObject["required"] = params.map((query) => {
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
  const response: SchemaObject = {
    type: "object",
    properties,
  };
  if (required.length) {
    response.required = required;
  }
  return response;
};
const getFormData = (postData: PostData | Content): SchemaObject | undefined => {
  if (postData && "params" in postData && postData?.params?.length && postData.params.length > 0) {
    return mapParams(postData.params);
  }
  if (postData && "text" in postData) {
    const searchParams = new URLSearchParams(postData.text);
    const params: PostDataParams["params"] = [];
    searchParams.forEach((value, key) => {
      params.push({ value, name: key });
    });
    return mapParams(params);
  }
};
const isBinaryMimeType = (mimeType: MIMEType): boolean => {
  return (
    ["image", "audio", "video"].includes(mimeType.type) ||
    [
      "octet-stream",
      "x-octet-stream",
      "pdf",
      "png",
      "jpeg",
      "msword",
      "vnd.ms-excel",
      "vnd.ms-powerpoint",
      "zip",
      "rar",
      "x-tar",
      "x-7z-compressed",
    ].includes(mimeType.subtype)
  );
};

export const getBody = async (
  postData: PostData | Content | undefined,
  details: { urlPath: string; method: string; examples: any[] },
  config: InternalConfig,
): Promise<RequestBodyObject | undefined> => {
  if (!postData || !postData.mimeType) {
    return undefined;
  }

  const { urlPath, method, examples } = details;

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
  } as Parameters<typeof toOpenApiSchema>[1];
  if (postData && text !== undefined) {
    const mimeType = new MIMEType(postData.mimeType);
    const mimeEssence = mimeType.essence;
    const mime = mimeType.subtype;

    // do nothing on json parse failures - just take the mime type and say its a string
    const isBase64Encoded = "encoding" in postData && (<any>postData).encoding == "base64";
    const isBinary = isBinaryMimeType(mimeType);
    const baseSchemaFallback = { type: "string", format: isBase64Encoded || isBinary ? "binary" : undefined };

    // first check for binary types
    const tryParseJson = async () => {
      const data = JSON.parse(isBase64Encoded ? Buffer.from(text, "base64").toString() : text);
      examples.push(JSON.stringify(data));
      const typeName = camelCase([getTypenameFromPath(urlPath), method, "request"].join(" "));
      const jsonSchema = await quicktypeJSON("schema", typeName, examples);
      const schema = await toOpenApiSchema(jsonSchema, options);
      return { schema, data };
    };
    if (isBinary) {
      if (config.relaxedContentTypeJsonParse) {
        try {
          const { schema, data } = await tryParseJson();
          param.content[mimeEssence] = {
            schema,
            example: data,
          };
          return param;
        } catch (err) {
          // continue
        }
      }
      param.content[mimeEssence] = {
        schema: baseSchemaFallback,
      };
      return param;
    }
    // We run the risk of circular references down below
    const mimeLower = mime!.toLocaleLowerCase();
    switch (mimeLower) {
      case "form-data":
      case "x-www-form-urlencoded":
        const formSchema = getFormData(postData);
        if (formSchema) {
          const schema = await toOpenApiSchema(formSchema, options);
          if (schema) {
            param.content[mimeEssence] = {
              schema,
            };
          }
        }
        break;
      // try and parse plain and text as json as well
      case "image":
      case "audio":
      case "video": {
        param.content[mimeEssence] = {
          schema: baseSchemaFallback,
        };
        break;
      }
      case "plain":
      case "text":
      case "json":
      default: {
        if (mimeLower === "json" || config.relaxedContentTypeJsonParse) {
          try {
            const { schema, data } = await tryParseJson();
            param.content[mimeEssence] = {
              schema,
              example: data,
            };
          } catch (err) {
            param.content[mimeEssence] = {
              schema: baseSchemaFallback,
              example: config.includeNonJsonExampleResponses ? text : undefined,
            };
          }
        }
        break;
      }
    }
    if (!param.content[mimeEssence]) {
      param.content[mimeEssence] = {
        schema: baseSchemaFallback,
        example: config.includeNonJsonExampleResponses ? text : undefined,
      };
    }
  } else {
    const multipartMimeType = "multipart/form-data";
    // Don't apply the fallback to if there is a filter and it doesn't include it
    if (!config.mimeTypes || config.mimeTypes.includes(multipartMimeType)) {
      param.content = {
        [multipartMimeType]: {
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
  }
  return param;
};

export const getResponseBody = async (
  response: Response,
  details: { urlPath: string; method: string; examples: any[] },
  config: InternalConfig,
): Promise<ResponseObject | undefined> => {
  const body = await getBody(response.content, details, config);

  const { filterStandardHeaders, securityHeaders } = config;
  const param: ResponseObject = {
    description: "",
  };
  if (body?.content) {
    param.content = body.content;
  }

  const headers = response.headers || [];
  const customHeaders = filterStandardHeaders
    ? headers.filter((header) => {
        return !shouldFilterHeader(header.name, securityHeaders);
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
  if (param.headers || param.content) {
    return param;
  }
};
