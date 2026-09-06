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
import type { CaptureSource, InternalConfig } from "./types.js";
import { isLikelyAuthCookieName, shouldFilterHeader } from "./utils/headers.js";
import { getCookieSecurityName, getTypenameFromPath } from "./utils/string.js";
import { inferScalarSchema, mergeScalarSchemas } from "./utils/inference.js";
import { applyObservations, stableStringify } from "./utils/observations.js";
import {
  coerceParameterExample,
  mergeParameterSchemas,
  observeQueryParameters,
} from "./utils/structured-parameters.js";

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

export interface BodySample {
  postData: PostData | Content;
  headers?: Header[];
  source?: CaptureSource;
  status?: number;
}

interface BodyContentState {
  kind: "json" | "form" | "raw";
  jsonSamples: unknown[];
  rawSamples: string[];
  rawSchemas: SchemaObject[];
  formSamples: FormSample[];
  examples: unknown[];
  schema?: SchemaObject;
  source?: BodySample["source"];
  status?: number;
}

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

const mergeFormSamples = (samples: FormSample[], config: InternalConfig): SchemaObject | undefined => {
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
    const sampleFields = new Map<string, FormFieldObservation[]>();
    for (const field of sample.fields) {
      sampleFields.set(field.name, [...(sampleFields.get(field.name) ?? []), field]);
    }
    for (const [name, fields] of sampleFields) {
      const existing = fieldsByName.get(name) ?? { schema: undefined, count: 0 };
      const itemSchema = fields.reduce<SchemaObject | undefined>((schema, field) => {
        const next = field.isBinary
          ? ({ type: "string", format: "binary" } as SchemaObject)
          : inferScalarSchema(field.value, config.inferParameterTypes);
        return mergeScalarSchemas(schema, next);
      }, undefined) ?? { type: "string" };
      const nextSchema: SchemaObject =
        (config.inferArrayParameters ?? true) && fields.length > 1 ? { type: "array", items: itemSchema } : itemSchema;
      existing.schema = mergeParameterSchemas(existing.schema, nextSchema);
      existing.count += 1;
      fieldsByName.set(name, existing);
    }
  }

  const properties: NonNullable<SchemaObject["properties"]> = Object.create(null);
  const required: string[] = [];
  for (const [fieldName, fieldInfo] of fieldsByName.entries()) {
    properties[fieldName] = fieldInfo.schema ?? { type: "string" };
    if (config.requiredness !== "optional" && fieldInfo.count === samples.length) {
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
  if (config.includeInferenceEvidence) {
    (schema as Record<string, unknown>)["x-har-observations"] = {
      sampleCount: samples.length,
      fields: Object.fromEntries(
        [...fieldsByName].map(([name, field]) => [
          name,
          {
            presentCount: field.count,
            presenceRatio: field.count / samples.length,
          },
        ]),
      ),
    };
  }
  return schema;
};

const buildJsonSchema = async (
  samples: string[],
  urlPath: string,
  method: string,
  suffix: "request" | "response",
  openapiVersion: "3.0.0" | "3.1.0",
) => {
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
  const cacheKey = JSON.stringify([typeName, samples, openapiVersion]);
  const cachedSchema = jsonSchemaCache.get(cacheKey);
  if (cachedSchema) {
    return cachedSchema;
  }

  if (jsonSchemaCache.size >= JSON_SCHEMA_CACHE_LIMIT) {
    jsonSchemaCache.clear();
  }

  const nextSchema = (async () => {
    const jsonSchema = await quicktypeJSON("schema", typeName, samples);
    if (openapiVersion === "3.1.0") {
      // Quicktype's inferred subset is compatible with OpenAPI 3.1's JSON
      // Schema dialect. Keep null types instead of converting to 3.0 nullable.
      delete jsonSchema.$schema;
      return jsonSchema as SchemaObject;
    }
    return toOpenApiSchema(jsonSchema, options);
  })().catch((error) => {
    jsonSchemaCache.delete(cacheKey);
    throw error;
  });

  jsonSchemaCache.set(cacheKey, nextSchema);
  return nextSchema;
};

const removeEmptyRequired = (schema: SchemaObject): void => {
  if (schema.required?.length === 0) {
    delete schema.required;
  }
  const children = [
    ...Object.values(schema.properties ?? {}),
    schema.items,
    schema.additionalProperties,
    schema.not,
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  for (const child of children) {
    if (child && typeof child === "object" && !("$ref" in child)) {
      removeEmptyRequired(child);
    }
  }
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

const getBodyExamples = (values: unknown[], config: InternalConfig) => {
  if (config.examples === "none" || !values.length) {
    return {};
  }
  if (config.examples !== "multiple") {
    return values.at(-1) === undefined ? {} : { example: values.at(-1) };
  }
  const unique = new Map<string, unknown>();
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const serialized = stableStringify(value);
    if (Buffer.byteLength(serialized) <= (config.maxExampleBytes ?? 16_384)) {
      unique.set(serialized, JSON.parse(serialized));
    }
  }
  const selected = [...unique]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, config.maxExamples ?? 5);
  if (!selected.length) {
    return {};
  }
  return {
    examples: Object.fromEntries(selected.map(([, value], index) => [`sample_${index + 1}`, { value }])),
  };
};

const formExample = (sample: FormSample, schema: SchemaObject) => {
  const grouped = new Map<string, string[]>();
  for (const field of sample.fields) {
    // Binary file bytes and local filenames are not useful example values.
    if (!field.isBinary) {
      grouped.set(field.name, [...(grouped.get(field.name) ?? []), field.value]);
    }
  }
  return Object.fromEntries(
    [...grouped].map(([name, values]) => {
      const fieldSchema = schema.properties?.[name] as SchemaObject | undefined;
      return [name, coerceParameterExample(fieldSchema?.type === "array" ? values : values.at(-1), fieldSchema ?? {})];
    }),
  );
};

const buildBodyContentFromSamples = async (
  samples: BodySample[],
  details: { urlPath: string; method: string; suffix: "request" | "response" },
  config: InternalConfig,
): Promise<NonNullable<RequestBodyObject["content"]> | undefined> => {
  const contentStates = new Map<string, BodyContentState>();
  for (const sample of samples) {
    const mimeTypeValue = getMimeType(sample.postData, sample.headers, config);
    const text = getDecodedText(sample.postData);
    const hasFields = "params" in sample.postData && Boolean(sample.postData.params?.length);
    const bodyAllowed =
      details.suffix !== "response" ||
      (details.method.toLowerCase() !== "head" &&
        sample.status !== 204 &&
        sample.status !== 304 &&
        !(sample.status !== undefined && sample.status >= 100 && sample.status < 200));
    if (
      !bodyAllowed ||
      (details.suffix === "response" && text === "" && "size" in sample.postData && sample.postData.size === 0)
    ) {
      continue;
    }
    if (bodyAllowed && text === undefined && !hasFields && "size" in sample.postData && sample.postData.size > 0) {
      config.onDiagnostic?.({
        level: "warning",
        code: "body-missing",
        message: "A body was transferred but its contents were not captured.",
        source: sample.source,
        path: details.urlPath,
        method: details.method,
        status: sample.status,
        mimeType: mimeTypeValue,
      });
    }
    if (!mimeTypeValue) {
      continue;
    }
    const mimeType = parseMimeType(mimeTypeValue);
    const mimeEssence = mimeType.essence;
    const isBase64Encoded = "encoding" in sample.postData && sample.postData.encoding === "base64";
    const state =
      contentStates.get(mimeEssence) ??
      ({
        kind: "raw",
        jsonSamples: [],
        rawSamples: [],
        rawSchemas: [],
        formSamples: [],
        examples: [],
      } as BodyContentState);
    state.source = sample.source;
    state.status = sample.status;

    if (isFormLikeMimeType(mimeType)) {
      const fields = getFormFields(sample.postData);
      if (fields.length) {
        state.formSamples.push({ kind: "form", fields });
        state.kind = "form";
        contentStates.set(mimeEssence, state);
      } else if (!config.mimeTypes || config.mimeTypes.includes(mimeEssence)) {
        state.kind = "raw";
        state.schema = getEmptyMultipartFallbackSchema();
        contentStates.set(mimeEssence, state);
      }
      continue;
    }
    if (text === undefined) {
      continue;
    }
    const shouldParseAsJson = !mimeType.isXmlLike && (mimeType.isJsonLike || config.relaxedContentTypeJsonParse);
    if (shouldParseAsJson) {
      try {
        const data: unknown = JSON.parse(text);
        state.kind = "json";
        state.jsonSamples.push(data);
        state.examples.push(data);
        contentStates.set(mimeEssence, state);
        continue;
      } catch {
        if (mimeType.isJsonLike) {
          config.onDiagnostic?.({
            level: "warning",
            code: "schema-fallback",
            message: "Declared JSON could not be parsed; using a string schema.",
            source: sample.source,
            path: details.urlPath,
            method: details.method,
            status: sample.status,
            mimeType: mimeEssence,
          });
        }
      }
    }
    state.kind = "raw";
    state.schema = mimeType.isXmlLike ? { type: "string" } : getBaseSchemaFallback(mimeType, isBase64Encoded);
    state.rawSchemas.push(state.schema);
    state.rawSamples.push(text);
    state.examples.push(config.includeNonJsonExampleResponses ? text : undefined);
    contentStates.set(mimeEssence, state);
  }

  const content: NonNullable<RequestBodyObject["content"]> = {};
  for (const [mimeEssence, state] of contentStates) {
    if (state.jsonSamples.length) {
      let schema: SchemaObject;
      try {
        const inferred = await buildJsonSchema(
          state.jsonSamples.map((sample) => JSON.stringify(sample)),
          details.urlPath,
          details.method,
          details.suffix,
          config.openapiVersion ?? "3.0.0",
        );
        schema = structuredClone(inferred);
        if (config.validate || config.strict) {
          removeEmptyRequired(schema);
        }
        if (state.rawSchemas.length) {
          const rawSchemas = [...new Map(state.rawSchemas.map((raw) => [stableStringify(raw), raw])).values()];
          schema = { anyOf: [schema, ...rawSchemas] };
        }
        applyObservations(
          schema,
          [...state.jsonSamples, ...state.rawSamples],
          config.requiredness ?? "legacy",
          config.includeInferenceEvidence ?? false,
        );
      } catch {
        config.onDiagnostic?.({
          level: "error",
          code: "schema-inference-failed",
          message: "Schema inference failed for captured JSON.",
          source: state.source,
          path: details.urlPath,
          method: details.method,
          status: state.status,
          mimeType: mimeEssence,
        });
        schema = {};
      }
      content[mimeEssence] = { schema, ...getBodyExamples(state.examples, config) };
    } else if (state.formSamples.length) {
      const schema = mergeFormSamples(state.formSamples, config);
      if (schema) {
        content[mimeEssence] = {
          schema,
          // Legacy output has never included form examples.
          ...(config.examples === "multiple"
            ? getBodyExamples(
                state.formSamples.map((sample) => formExample(sample, schema)),
                config,
              )
            : {}),
        };
      }
    } else {
      content[mimeEssence] = { schema: state.schema ?? { type: "string" }, ...getBodyExamples(state.examples, config) };
    }
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
    required: config.requiredness !== "optional",
    content,
  };
};

export const buildResponseBodyFromSamples = async (
  responses: Array<Response & { source?: BodySample["source"] }>,
  details: { urlPath: string; method: string },
  config: InternalConfig,
): Promise<ResponseObject | undefined> => {
  const content = await buildBodyContentFromSamples(
    responses.map((response) => ({
      postData: response.content,
      headers: response.headers,
      source: response.source,
      status: response.status,
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

const blockedBracketRootsByOperation = new WeakMap<OperationObject, Set<string>>();

export const addQueryStringParams = (
  specMethod: OperationObject,
  harParams: QueryString[],
  config: Pick<InternalConfig, "inferParameterTypes" | "inferArrayParameters" | "parseBracketParameters" | "examples">,
) => {
  const parameters = (specMethod.parameters ??= []);
  const blockedRoots = blockedBracketRootsByOperation.get(specMethod) ?? new Set<string>();
  let observations = observeQueryParameters(
    harParams ?? [],
    config.inferParameterTypes,
    config.inferArrayParameters ?? true,
    config.parseBracketParameters ?? false,
    blockedRoots,
  );
  if (config.parseBracketParameters) {
    for (const parameter of parameters.slice()) {
      if (!("in" in parameter) || parameter.in !== "query") {
        continue;
      }
      const sameName = observations.find((item) => item.name === parameter.name);
      const hasLiteralBracket = observations.some((item) => item.name.startsWith(`${parameter.name}[`));
      const existingObject = parameter.style === "deepObject";
      const nextObject = sameName?.style === "deepObject";
      if ((existingObject && ((sameName && !nextObject) || hasLiteralBracket)) || (!existingObject && nextObject)) {
        blockedRoots.add(parameter.name);
        if (existingObject && parameter.schema && !("$ref" in parameter.schema)) {
          const previousExample = parameter.example as Record<string, unknown> | undefined;
          const restored = Object.entries(parameter.schema.properties ?? {}).map(
            ([name, schema]) =>
              ({
                in: "query",
                name: `${parameter.name}[${name}]`,
                description: `${parameter.name}[${name}]`,
                schema,
                ...(previousExample && Object.hasOwn(previousExample, name) ? { example: previousExample[name] } : {}),
              }) as ParameterObject,
          );
          parameters.splice(parameters.indexOf(parameter), 1, ...restored);
        }
      }
    }
    blockedBracketRootsByOperation.set(specMethod, blockedRoots);
    observations = observeQueryParameters(
      harParams ?? [],
      config.inferParameterTypes,
      config.inferArrayParameters ?? true,
      true,
      blockedRoots,
    );
    // A literal bracket spelling means this root could not be represented as
    // a deepObject. Keep that decision for subsequent samples as well.
    for (const observation of observations) {
      const root = /^([^[]+)\[/.exec(observation.name)?.[1];
      if (root) {
        blockedRoots.add(root);
      }
    }
  }
  for (const observation of observations) {
    const existing = parameters.find(
      (parameter) => "in" in parameter && parameter.in === "query" && parameter.name === observation.name,
    );
    if (existing && "schema" in existing) {
      existing.schema = mergeParameterSchemas(existing.schema as SchemaObject | undefined, observation.schema);
      if (config.examples !== "none") {
        existing.example = coerceParameterExample(observation.example, existing.schema as SchemaObject);
        existing.schema = { ...existing.schema, default: existing.example } as SchemaObject;
      }
      if (observation.style) {
        existing.style = observation.style;
        existing.explode = observation.explode;
      }
      continue;
    }
    parameters.push({
      schema: { ...observation.schema, ...(config.examples === "none" ? {} : { default: observation.example }) },
      in: "query",
      name: observation.name,
      description: observation.name,
      ...(config.examples === "none" ? {} : { example: observation.example }),
      ...(observation.style ? { style: observation.style, explode: observation.explode } : {}),
    });
  }
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
