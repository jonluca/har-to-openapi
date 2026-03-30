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
import type { Content, Cookie, Header, PostData, QueryString, Response } from "har-format";
import { convert as toOpenApiSchema } from "@openapi-contrib/json-schema-to-openapi-schema";
import { camelCase, startCase } from "lodash-es";
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

interface BodySample {
  postData: PostData | Content;
  headers?: Header[];
}

type FinalizedBodyContentState =
  | {
      kind: "json";
      sampleCount: number;
      example: unknown;
    }
  | {
      kind: "form";
      sampleCount: number;
    }
  | {
      kind: "raw";
      schema: SchemaObject;
      example: unknown;
      omitExample?: boolean;
    };

interface SecurityExtraction {
  requirement: SecurityRequirementObject;
  schemes: Record<string, SecuritySchemeObject>;
}

const jsonSchemaCache = new Map<string, Promise<SchemaObject>>();
const JSON_SCHEMA_CACHE_LIMIT = 256;

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
  const cacheKey = JSON.stringify([typeName, samples]);
  const cachedSchema = jsonSchemaCache.get(cacheKey);
  if (cachedSchema) {
    return cachedSchema;
  }

  if (jsonSchemaCache.size >= JSON_SCHEMA_CACHE_LIMIT) {
    jsonSchemaCache.clear();
  }

  const nextSchema = (async () => {
    const jsonSchema = await quicktypeJSON("schema", typeName, samples);
    return toOpenApiSchema(jsonSchema, options);
  })().catch((error) => {
    jsonSchemaCache.delete(cacheKey);
    throw error;
  });

  jsonSchemaCache.set(cacheKey, nextSchema);
  return nextSchema;
};

const getEmptyMultipartFallbackSchema = (): SchemaObject => {
  return {
    type: "object",
    properties: {
      filename: {
        description: "",
        format: "binary",
        type: "string",
      },
    },
  };
};

const buildBodyContentFromSamples = async (
  samples: BodySample[],
  details: { urlPath: string; method: string; suffix: "request" | "response" },
  config: InternalConfig,
): Promise<NonNullable<RequestBodyObject["content"]> | undefined> => {
  const jsonSamples: string[] = [];
  const formSamples: FormSample[] = [];
  const contentStates = new Map<string, FinalizedBodyContentState>();

  for (const sample of samples) {
    const mimeTypeValue = getMimeType(sample.postData, sample.headers, config);
    if (!mimeTypeValue) {
      continue;
    }

    const mimeType = parseMimeType(mimeTypeValue);
    const mimeEssence = mimeType.essence;
    const text = getDecodedText(sample.postData);
    const isBase64Encoded = "encoding" in sample.postData && (<any>sample.postData).encoding === "base64";
    const baseSchemaFallback = getBaseSchemaFallback(mimeType, isBase64Encoded);
    const baseExample = config.includeNonJsonExampleResponses ? text : undefined;

    if (isFormLikeMimeType(mimeType)) {
      const fields = getFormFields(sample.postData);
      if (fields.length) {
        formSamples.push({
          kind: "form",
          fields,
        });
        contentStates.set(mimeEssence, {
          kind: "form",
          sampleCount: formSamples.length,
        });
      } else if (!config.mimeTypes || config.mimeTypes.includes(mimeEssence)) {
        contentStates.set(mimeEssence, {
          kind: "raw",
          schema: getEmptyMultipartFallbackSchema(),
          example: undefined,
          omitExample: true,
        });
      }
      continue;
    }

    if (text === undefined) {
      continue;
    }

    const decodedText = text;
    const setJsonState = () => {
      const data = JSON.parse(decodedText);
      jsonSamples.push(JSON.stringify(data));
      contentStates.set(mimeEssence, {
        kind: "json",
        sampleCount: jsonSamples.length,
        example: data,
      });
    };

    if (mimeType.isXmlLike) {
      contentStates.set(mimeEssence, {
        kind: "raw",
        schema: { type: "string" },
        example: baseExample,
      });
      continue;
    }

    if (isBinaryMimeType(mimeType)) {
      if (config.relaxedContentTypeJsonParse) {
        try {
          setJsonState();
          continue;
        } catch {
          // fall through to binary handling below
        }
      }

      contentStates.set(mimeEssence, {
        kind: "raw",
        schema: baseSchemaFallback,
        example: baseExample,
      });
      continue;
    }

    const shouldParseAsJson = mimeType.isJsonLike || config.relaxedContentTypeJsonParse;
    if (shouldParseAsJson) {
      try {
        setJsonState();
        continue;
      } catch {
        // fall through to string fallback below
      }
    }

    contentStates.set(mimeEssence, {
      kind: "raw",
      schema: baseSchemaFallback,
      example: baseExample,
    });
  }

  if (!contentStates.size) {
    return undefined;
  }

  const content: NonNullable<RequestBodyObject["content"]> = {};
  for (const [mimeEssence, state] of contentStates.entries()) {
    if (state.kind === "json") {
      content[mimeEssence] = {
        schema: await buildJsonSchema(jsonSamples.slice(0, state.sampleCount), details.urlPath, details.method, details.suffix),
        example: state.example,
      };
      continue;
    }

    if (state.kind === "form") {
      const schema = mergeFormSamples(formSamples.slice(0, state.sampleCount), config.inferParameterTypes);
      if (schema) {
        content[mimeEssence] = {
          schema,
        };
      }
      continue;
    }

    content[mimeEssence] = state.omitExample
      ? {
          schema: state.schema,
        }
      : {
          schema: state.schema,
          example: state.example,
        };
  }

  return Object.keys(content).length ? content : undefined;
};

const getCustomResponseHeaders = (headers: Header[] | undefined, config: InternalConfig): HeadersObject | undefined => {
  const responseHeaders = headers || [];
  const customHeaders = config.filterStandardHeaders
    ? responseHeaders.filter((header) => {
        return !shouldFilterHeader(header.name, config.securityHeaders);
      })
    : responseHeaders;

  if (!customHeaders.length) {
    return undefined;
  }

  return customHeaders.reduce<HeadersObject>((acc, header) => {
    acc[header.name] = {
      description: `Custom header ${header.name}`,
      schema: {
        type: "string",
      },
    };
    return acc;
  }, {} as HeadersObject);
};

export const buildRequestBodyFromSamples = async (
  samples: BodySample[],
  details: { urlPath: string; method: string; suffix?: "request" | "response" },
  config: InternalConfig,
): Promise<RequestBodyObject | undefined> => {
  const content = await buildBodyContentFromSamples(
    samples,
    {
      ...details,
      suffix: details.suffix ?? "request",
    },
    config,
  );
  if (!content) {
    return undefined;
  }

  return {
    required: true,
    content,
  };
};

export const buildResponseBodyFromSamples = async (
  responses: Response[],
  details: { urlPath: string; method: string },
  config: InternalConfig,
): Promise<ResponseObject | undefined> => {
  const content = await buildBodyContentFromSamples(
    responses.map((response) => ({
      postData: response.content,
      headers: response.headers,
    })),
    {
      ...details,
      suffix: "response",
    },
    config,
  );

  const mergedHeaders = responses.reduce<HeadersObject | undefined>((acc, response) => {
    const nextHeaders = getCustomResponseHeaders(response.headers, config);
    if (!nextHeaders) {
      return acc;
    }
    return {
      ...acc,
      ...nextHeaders,
    };
  }, undefined);

  if (!content && !mergedHeaders) {
    return undefined;
  }

  const responseObject: ResponseObject = {
    description: "",
  };
  if (content) {
    responseObject.content = content;
  }
  if (mergedHeaders) {
    responseObject.headers = mergedHeaders;
  }
  return responseObject;
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
  const existingParameterKeys = new Set(
    parameters.map((parameter: any) => `${parameter.name}:${parameter.in}:${parameter.$ref}`),
  );
  const customHeaders = filterStandardHeaders
    ? headers.filter((header) => {
        return !shouldFilterHeader(header.name, securityHeaders);
      })
    : headers;
  customHeaders.forEach((header) => {
    const parameterKey = `${header.name}:header:undefined`;
    if (existingParameterKeys.has(parameterKey)) {
      return;
    }

    existingParameterKeys.add(parameterKey);
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
  return buildRequestBodyFromSamples(
    [
      {
        postData,
        headers: details.headers,
      },
    ],
    details,
    config,
  );
};

export const getResponseBody = async (
  response: Response,
  details: { urlPath: string; method: string; examples: any[] },
  config: InternalConfig,
): Promise<ResponseObject | undefined> => {
  return buildResponseBodyFromSamples([response], details, config);
};
