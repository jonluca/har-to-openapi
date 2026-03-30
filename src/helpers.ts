import type {
  HeadersObject,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SecurityRequirementObject,
  SecuritySchemeObject,
} from "@loopback/openapi-v3-types";
import type { Content, Cookie, Header, PostData, PostDataParams, QueryString, Response } from "har-format";
import { convert as toOpenApiSchema } from "@openapi-contrib/json-schema-to-openapi-schema";
import { camelCase, startCase, uniqBy } from "lodash-es";
import { URLSearchParams } from "url";
import { quicktypeJSON } from "./quicktype.js";
import type { InternalConfig } from "./types.js";
import { isLikelyAuthCookieName, shouldFilterHeader } from "./utils/headers.js";
import { getCookieSecurityName, getTypenameFromPath } from "./utils/string.js";
import { coerceExampleValue, inferScalarSchema, mergeScalarSchemas } from "./utils/inference.js";

interface ParsedMimeType {
  type: string;
  subtype: string;
  essence: string;
  suffix?: string;
  isJsonLike: boolean;
  isXmlLike: boolean;
}

function parseMimeType(mimeString: string): ParsedMimeType {
  const essence = mimeString.split(";")[0].trim().toLowerCase();
  const [type = "", subtype = ""] = essence.split("/");
  const suffix = subtype.includes("+") ? subtype.split("+").at(-1) : undefined;
  const isJsonLike =
    essence === "text/json" ||
    subtype === "json" ||
    subtype === "x-json" ||
    subtype.endsWith("+json") ||
    suffix === "json";
  const isXmlLike = essence === "application/xml" || essence === "text/xml" || subtype === "xml" || suffix === "xml";
  return { type, subtype, essence, suffix, isJsonLike, isXmlLike };
}

interface FormFieldObservation {
  name: string;
  value: string;
  isBinary: boolean;
}

interface FormSample {
  kind: "form";
  fields: FormFieldObservation[];
}

interface SecurityExtraction {
  requirement: SecurityRequirementObject;
  schemes: Record<string, SecuritySchemeObject>;
}

const getHeaderValue = (headers: Header[] | undefined, headerName: string) => {
  const normalized = headerName.trim().toLowerCase();
  return headers?.find((header) => header.name.trim().toLowerCase() === normalized)?.value;
};

const getMimeType = (
  postData: PostData | Content,
  headers: Header[] | undefined,
  config: InternalConfig,
): string | undefined => {
  const postDataMime = "mimeType" in postData ? postData.mimeType?.trim() : undefined;
  if (postDataMime) {
    return postDataMime;
  }

  const headerMime = getHeaderValue(headers, "content-type")?.trim();
  if (headerMime) {
    return headerMime;
  }

  const hasParams = "params" in postData && Boolean(postData.params?.length);
  if (hasParams) {
    const hasBinaryField = Boolean(
      postData.params?.some((param) => {
        return Boolean(param.fileName || param.contentType || param.value === "(binary)");
      }),
    );
    return hasBinaryField ? "multipart/form-data" : "application/x-www-form-urlencoded";
  }

  if ("text" in postData && typeof postData.text === "string") {
    if (config.relaxedContentTypeJsonParse) {
      try {
        JSON.parse(postData.text);
        return "application/json";
      } catch {
        // fall through to text/plain
      }
    }

    return "text/plain";
  }

  return undefined;
};

const isBinaryMimeType = (mimeType: ParsedMimeType): boolean => {
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

const isFormLikeMimeType = (mimeType: ParsedMimeType) => {
  return mimeType.essence === "multipart/form-data" || mimeType.essence === "application/x-www-form-urlencoded";
};

const getDecodedText = (postData: PostData | Content) => {
  if (postData.text === undefined) {
    return undefined;
  }

  const isBase64Encoded = "encoding" in postData && (<any>postData).encoding === "base64";
  return isBase64Encoded ? Buffer.from(postData.text, "base64").toString() : postData.text;
};

const getBaseSchemaFallback = (mimeType: ParsedMimeType, isBase64Encoded: boolean): SchemaObject => {
  return {
    type: "string",
    format: isBase64Encoded || isBinaryMimeType(mimeType) ? "binary" : undefined,
  };
};

const getJsonSamples = (examples: any[]) => {
  return examples.filter((example): example is string => typeof example === "string");
};

const getFormSamples = (examples: any[]) => {
  return examples.filter((example): example is FormSample => example?.kind === "form");
};

const mapFormText = (text: string) => {
  const searchParams = new URLSearchParams(text);
  const fields: FormFieldObservation[] = [];
  searchParams.forEach((value, key) => {
    fields.push({
      name: key,
      value,
      isBinary: false,
    });
  });
  return fields;
};

const getFormFields = (postData: PostData | Content): FormFieldObservation[] => {
  if ("params" in postData && postData.params?.length) {
    return postData.params.map((param) => ({
      name: param.name,
      value: param.value ?? "",
      isBinary: Boolean(param.fileName || param.contentType || param.value === "(binary)"),
    }));
  }

  if ("text" in postData && typeof postData.text === "string") {
    return mapFormText(postData.text);
  }

  return [];
};

const mergeFormSamples = (samples: FormSample[], inferParameterTypes: boolean): SchemaObject | undefined => {
  if (!samples.length) {
    return undefined;
  }

  const fieldsByName = new Map<
    string,
    {
      schema: SchemaObject | undefined;
      count: number;
    }
  >();

  for (const sample of samples) {
    const seenInSample = new Set<string>();
    for (const field of sample.fields) {
      const existing = fieldsByName.get(field.name) ?? { schema: undefined, count: 0 };
      const nextSchema = field.isBinary
        ? ({ type: "string", format: "binary" } as SchemaObject)
        : inferScalarSchema(field.value, inferParameterTypes);
      existing.schema = mergeScalarSchemas(existing.schema, nextSchema);
      if (!seenInSample.has(field.name)) {
        existing.count += 1;
        seenInSample.add(field.name);
      }
      fieldsByName.set(field.name, existing);
    }
  }

  const properties: NonNullable<SchemaObject["properties"]> = {};
  const required: string[] = [];
  for (const [fieldName, fieldInfo] of fieldsByName.entries()) {
    properties[fieldName] = fieldInfo.schema ?? { type: "string" };
    if (fieldInfo.count === samples.length) {
      required.push(fieldName);
    }
  }

  const schema: SchemaObject = {
    type: "object",
    properties,
  };
  if (required.length) {
    schema.required = required;
  }
  return schema;
};

const buildJsonSchema = async (samples: string[], urlPath: string, method: string, suffix: "request" | "response") => {
  const options = {
    cloneSchema: true,
    dereference: true,
    dereferenceOptions: {
      dereference: {
        circular: "ignore",
      },
    },
  } as Parameters<typeof toOpenApiSchema>[1];
  const typeName = camelCase([getTypenameFromPath(urlPath), method, suffix].join(" "));
  const jsonSchema = await quicktypeJSON("schema", typeName, samples);
  return toOpenApiSchema(jsonSchema, options);
};

const parseCookiesFromHeader = (value: string): Cookie[] => {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) {
        return undefined;
      }
      return {
        name: part.slice(0, separatorIndex).trim(),
        value: part.slice(separatorIndex + 1).trim(),
      } as Cookie;
    })
    .filter((cookie): cookie is Cookie => Boolean(cookie?.name));
};

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

export const addQueryStringParams = (
  specMethod: OperationObject,
  harParams: QueryString[],
  config: Pick<InternalConfig, "inferParameterTypes">,
) => {
  const parameters = (specMethod.parameters ??= []);
  harParams?.forEach((param) => {
    const decodedValue = decodeURIComponent(param.value);
    const schema = inferScalarSchema(decodedValue, config.inferParameterTypes);
    const example = coerceExampleValue(decodedValue, schema);
    const existing = parameters.find(
      (parameter) => "in" in parameter && parameter.in === "query" && parameter.name === param.name,
    );
    if (existing && "schema" in existing) {
      existing.schema = mergeScalarSchemas(existing.schema as SchemaObject | undefined, schema);
      existing.example = coerceExampleValue(decodedValue, existing.schema as SchemaObject);
      if (existing.schema?.type !== "string" || !existing.schema.format) {
        existing.schema = {
          ...(existing.schema as SchemaObject),
          default: coerceExampleValue(decodedValue, existing.schema as SchemaObject),
        };
      }
      return;
    }

    parameters.push({
      schema: {
        ...schema,
        default: example,
      },
      in: "query",
      name: param.name,
      description: param.name,
      example,
    });
  });
};

export const getSecurity = (
  headers: Header[],
  securityHeaders: string[],
  cookies: Cookie[] | undefined,
): SecurityExtraction | undefined => {
  const requirement: SecurityRequirementObject = {};
  const schemes: Record<string, SecuritySchemeObject> = {};
  headers.forEach((header) => {
    const headerName = header.name.trim().toLowerCase();
    if (!securityHeaders.includes(headerName)) {
      return;
    }

    if (headerName === "authorization") {
      if (/^bearer\s+/i.test(header.value)) {
        requirement.bearerAuth = [];
        schemes.bearerAuth = {
          type: "http",
          scheme: "bearer",
        };
        return;
      }

      if (/^basic\s+/i.test(header.value)) {
        requirement.basicAuth = [];
        schemes.basicAuth = {
          type: "http",
          scheme: "basic",
        };
        return;
      }
    }

    if (headerName === "cookie") {
      const cookieValues = (cookies?.length ? cookies : parseCookiesFromHeader(header.value)).filter((cookie) =>
        isLikelyAuthCookieName(cookie.name),
      );
      if (!cookieValues.length) {
        return;
      }
      cookieValues.forEach((cookie) => {
        const securityName = getCookieSecurityName(cookie);
        requirement[securityName] = [];
        schemes[securityName] = {
          type: "apiKey",
          name: cookie.name,
          in: "cookie",
        };
      });
      return;
    }

    requirement[header.name] = [];
    schemes[header.name] = {
      type: "apiKey",
      name: header.name,
      in: "header",
    };
  });
  if (Object.keys(requirement).length === 0) {
    return undefined;
  }
  return { requirement, schemes };
};

export const getBody = async (
  postData: PostData | Content | undefined,
  details: { urlPath: string; method: string; examples: any[]; headers?: Header[]; suffix?: "request" | "response" },
  config: InternalConfig,
): Promise<RequestBodyObject | undefined> => {
  if (!postData) {
    return undefined;
  }

  const { urlPath, method, examples, headers, suffix = "request" } = details;
  const mimeTypeValue = getMimeType(postData, headers, config);
  if (!mimeTypeValue) {
    return undefined;
  }

  const param: RequestBodyObject = {
    required: true,
    content: {},
  };
  const mimeType = parseMimeType(mimeTypeValue);
  const mimeEssence = mimeType.essence;
  const text = getDecodedText(postData);
  const isBase64Encoded = "encoding" in postData && (<any>postData).encoding === "base64";
  const baseSchemaFallback = getBaseSchemaFallback(mimeType, isBase64Encoded);
  const baseExample = config.includeNonJsonExampleResponses ? text : undefined;

  if (isFormLikeMimeType(mimeType)) {
    const formFields = getFormFields(postData);
    if (formFields.length) {
      examples.push({
        kind: "form",
        fields: formFields,
      } satisfies FormSample);
      const formSchema = mergeFormSamples(getFormSamples(examples), config.inferParameterTypes);
      if (formSchema) {
        param.content[mimeEssence] = {
          schema: formSchema,
        };
      }
    } else if (!config.mimeTypes || config.mimeTypes.includes(mimeEssence)) {
      param.content[mimeEssence] = {
        schema: {
          type: "object",
          properties: {
            filename: {
              description: "",
              format: "binary",
              type: "string",
            },
          },
        },
      };
    }
    return Object.keys(param.content).length ? param : undefined;
  }

  if (text === undefined) {
    return undefined;
  }

  const tryParseJson = async () => {
    const data = JSON.parse(text);
    examples.push(JSON.stringify(data));
    const schema = await buildJsonSchema(getJsonSamples(examples), urlPath, method, suffix);
    return { schema, data };
  };

  if (mimeType.isXmlLike) {
    param.content[mimeEssence] = {
      schema: { type: "string" },
      example: baseExample,
    };
    return param;
  }

  if (isBinaryMimeType(mimeType)) {
    if (config.relaxedContentTypeJsonParse) {
      try {
        const { schema, data } = await tryParseJson();
        param.content[mimeEssence] = {
          schema,
          example: data,
        };
        return param;
      } catch {
        // fall back to binary handling below
      }
    }

    param.content[mimeEssence] = {
      schema: baseSchemaFallback,
      example: baseExample,
    };
    return param;
  }

  const shouldParseAsJson = mimeType.isJsonLike || config.relaxedContentTypeJsonParse;
  if (shouldParseAsJson) {
    try {
      const { schema, data } = await tryParseJson();
      param.content[mimeEssence] = {
        schema,
        example: data,
      };
      return param;
    } catch {
      // fall through to string fallback below
    }
  }

  param.content[mimeEssence] = {
    schema: baseSchemaFallback,
    example: baseExample,
  };
  return param;
};

export const getResponseBody = async (
  response: Response,
  details: { urlPath: string; method: string; examples: any[] },
  config: InternalConfig,
): Promise<ResponseObject | undefined> => {
  const body = await getBody(
    response.content,
    {
      ...details,
      headers: response.headers,
      suffix: "response",
    },
    config,
  );

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
