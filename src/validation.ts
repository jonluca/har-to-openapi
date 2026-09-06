import type { OpenApiSpec, OperationObject, ParameterObject } from "@loopback/openapi-v3-types";
import AjvDraft04Module from "ajv-draft-04";
import type { Options, ValidateFunction } from "ajv";
import schema30 from "@seriousme/openapi-schema-validator/schemas/v3.0/schema.json" with { type: "json" };
import schema31 from "@seriousme/openapi-schema-validator/schemas/v3.1/schema.json" with { type: "json" };
import { Ajv2020 } from "ajv/dist/2020.js";
import { visitSchemas } from "./postprocess.js";
import type { ConversionDiagnostic } from "./types.js";
import { isStandardMethod } from "./utils/methods.js";

interface MetaValidator {
  compile: (schema: object) => ValidateFunction;
}
const AjvDraft04 = AjvDraft04Module as unknown as new (options: Options) => MetaValidator;
const validators = new Map<string, ValidateFunction>();
const documentValidator = (version: string) => {
  const dialect = version.startsWith("3.1.") ? "3.1" : "3.0";
  let validate = validators.get(dialect);
  if (!validate) {
    const options = { strict: false, allErrors: true, validateFormats: false } as const;
    const ajv = dialect === "3.1" ? new Ajv2020(options) : new AjvDraft04(options);
    validate = ajv.compile(dialect === "3.1" ? schema31 : schema30);
    validators.set(dialect, validate);
  }
  return validate;
};

const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** References are interpreted only at OpenAPI/JSON Schema positions, never inside payload data. */
const documentReferences = (spec: OpenApiSpec) => {
  const refs: Array<{ ref: unknown; pointer: string; schema: boolean }> = [];
  const esc = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
  const ref = (node: unknown, pointer: string, schema = false) => {
    if (isObject(node) && Object.hasOwn(node, "$ref")) {
      refs.push({ ref: node.$ref, pointer, schema });
    }
  };
  const map = (node: unknown, pointer: string, visit: (value: any, pointer: string) => void) => {
    if (isObject(node)) {
      for (const [name, value] of Object.entries(node)) {
        visit(value, `${pointer}/${esc(name)}`);
      }
    }
  };
  const content = (node: unknown, pointer: string) =>
    map(node, pointer, (media, pointer) => {
      if (!isObject(media)) {
        return;
      }
      map(media.examples, `${pointer}/examples`, ref);
      map(media.encoding, `${pointer}/encoding`, (encoding, pointer) => {
        if (isObject(encoding)) {
          map(encoding.headers, `${pointer}/headers`, parameter);
        }
      });
    });
  const parameter = (node: unknown, pointer: string) => {
    ref(node, pointer);
    if (isObject(node)) {
      map(node.examples, `${pointer}/examples`, ref);
      content(node.content, `${pointer}/content`);
    }
  };
  const body = (node: unknown, pointer: string) => {
    ref(node, pointer);
    if (isObject(node)) {
      content(node.content, `${pointer}/content`);
    }
  };
  const response = (node: unknown, pointer: string) => {
    body(node, pointer);
    if (isObject(node)) {
      map(node.headers, `${pointer}/headers`, parameter);
      map(node.links, `${pointer}/links`, ref);
    }
  };
  const parameters = (node: unknown, pointer: string) => {
    if (Array.isArray(node)) {
      node.forEach((value, index) => parameter(value, `${pointer}/${index}`));
    }
  };
  const path = (node: unknown, pointer: string) => {
    ref(node, pointer);
    if (!isObject(node)) {
      return;
    }
    parameters(node.parameters, `${pointer}/parameters`);
    for (const [method, operation] of Object.entries(node)) {
      if (!isStandardMethod(method) || !isObject(operation)) {
        continue;
      }
      const location = `${pointer}/${method}`;
      parameters(operation.parameters, `${location}/parameters`);
      body(operation.requestBody, `${location}/requestBody`);
      map(operation.responses, `${location}/responses`, response);
      map(operation.callbacks, `${location}/callbacks`, callback);
    }
  };
  const callback = (node: unknown, pointer: string) => {
    ref(node, pointer);
    if (isObject(node)) {
      for (const [expression, value] of Object.entries(node)) {
        if (expression !== "$ref" && !expression.startsWith("x-")) {
          path(value, `${pointer}/${esc(expression)}`);
        }
      }
    }
  };
  map(spec.paths, "/paths", path);
  map((spec as Record<string, unknown>).webhooks, "/webhooks", path);
  const components = spec.components;
  if (components) {
    for (const [key, visitor] of Object.entries({
      parameters: parameter,
      headers: parameter,
      requestBodies: body,
      responses: response,
      examples: ref,
      links: ref,
      securitySchemes: ref,
      callbacks: callback,
      pathItems: path,
    })) {
      map((components as Record<string, unknown>)[key], `/components/${key}`, visitor);
    }
  }
  visitSchemas(spec, (schema, pointer) => ref(schema, pointer, true));
  return refs;
};

export const validateSpec = async (spec: OpenApiSpec): Promise<ConversionDiagnostic[]> => {
  const diagnostics: ConversionDiagnostic[] = [];
  const error = (message: string, path?: string, method?: string) => {
    diagnostics.push({
      level: "error",
      code: "validation-failed",
      message,
      ...(path ? { path } : {}),
      ...(method ? { method } : {}),
    });
  };
  if (typeof spec.openapi !== "string") {
    error("OpenAPI version must be a string.");
    return diagnostics;
  }
  try {
    // Validate the serialized representation, which omits undefined optional properties.
    const validate = documentValidator(spec.openapi);
    if (!validate(JSON.parse(JSON.stringify(spec)))) {
      for (const issue of validate.errors ?? []) {
        error(`OpenAPI ${issue.instancePath || "/"}: ${issue.message ?? issue.keyword}.`);
      }
    }
  } catch {
    error("OpenAPI document could not be validated.");
  }
  if (diagnostics.length) {
    return diagnostics;
  }
  if (spec.openapi.startsWith("3.1.")) {
    // The OAS 3.1 document meta-schema intentionally leaves Schema Objects unchecked.
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    visitSchemas(spec, (schema, pointer) => {
      try {
        if (!ajv.validateSchema(schema)) {
          for (const issue of ajv.errors ?? []) {
            error(`JSON Schema ${pointer}${issue.instancePath}: ${issue.message ?? issue.keyword}.`);
          }
        }
      } catch {
        error(`JSON Schema ${pointer} uses an unsupported or invalid dialect.`);
      }
    });
  }
  const anchors = new Set<string>();
  visitSchemas(spec, (schema) => {
    if (typeof schema.$anchor === "string") {
      anchors.add(`#${schema.$anchor}`);
    }
  });
  for (const reference of documentReferences(spec)) {
    if (typeof reference.ref !== "string") {
      continue;
    } // Meta-schema reports malformed reference objects.
    if (!reference.ref.startsWith("#")) {
      diagnostics.push({
        level: "warning",
        code: "external-reference",
        message: `External reference at ${reference.pointer} was not resolved; validation uses the supplied document only.`,
      });
      continue;
    }
    if (reference.ref === "#" || anchors.has(reference.ref)) {
      continue;
    }
    let target: unknown = spec;
    try {
      if (!reference.ref.startsWith("#/")) {
        throw new Error("Missing anchor");
      }
      for (const token of decodeURIComponent(reference.ref.slice(2)).split("/")) {
        const name = token.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || typeof target !== "object" || !Object.hasOwn(target, name)) {
          throw new Error("Missing target");
        }
        target = (target as Record<string, unknown>)[name];
      }
      if (!isObject(target) && !(reference.schema && spec.openapi.startsWith("3.1.") && typeof target === "boolean")) {
        error(
          `Local reference at ${reference.pointer} must target an object${reference.schema && spec.openapi.startsWith("3.1.") ? " or boolean schema" : ""}.`,
        );
      }
    } catch {
      error(`Unresolved local reference at ${reference.pointer}.`);
    }
  }
  // The document meta-schema does not enforce operationId uniqueness or template bindings.
  const operationIds = new Set<string>();
  const resolveParameter = (value: unknown): ParameterObject | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const ref = (value as { $ref?: string }).$ref;
    if (!ref) {
      return value as ParameterObject;
    }
    if (typeof ref !== "string" || !ref.startsWith("#/")) {
      return undefined;
    }
    let current: unknown = spec;
    try {
      for (const token of decodeURIComponent(ref.slice(2)).split("/")) {
        const name = token.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!current || typeof current !== "object" || !Object.hasOwn(current, name)) {
          return undefined;
        }
        current = (current as Record<string, unknown>)[name];
      }
    } catch {
      return undefined;
    }
    return current && typeof current === "object" && !("$ref" in current) ? (current as ParameterObject) : undefined;
  };
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const templates = Array.from(path.matchAll(/\{([^{}]+)\}/g), (match) => match[1]);
    for (const [method, value] of Object.entries(item)) {
      if (!isStandardMethod(method) || !value || typeof value !== "object" || !("responses" in value)) {
        continue;
      }
      const operation = value as OperationObject;
      if (typeof operation.operationId === "string") {
        if (operationIds.has(operation.operationId)) {
          error("operationId must be unique within the document.", path, method);
        }
        operationIds.add(operation.operationId);
      }
      const parameters = [
        ...(Array.isArray(item.parameters) ? item.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ]
        .map(resolveParameter)
        .filter((value): value is ParameterObject => Boolean(value));
      for (const name of templates) {
        if (!parameters.some((p) => p.in === "path" && p.name === name && p.required === true)) {
          error(`Path template {${name}} needs a required path parameter.`, path, method);
        }
      }
      for (const parameter of parameters) {
        if (parameter.in === "path" && !templates.includes(parameter.name)) {
          error(`Path parameter ${parameter.name} has no matching template.`, path, method);
        }
      }
    }
  }
  return diagnostics;
};
