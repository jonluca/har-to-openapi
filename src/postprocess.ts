import type { OpenApiSpec } from "@loopback/openapi-v3-types";
import { JSONPath } from "jsonpath-plus";
import type { HarToOpenAPIConfig, OpenApiOverlay, RedactionConfig } from "./types.js";

type ObjectNode = Record<string, any>;
const isObject = (value: unknown): value is ObjectNode =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const escapePointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const pointerTokens = (pointer: string): string[] => {
  if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) {
    throw new Error(`Invalid JSON Pointer: ${pointer}`);
  }
  return pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
};
const resolveLocalReference = (spec: ObjectNode, reference: string): unknown => {
  if (!reference.startsWith("#")) {
    return undefined;
  }
  try {
    let target: unknown = spec;
    for (const token of pointerTokens(decodeURIComponent(reference.slice(1)))) {
      if (target === null || typeof target !== "object" || !own(target, token)) {
        return undefined;
      }
      target = (target as ObjectNode)[token];
    }
    return target;
  } catch {
    return undefined;
  }
};
const resolveReferenceObject = (spec: ObjectNode, value: unknown): unknown => {
  const visited = new Set<object>();
  while (isObject(value) && typeof value.$ref === "string" && !visited.has(value)) {
    visited.add(value);
    const target = resolveLocalReference(spec, value.$ref);
    if (!isObject(target)) {
      break;
    }
    value = target;
  }
  return value;
};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    isObject(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, child[key]]),
        )
      : child,
  );

interface SchemaLocation {
  schema: ObjectNode;
  parent: ObjectNode | any[];
  key: string | number;
  pointer: string;
  hint: string;
  root: boolean;
  component?: string;
}
interface SampleContext {
  bodyPath: string[];
  force: boolean;
  pointers: boolean;
  cookieHeader?: boolean;
  schema?: boolean;
}
interface DocumentVisitors {
  schema?: (location: SchemaLocation) => void;
  samples?: (holder: ObjectNode, context: SampleContext) => void;
}
const schemaMaps = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const schemaSingles = [
  "items",
  "additionalProperties",
  "additionalItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"];

/** Visit schema positions, never arbitrary data keys named schema/example/default. */
const schemaChildren = (
  schema: ObjectNode,
  visit: (
    child: ObjectNode,
    parent: ObjectNode | any[],
    key: string | number,
    suffix: string,
    property?: string,
  ) => void,
) => {
  for (const keyword of schemaMaps) {
    if (isObject(schema[keyword])) {
      for (const [key, child] of Object.entries(schema[keyword])) {
        if (isObject(child)) {
          visit(
            child,
            schema[keyword],
            key,
            `/${keyword}/${escapePointer(key)}`,
            keyword === "properties" ? key : keyword === "patternProperties" ? "*" : undefined,
          );
        }
      }
    }
  }
  for (const keyword of schemaSingles) {
    if (isObject(schema[keyword])) {
      visit(
        schema[keyword],
        schema,
        keyword,
        `/${keyword}`,
        ["items", "additionalProperties", "unevaluatedProperties"].includes(keyword) ? "*" : undefined,
      );
    }
  }
  for (const keyword of schemaArrays) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((child: unknown, index: number) => {
        if (isObject(child)) {
          visit(
            child,
            schema[keyword],
            index,
            `/${keyword}/${index}`,
            keyword === "prefixItems" ? String(index) : undefined,
          );
        }
      });
    }
  }
};
const modelName = (hint: string) => {
  const words = hint
    .replace(/\{[^}]*\}/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return name || "Model";
};
const resourceName = (path: string) => {
  const part =
    path
      .split("/")
      .filter((item) => item && !item.startsWith("{"))
      .at(-1) || "Root";
  const singular = part.endsWith("ies")
    ? `${part.slice(0, -3)}y`
    : /[^s]s$/.test(part) && !part.endsWith("us")
      ? part.slice(0, -1)
      : part;
  return modelName(singular);
};

const visitDocument = (spec: ObjectNode, visitors: DocumentVisitors, redact?: RedactionConfig) => {
  const resolve = (value: unknown): unknown => resolveReferenceObject(spec, value);
  const headers = new Set(redact?.headers?.map((name) => name.toLowerCase()));
  const queries = new Set(redact?.queryParameters);
  const cookies = new Set(redact?.cookies);
  const visitSchema = (
    parent: ObjectNode,
    key: string,
    pointer: string,
    hint: string,
    context: SampleContext,
    component?: string,
  ) => {
    if (!isObject(parent[key])) {
      return;
    }
    const walk = (location: SchemaLocation, dataContext: SampleContext, stack: Set<object>) => {
      if (stack.has(location.schema)) {
        return;
      }
      const nextStack = new Set(stack).add(location.schema);
      visitors.schema?.(location);
      visitors.samples?.(location.schema, { ...dataContext, schema: true });
      // Redaction must also reach examples inside reusable schemas in the body's context.
      if (visitors.samples && typeof location.schema.$ref === "string") {
        const target = resolveLocalReference(spec, location.schema.$ref);
        if (isObject(target)) {
          walk({ ...location, schema: target }, dataContext, nextStack);
        }
      }
      schemaChildren(location.schema, (child, childParent, childKey, suffix, property) => {
        const bodyPath = property === undefined ? dataContext.bodyPath : [...dataContext.bodyPath, property];
        walk(
          {
            schema: child,
            parent: childParent,
            key: childKey,
            pointer: location.pointer + suffix,
            hint: property && property !== "*" ? modelName(property) : location.hint,
            root: location.root && (property === "*" || /^\/(allOf|anyOf|oneOf)\//.test(suffix)),
          },
          { ...dataContext, bodyPath },
          nextStack,
        );
      });
    };
    walk({ schema: parent[key], parent, key, pointer, hint, root: true, component }, context, new Set());
  };
  const bodyContext: SampleContext = { bodyPath: [], force: false, pointers: true };
  const visitContent = (content: unknown, pointer: string, hint: string, context = bodyContext) => {
    if (!isObject(content)) {
      return;
    }
    for (const [type, media] of Object.entries(content)) {
      if (!isObject(media)) {
        continue;
      }
      const mediaPointer = `${pointer}/${escapePointer(type)}`;
      visitors.samples?.(media, context);
      visitSchema(media, "schema", `${mediaPointer}/schema`, hint, context);
      if (isObject(media.encoding)) {
        for (const [field, encoding] of Object.entries(media.encoding)) {
          if (isObject(encoding)) {
            visitHeaders(encoding.headers, `${mediaPointer}/encoding/${escapePointer(field)}/headers`);
          }
        }
      }
    }
  };
  const visitParameter = (parameter: unknown, pointer: string, name?: string) => {
    parameter = resolve(parameter);
    if (!isObject(parameter)) {
      return;
    }
    const parameterName = name ?? parameter.name ?? "Parameter";
    const location = name === undefined ? parameter.in : "header";
    const force =
      location === "header"
        ? headers.has(parameterName.toLowerCase()) || headers.has("*")
        : location === "query"
          ? queries.has(parameterName) || queries.has("*")
          : location === "cookie"
            ? cookies.has(parameterName) || cookies.has("*")
            : false;
    const context = {
      bodyPath: [],
      force,
      pointers: false,
      cookieHeader: location === "header" && ["cookie", "set-cookie"].includes(parameterName.toLowerCase()),
    };
    visitors.samples?.(parameter, context);
    visitSchema(parameter, "schema", `${pointer}/schema`, modelName(parameterName), context);
    visitContent(parameter.content, `${pointer}/content`, modelName(parameterName), context);
  };
  const visitHeaders = (map: unknown, pointer: string) => {
    if (isObject(map)) {
      for (const [name, header] of Object.entries(map)) {
        visitParameter(header, `${pointer}/${escapePointer(name)}`, name);
      }
    }
  };
  const visitResponse = (response: unknown, pointer: string, hint: string) => {
    response = resolve(response);
    if (isObject(response)) {
      visitContent(response.content, `${pointer}/content`, hint);
      visitHeaders(response.headers, `${pointer}/headers`);
    }
  };
  const visitParameters = (parameters: unknown, pointer: string) => {
    if (Array.isArray(parameters)) {
      parameters.forEach((parameter, index) => visitParameter(parameter, `${pointer}/${index}`));
    }
  };
  const visitPath = (item: unknown, pointer: string, path: string) => {
    if (!isObject(item)) {
      return;
    }
    const hint = resourceName(path);
    visitParameters(item.parameters, `${pointer}/parameters`);
    for (const [method, operation] of Object.entries(item)) {
      if (!isObject(operation) || method.startsWith("x-") || ["servers", "parameters"].includes(method)) {
        continue;
      }
      const operationPointer = `${pointer}/${escapePointer(method)}`;
      visitParameters(operation.parameters, `${operationPointer}/parameters`);
      const requestBody = resolve(operation.requestBody);
      if (isObject(requestBody)) {
        visitContent(requestBody.content, `${operationPointer}/requestBody/content`, `${hint}Request`);
      }
      if (isObject(operation.responses)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          visitResponse(
            response,
            `${operationPointer}/responses/${escapePointer(status)}`,
            /^[45]/.test(status) ? "Error" : hint,
          );
        }
      }
      if (isObject(operation.callbacks)) {
        for (const [callbackName, callback] of Object.entries(operation.callbacks)) {
          visitCallback(callback, `${operationPointer}/callbacks/${escapePointer(callbackName)}`, callbackName);
        }
      }
    }
  };
  const visitCallback = (callback: unknown, pointer: string, name: string) => {
    if (isObject(callback)) {
      for (const [expression, callbackPath] of Object.entries(callback)) {
        if (expression !== "$ref" && !expression.startsWith("x-")) {
          visitPath(callbackPath, `${pointer}/${escapePointer(expression)}`, name);
        }
      }
    }
  };
  for (const field of ["paths", "webhooks"]) {
    if (isObject(spec[field])) {
      for (const [path, item] of Object.entries(spec[field])) {
        visitPath(item, `/${field}/${escapePointer(path)}`, path);
      }
    }
  }
  const components = spec.components;
  if (isObject(components)) {
    for (const [name, schema] of Object.entries(components.schemas ?? {})) {
      if (isObject(schema)) {
        visitSchema(
          components.schemas,
          name,
          `/components/schemas/${escapePointer(name)}`,
          name,
          { ...bodyContext, pointers: false },
          name,
        );
      }
    }
    for (const [name, parameter] of Object.entries(components.parameters ?? {})) {
      visitParameter(parameter, `/components/parameters/${escapePointer(name)}`);
    }
    visitHeaders(components.headers, "/components/headers");
    for (const [name, response] of Object.entries(components.responses ?? {})) {
      visitResponse(response, `/components/responses/${escapePointer(name)}`, name);
    }
    for (const [name, body] of Object.entries(components.requestBodies ?? {})) {
      const requestBody = resolve(body);
      if (isObject(requestBody)) {
        visitContent(requestBody.content, `/components/requestBodies/${escapePointer(name)}/content`, name);
      }
    }
    for (const [name, item] of Object.entries(components.pathItems ?? {})) {
      visitPath(item, `/components/pathItems/${escapePointer(name)}`, name);
    }
    for (const [name, callback] of Object.entries(components.callbacks ?? {})) {
      visitCallback(callback, `/components/callbacks/${escapePointer(name)}`, name);
    }
  }
};

/** Visit each object-valued OpenAPI/JSON Schema position without inspecting example data. */
export const visitSchemas = (spec: OpenApiSpec, visitor: (schema: ObjectNode, pointer: string) => void): void => {
  visitDocument(spec, { schema: ({ schema, pointer }) => visitor(schema, pointer) });
};

const withoutObservations = (schema: ObjectNode, omitTitles = false): ObjectNode => {
  const copy = { ...schema };
  delete copy["x-har-observations"];
  if (omitTitles) {
    delete copy.title;
  }
  schemaChildren(schema, (_child, _parent, _key, suffix) => {
    const [keyword] = pointerTokens(suffix);
    copy[keyword] = structuredClone(schema[keyword]);
  });
  schemaChildren(copy, (child, parent, key) => {
    (parent as ObjectNode)[key] = withoutObservations(child, omitTitles);
  });
  if (
    Object.keys(copy).length === 1 &&
    Array.isArray(copy.allOf) &&
    copy.allOf.length === 1 &&
    isObject(copy.allOf[0]) &&
    Object.keys(copy.allOf[0]).length === 1 &&
    typeof copy.allOf[0].$ref === "string"
  ) {
    return copy.allOf[0];
  }
  return copy;
};
const schemaFingerprint = (schema: ObjectNode): string => canonical(withoutObservations(schema, true));
const schemaEvidence = (schema: ObjectNode): ObjectNode | undefined => {
  const nested: ObjectNode = {};
  const walk = (node: ObjectNode, pointer: string) => {
    if (pointer && own(node, "x-har-observations")) {
      nested[pointer] = structuredClone(node["x-har-observations"]);
    }
    schemaChildren(node, (child, _parent, _key, suffix) => walk(child, pointer + suffix));
  };
  walk(schema, "");
  const root = schema["x-har-observations"];
  if (!isObject(root) && !Object.keys(nested).length) {
    return undefined;
  }
  return {
    ...(isObject(root) ? structuredClone(root) : {}),
    ...(Object.keys(nested).length ? { schemas: nested } : {}),
  };
};
const extractSchemas = (spec: ObjectNode, config: HarToOpenAPIConfig) => {
  if (!config.reusableSchemas && !config.schemaNames) {
    return;
  }
  const locations: SchemaLocation[] = [];
  visitDocument(spec, { schema: (location) => locations.push(location) });
  const byPointer = new Map(locations.map((location) => [location.pointer, location]));
  const names = config.schemaNames ?? {};
  for (const [pointer, name] of Object.entries(names)) {
    pointerTokens(pointer);
    if (!byPointer.has(pointer) || byPointer.get(pointer)?.schema.$ref) {
      throw new Error(`schemaNames target must identify an inline schema: ${pointer}`);
    }
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    ) {
      throw new Error(`Invalid component schema name: ${name}`);
    }
  }
  const evidence = new Map(locations.map((location) => [location, schemaEvidence(location.schema)]));
  const fingerprints = new Map(locations.map((location) => [location, schemaFingerprint(location.schema)]));
  const counts = new Map<string, number>();
  for (const fingerprint of fingerprints.values()) {
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  const assigned = new Map<string, string>();
  const byShape = new Map<string, string>();
  const components = spec.components?.schemas ?? {};
  // Reserve existing and explicitly requested names before allocating automatic names.
  for (const location of locations
    .filter((item) => item.component || own(names, item.pointer))
    .sort((a, b) => a.pointer.localeCompare(b.pointer))) {
    const name = names[location.pointer] ?? location.component!;
    const fingerprint = fingerprints.get(location)!;
    if (assigned.has(name) && assigned.get(name) !== fingerprint) {
      throw new Error(`Conflicting schemas assigned to component name '${name}'`);
    }
    assigned.set(name, fingerprint);
    if (!byShape.has(fingerprint)) {
      byShape.set(fingerprint, name);
    }
  }
  const chosen = new Map<SchemaLocation, string>();
  for (const location of [...locations].sort((a, b) => a.pointer.localeCompare(b.pointer))) {
    const fingerprint = fingerprints.get(location)!;
    const objectSchema = location.schema.type === "object" || isObject(location.schema.properties);
    const shouldExtract =
      own(names, location.pointer) ||
      (config.reusableSchemas &&
        objectSchema &&
        !location.schema.$ref &&
        (location.root || (counts.get(fingerprint) ?? 0) > 1));
    if (location.component || !shouldExtract) {
      continue;
    }
    let name = names[location.pointer] ?? byShape.get(fingerprint);
    if (!name) {
      const base = modelName(location.hint);
      name = base;
      let index = 2;
      while (assigned.has(name) && assigned.get(name) !== fingerprint) {
        name = `${base}${index++}`;
      }
    }
    assigned.set(name, fingerprint);
    if (!byShape.has(fingerprint)) {
      byShape.set(fingerprint, name);
    }
    chosen.set(location, name);
  }
  for (const [location, name] of [...chosen].sort(
    ([a], [b]) => b.pointer.split("/").length - a.pointer.split("/").length,
  )) {
    if (!own(components, name)) {
      components[name] = { ...withoutObservations(location.schema), title: name };
    }
    const reference = { $ref: `#/components/schemas/${escapePointer(name)}` };
    const observations = evidence.get(location);
    (location.parent as ObjectNode)[location.key] = observations
      ? { allOf: [reference], "x-har-observations": observations }
      : reference;
  }
  if (chosen.size) {
    spec.components ??= {};
    spec.components.schemas = components;
  }
};

const assertSafeUpdate = (value: unknown) => {
  if (Array.isArray(value)) {
    value.forEach(assertSafeUpdate);
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error(`Unsafe overlay property: ${key}`);
      }
      assertSafeUpdate(child);
    }
  }
};
const mergeOverlayObject = (target: ObjectNode, update: ObjectNode, capturedConstraints?: CapturedConstraints) => {
  for (const [key, value] of Object.entries(update)) {
    if (key === "enum" || key === "const") {
      capturedConstraints?.get(target)?.delete(key);
    }
    if (isObject(value) && own(target, key) && isObject(target[key])) {
      mergeOverlayObject(target[key], value, capturedConstraints);
    } else {
      target[key] = structuredClone(value);
    }
  }
};
const applyOverlay = (spec: ObjectNode, overlay?: OpenApiOverlay, capturedConstraints?: CapturedConstraints) => {
  if (!overlay) {
    return;
  }
  if (
    overlay.overlay !== "1.0.0" ||
    !isObject(overlay.info) ||
    typeof overlay.info.title !== "string" ||
    typeof overlay.info.version !== "string" ||
    !Array.isArray(overlay.actions) ||
    !overlay.actions.length
  ) {
    throw new Error("An Overlay 1.0.0 document requires info.title, info.version, and at least one action");
  }
  for (const [index, action] of overlay.actions.entries()) {
    if (
      !isObject(action) ||
      typeof action.target !== "string" ||
      !action.target.startsWith("$") ||
      (action.remove !== undefined && typeof action.remove !== "boolean") ||
      (!action.remove && !own(action, "update"))
    ) {
      throw new Error(`Invalid overlay action ${index + 1}`);
    }
    assertSafeUpdate(action.update);
    let matches: Array<{
      value: unknown;
      parent: ObjectNode | any[] | null;
      parentProperty: string | number | null;
      pointer: string;
    }>;
    try {
      matches = JSONPath({ path: action.target, json: spec, resultType: "all", eval: "safe", wrap: true });
    } catch (error) {
      throw new Error(
        `Invalid overlay target '${action.target}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!matches.length) {
      throw new Error(`Overlay target matched no values: ${action.target}`);
    }
    const unique = [...new Map(matches.map((match) => [match.pointer, match])).values()];
    for (const match of unique) {
      if (pointerTokens(match.pointer).some((token) => ["__proto__", "constructor", "prototype"].includes(token))) {
        throw new Error(`Unsafe overlay target: ${action.target}`);
      }
      if (!isObject(match.value) && !Array.isArray(match.value)) {
        throw new Error(`Overlay target must select objects or arrays: ${action.target}`);
      }
      if (action.remove && !match.parent) {
        throw new Error("Overlay cannot remove the document root");
      }
      if (!action.remove && isObject(match.value) && !isObject(action.update)) {
        throw new Error(`Overlay update must be an object for target: ${action.target}`);
      }
    }
    if (action.remove) {
      // Descending indices keep all originally selected array members removable.
      unique.sort(
        (a, b) =>
          b.pointer.split("/").length - a.pointer.split("/").length ||
          (a.parent === b.parent && Array.isArray(a.parent) ? Number(b.parentProperty) - Number(a.parentProperty) : 0),
      );
      for (const match of unique) {
        if (Array.isArray(match.parent)) {
          match.parent.splice(Number(match.parentProperty), 1);
        } else if (match.parent && match.parentProperty !== null) {
          delete match.parent[match.parentProperty];
        }
      }
    } else {
      for (const match of unique) {
        if (Array.isArray(match.value)) {
          match.value.push(structuredClone(action.update));
        } else {
          mergeOverlayObject(match.value as ObjectNode, action.update as ObjectNode, capturedConstraints);
        }
      }
    }
  }
};

type CapturedConstraints = WeakMap<ObjectNode, Map<string, string>>;
const applyExamplePolicy = (spec: ObjectNode, config: HarToOpenAPIConfig, capturedConstraints: CapturedConstraints) => {
  const mode = config.examples ?? "single";
  const maxCount = config.maxExamples ?? 5;
  const maxBytes = config.maxExampleBytes ?? (mode === "multiple" ? 16384 : Number.POSITIVE_INFINITY);
  const redact = config.redact;
  const names = new Set(redact?.bodyProperties?.map((name) => name.toLowerCase()));
  const pointers = (redact?.bodyPointers ?? []).map(pointerTokens);
  const replacement = redact?.replacement ?? "[REDACTED]";
  const isTarget = (path: string[], enabled: boolean) =>
    names.has("*") ||
    (path.length > 0 && names.has(path.at(-1)!.toLowerCase())) ||
    (enabled &&
      pointers.some(
        (tokens) =>
          tokens.length === path.length &&
          tokens.every((token, index) => token === "*" || path[index] === "*" || token === path[index]),
      ));
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      return replacement;
    }
    if (typeof value === "number") {
      return 0;
    }
    if (typeof value === "boolean") {
      return false;
    }
    if (Array.isArray(value)) {
      return value.map(replace);
    }
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    }
    return value;
  };
  const sanitize = (value: unknown, context: SampleContext): unknown => {
    if (
      context.force ||
      context.bodyPath.some((_token, index) => isTarget(context.bodyPath.slice(0, index + 1), context.pointers)) ||
      isTarget([], context.pointers)
    ) {
      return replace(value);
    }
    if (Array.isArray(value)) {
      return value.map((child, index) =>
        sanitize(child, { ...context, bodyPath: [...context.bodyPath, String(index)] }),
      );
    }
    if (isObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          sanitize(child, { ...context, bodyPath: [...context.bodyPath, key] }),
        ]),
      );
    }
    if (context.cookieHeader && typeof value === "string" && redact?.cookies?.length) {
      return value
        .split(";")
        .map((part) => {
          const equals = part.indexOf("=");
          if (
            equals < 0 ||
            (!redact.cookies!.includes("*") && !redact.cookies!.includes(part.slice(0, equals).trim()))
          ) {
            return part;
          }
          return `${part.slice(0, equals + 1)}${replacement}`;
        })
        .join(";");
    }
    return value;
  };
  const fits = (value: unknown) => {
    const json = JSON.stringify(value);
    return json !== undefined && Buffer.byteLength(json, "utf8") <= maxBytes;
  };
  const processHolder = (holder: ObjectNode, context: SampleContext) => {
    if (context.schema) {
      // Generated literal constraints can retain captured secrets even after examples
      // are removed. Explicit overlay constraints remain authoritative.
      const captured = capturedConstraints.get(holder);
      for (const keyword of ["enum", "const"]) {
        if (
          captured?.has(keyword) &&
          own(holder, keyword) &&
          captured.get(keyword) === canonical(holder[keyword]) &&
          (mode === "none" ||
            canonical(
              keyword === "enum" && Array.isArray(holder[keyword])
                ? holder[keyword].map((value: unknown) => sanitize(value, context))
                : sanitize(holder[keyword], context),
            ) !== canonical(holder[keyword]))
        ) {
          delete holder[keyword];
        }
      }
    }
    if (mode === "none") {
      delete holder.example;
      delete holder.examples;
      delete holder.default;
      return;
    }
    for (const key of ["example", "default"]) {
      if (own(holder, key)) {
        holder[key] = sanitize(holder[key], context);
        if (!fits(holder[key])) {
          delete holder[key];
        }
      }
    }
    if (Array.isArray(holder.examples)) {
      const seen = new Set<string>();
      holder.examples = holder.examples
        .map((value: unknown) => sanitize(value, context))
        .filter((value: unknown) => {
          const signature = canonical(value);
          if (!fits(value) || seen.has(signature) || seen.size >= (mode === "single" ? 1 : maxCount)) {
            return false;
          }
          seen.add(signature);
          return true;
        });
      if (!holder.examples.length) {
        delete holder.examples;
      }
      return;
    }
    if (context.schema) {
      return;
    }
    if (mode === "single" && own(holder, "example")) {
      delete holder.examples;
      return;
    }
    if (mode === "multiple" && own(holder, "example")) {
      const existing: ObjectNode = isObject(holder.examples) ? holder.examples : {};
      let key = "example1";
      let index = 2;
      while (own(existing, key)) {
        key = `example${index++}`;
      }
      holder.examples = { ...existing, [key]: { value: holder.example } };
      delete holder.example;
    }
    if (isObject(holder.examples)) {
      const examples: ObjectNode = {};
      const seen = new Set<string>();
      for (const [key, example] of Object.entries(holder.examples)) {
        if (!isObject(example)) {
          continue;
        }
        const valueHolder = resolveReferenceObject(spec, example) as ObjectNode;
        if (own(valueHolder, "value")) {
          valueHolder.value = sanitize(valueHolder.value, context);
          const signature = canonical(valueHolder.value);
          if (!fits(valueHolder.value) || seen.has(signature)) {
            continue;
          }
          seen.add(signature);
        }
        if (Object.keys(examples).length < maxCount) {
          examples[key] = example;
        }
      }
      if (mode === "single") {
        const first = Object.values(examples).find((example) => own(example, "value"));
        if (first) {
          holder.example = first.value;
          delete holder.examples;
        } else if (Object.keys(examples).length) {
          holder.examples = Object.fromEntries(Object.entries(examples).slice(0, 1));
          delete holder.example;
        } else {
          delete holder.examples;
        }
      } else if (Object.keys(examples).length) {
        holder.examples = examples;
        delete holder.example;
      } else {
        delete holder.examples;
      }
    }
  };
  visitDocument(spec, { samples: processHolder }, redact);
  if (isObject(spec.components?.examples)) {
    if (mode === "none") {
      delete spec.components.examples;
    } else {
      for (const example of Object.values(spec.components.examples)) {
        if (isObject(example) && own(example, "value")) {
          example.value = sanitize(example.value, { bodyPath: [], force: false, pointers: true });
          if (!fits(example.value)) {
            delete example.value;
          }
        }
      }
    }
  }
};

/** Mutates and returns the document: extraction, persistent overlays, then example privacy/limits. */
export const postprocessSpec = (spec: OpenApiSpec, config: HarToOpenAPIConfig): OpenApiSpec => {
  for (const name of ["maxExamples", "maxExampleBytes"] as const) {
    if (config[name] !== undefined && (!Number.isInteger(config[name]) || config[name]! < 1)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (config.examples !== undefined && !["single", "multiple", "none"].includes(config.examples)) {
    throw new Error("examples must be single, multiple, or none");
  }
  extractSchemas(spec, config);
  const capturedConstraints: CapturedConstraints = new WeakMap();
  visitSchemas(spec, (schema) => {
    const constraints = new Map<string, string>();
    for (const keyword of ["enum", "const"]) {
      if (own(schema, keyword)) {
        constraints.set(keyword, canonical(schema[keyword]));
      }
    }
    if (constraints.size) {
      capturedConstraints.set(schema, constraints);
    }
  });
  applyOverlay(spec, config.overlay, capturedConstraints);
  applyExamplePolicy(spec, config, capturedConstraints);
  return spec;
};
