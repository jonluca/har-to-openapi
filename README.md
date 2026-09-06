# HAR to OpenAPI

[![npm Version](https://img.shields.io/npm/v/har-to-openapi.svg)](https://www.npmjs.com/package/har-to-openapi) [![License](https://img.shields.io/npm/l/har-to-openapi.svg)](https://www.npmjs.com/package/har-to-openapi)

Convert a HAR file to an OpenAPI spec

# Introduction

_This library is loosely based on [har2openapi](https://github.com/dcarr178/har2openapi), but cleaned up and changed for usage in a more programmatic fashion_

# Getting Started

Requires Node.js 22.19.0 or newer.

```
pnpm add har-to-openapi
```

or

```
npm i --save har-to-openapi
```

# Usage

```typescript
import { generateSpec } from "har-to-openapi";

// read a har file from wherever you want - in this example its just a root json object
// const har = await fs.readFile("my.har");

const har = {
  log: {
    entries: [
      {
        index: 0,
        request: {
          method: "CUSTOM",
          url: "http://test.loadimpact.com/login",
          headers: [
            {
              name: "Content-Type",
              value: "application/x-www-form-urlencoded",
            },
          ],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            text: "foo0=bar0&foo1=bar1",
            params: [
              {
                name: "foo0",
                value: "bar0",
              },
            ],
          },
        },
      },
    ],
  },
};

const openapi = await generateSpec(har, { relaxedMethods: true });
const { spec, yamlSpec } = openapi;
// spec = { ... } openapi spec schema document
// yamlSpec = string, "info: ..."
```

## CLI

The CLI accepts one or more captures. Multiple inputs contribute observations to the same operations and schemas.

```bash
bunx har-to-openapi capture.har > openapi.yaml
bunx har-to-openapi capture.har --format json --output openapi.json
bunx har-to-openapi captures/*.har --reusable-schemas --output openapi.yaml
bunx har-to-openapi login.har checkout.har --overlay customizations.yaml --report conversion.json
bunx har-to-openapi test/data/base-path.har --multi-spec --output-dir generated
bunx har-to-openapi test/data/base-path.har --multi-spec --include-domains example.com
cat capture.har | bunx har-to-openapi --config har-to-openapi.config.yaml
cat newest.har | bunx har-to-openapi previous.har - --examples multiple --max-examples 3
```

Shell-expanded globs such as `captures/*.har` work as multiple file paths; leave the glob unquoted. Use `-` at most once to mix stdin with files. Without input paths, piped stdin is used automatically. `--multi-spec` writes one document per domain; `--output-dir` controls those filenames. Without `--multi-spec`, the CLI returns the first generated domain's document, matching `generateSpec`. Use `--force-all-requests-in-same-spec` to combine all domains into one document.

The CLI supports common boolean and list options as flags, and JSON-serializable configuration through `--config`. Config and overlay files can be JSON or YAML. CLI flags override config values; `--overlay` overrides an overlay embedded in the config. Run `har-to-openapi --help` for the full flag list.

## Combining captures and keeping customizations

Both library functions accept a single HAR or an array of HAR objects. Existing single-HAR callers keep working.

```typescript
import { generateSpec, generateSpecsWithReport } from "har-to-openapi";

const { spec } = await generateSpec([loginCapture, checkoutCapture], {
  reusableSchemas: true,
  examples: "multiple",
  maxExamples: 3,
  requiredness: "observed",
  includeInferenceEvidence: true,
});

const { specs, report } = await generateSpecsWithReport([loginCapture, checkoutCapture], {
  sourceNames: ["login.har", "checkout.har"],
});
```

Enable `reusableSchemas` to extract object schemas into `components.schemas` and use `$ref` references. Structurally identical schemas share a component. Use `schemaNames` to give selected schemas stable names; keys are JSON Pointers to inline schemas before extraction. A name also enables extraction for that schema even when `reusableSchemas` is false.

```yaml
# har-to-openapi.config.yaml
reusableSchemas: true
schemaNames:
  /paths/~1users/get/responses/200/content/application~1json/schema: Users
examples: multiple
maxExamples: 5
maxExampleBytes: 16384
redact:
  headers: [Authorization, X-API-Key]
  queryParameters: [access_token]
  cookies: [session]
  bodyProperties: [password, token]
  bodyPointers: [/users/*/email]
  replacement: "[REDACTED]"
requiredness: observed
includeInferenceEvidence: true
inferArrayParameters: true
parseBracketParameters: true
```

An OpenAPI Overlay 1.0 file keeps operation names, descriptions, and schema corrections separate from generated output. Apply it on every run with `--overlay customizations.yaml`, or provide the object as `config.overlay`. Actions run in order after component extraction, so they can customize named components as well as operations.

```yaml
# customizations.yaml
overlay: 1.0.0
info:
  title: API documentation customizations
  version: 1.0.0
actions:
  - target: $.paths['/users'].get
    update:
      operationId: listUsers
      summary: List users visible to the current account
  - target: $.components.schemas.Users
    update:
      description: A response observed from the users endpoint
```

Targets use JSONPath and can include wildcards or filters. Object updates merge recursively; array-valued properties in an object update replace the existing array. An update targeting an array directly appends one entry. Use `remove: true` to remove selected values. Targets must match existing objects or arrays; unmatched or unsupported targets produce diagnostics rather than silently discarding a customization.

## Examples and redaction

`--examples single` keeps the last observed example at each location, without a size limit unless `--max-example-bytes` is explicitly set. `--examples multiple` retains distinct captured media-type examples, bounded by `--max-examples` (default 5) and `--max-example-bytes` (default 16,384 UTF-8 JSON bytes per example). Oversized examples are omitted. `--examples none` omits examples, captured schema defaults, and generated enum/const values while keeping inferred types and structure. Explicit enum/const constraints added or changed by an overlay are retained.

Configure `redact` in JSON or YAML to mask captured values before sharing the generated document. Header and body-property names match case-insensitively; query and cookie names match exactly. Body pointers are relative to an example and support `*` for any property or array index. String values use `replacement` (default `[REDACTED]`); numeric and boolean values become `0` and `false` so redaction preserves inferred types. Redaction and example controls also apply after overlays.

## Parameter and requiredness inference

Repeated query and form fields within one request, such as `?tag=a&tag=b`, become arrays by default. Disable this with `--no-infer-array-parameters`. Different scalar values observed across separate requests do not by themselves imply an array. `--parse-bracket-parameters` additionally handles one-level query objects such as `filter[name]=Ada` using `deepObject` serialization, and recognizes bracket arrays even with a single `tags[]=a` value. Array parameter names retain `[]` so generated clients reproduce the captured query syntax. This option is disabled by default. Nested, numeric-index, mixed scalar/object, and form bracket names stay literal because their serialization is ambiguous.

Choose a policy with `--requiredness`:

- `legacy` (default): preserve existing requiredness behavior, including optional inferred JSON properties and required generated request bodies.
- `optional`: leave inferred body properties and request bodies optional. Path parameters remain required by OpenAPI.
- `observed`: mark fields or bodies required when they appear in every relevant captured sample.

`--include-inference-evidence` adds `x-har-observations` extensions with sample counts and field-presence evidence, including `presentCount` and `presenceRatio` for body fields. Extracted components keep evidence on each usage's `allOf` wrapper so shared models retain separate observations; nested schema evidence appears in `x-har-observations.schemas`, keyed by schema-relative JSON Pointer. Observations describe finite captures; presence in every capture does not establish an API contract. Confirm requirements with the API owner and record corrections in an overlay.

## Conversion reports and validation

```bash
har-to-openapi captures/*.har --validate --report conversion.json --output openapi.yaml
har-to-openapi capture.har --strict --report - > openapi.yaml
```

Reports include input, entry, operation, and output counts plus diagnostics for filtering, missing bodies, parse failures, schema fallbacks, customization problems, and validation. Entry diagnostics identify their source filename and zero-based input/entry indices when available. If a capture cannot be read or parsed as JSON, conversion stops before processing entries and the report identifies the failed input; entry and output counts remain zero. `--report -` writes JSON to stderr, keeping stdout available for the spec. A strict failure still writes its conversion report and returns a nonzero exit code.

`--validate` checks the final OpenAPI document and fails on conversion or validation errors. Validation runs locally; unavailable external references produce warnings without being fetched. `--strict` additionally rejects warnings and empty output, including unresolved external references. Normal conversion remains permissive unless these options are enabled. Without a report flag, reports do not appear in CLI output. In the library, use `generateSpecsWithReport`, `includeReport: true`, or `onReport`; the callback also runs when conversion yields no specs or throws `ConversionError`, whose `report` property contains diagnostics.

The defaults retain single examples, inline schemas, and legacy requiredness. Repeated query/form keys now infer arrays by default; set `inferArrayParameters: false` to retain scalar handling for repeated names. Overlays, redaction, bracket notation, reusable components, evidence, and validation are opt-in.

## Options

```typescript
export interface Config {
  // extract reusable object schemas (default false); map inline-schema JSON Pointers to names
  reusableSchemas?: boolean;
  schemaNames?: Record<string, string>;
  // apply an OpenAPI Overlay 1.0 object after extraction
  overlay?: OpenApiOverlay;
  examples?: "single" | "multiple" | "none"; // default single
  maxExamples?: number; // positive integer, default 5
  maxExampleBytes?: number; // positive integer; multiple default 16384, single unlimited unless set
  redact?: {
    headers?: string[];
    queryParameters?: string[];
    cookies?: string[];
    bodyProperties?: string[];
    bodyPointers?: string[];
    replacement?: string;
  };
  inferArrayParameters?: boolean; // default true
  parseBracketParameters?: boolean; // default false
  requiredness?: "legacy" | "optional" | "observed"; // default legacy
  includeInferenceEvidence?: boolean;
  validate?: boolean;
  strict?: boolean;
  sourceNames?: string[];
  includeReport?: boolean;
  onReport?: (report: ConversionReport) => void;
  onDiagnostic?: (diagnostic: ConversionDiagnostic) => void;
  // generated OpenAPI document version
  openapiVersion?: "3.0.0" | "3.1.0";
  // limit generation to exact hostnames from the HAR
  includeDomains?: string[];
  // skip exact hostnames from the HAR
  excludeDomains?: string[];
  // if true, we'll treat every url as having the same domain, regardless of what its actual domain is
  // the first domain we see is the domain we'll use
  forceAllRequestsInSameSpec?: boolean;
  // custom info.title template. Supports {domain} and {generatedAt}
  infoTitle?: string;
  // custom info.version template. Supports {domain} and {generatedAt}
  infoVersion?: string;
  // custom info.description template. Supports {domain} and {generatedAt}
  infoDescription?: string;
  // if true, every path object will have its own servers entry, defining its base path. This is useful when
  // forceAllRequestsInSameSpec is set
  addServersToPaths?: boolean;
  // try and guess common auth headers
  guessAuthenticationHeaders?: boolean;
  // if the response has this status code, ignore the body
  ignoreBodiesForStatusCodes?: number[];
  // whether non standard methods should be allowed (like HTTP MY_CUSTOM_METHOD)
  relaxedMethods?: boolean;
  // whether we should try and parse non application/json responses as json - defaults to true
  relaxedContentTypeJsonParse?: boolean;
  // a list of tags that match passed on the path, either [match_and_tag] or [match, tag]
  tags?: ([string] | [string, string] | string)[] | ((url: string) => string | string[] | void);
  // response mime types to filter for
  mimeTypes?: string[];
  // include examples in response objects for non-json text content
  includeNonJsonExampleResponses?: boolean;
  // infer scalar types for query/path/form parameters when values are unambiguous
  inferParameterTypes?: boolean;
  // known security headers for this har, to add to security field in openapi (e.g. "X-Auth-Token")
  securityHeaders?: string[];
  // Whether to filter out all standard headers from the parameter list in openapi
  filterStandardHeaders?: boolean;
  // Whether to log errors to console
  logErrors?: boolean;
  // a string, regex, or callback to filter urls for inclusion
  urlFilter?: string | RegExp | ((url: string) => boolean | Promise<boolean>);
  // when we encounter a URL, try and parameterize it, such that something like
  // GET /uuids/123e4567-e89b-12d3-a456-426655440000 becomes GET /uuids/{uuid}
  attemptToParameterizeUrl?: boolean;
  // minimum numeric length before numeric path segments become parameters
  minLengthForNumericPath?: number;
  // when we encounter a path without a response or with a response that does not have 2xx, dont include it
  dropPathsWithoutSuccessfulResponse?: boolean;
  // search/replace rules to normalize noisy paths before spec generation
  pathReplace?: Record<string, string>;
}
```

## Newer CLI Additions

- Filter multi-domain captures without custom code via `--include-domains` and `--exclude-domains`.
- Override `info.title`, `info.version`, and `info.description` with `{domain}` and `{generatedAt}` placeholders.
- Choose between OpenAPI `3.0.0` and `3.1.0` from either the library config or `--openapi-version`.
- Toggle scalar parameter inference from the CLI with `--infer-parameter-types` and `--no-infer-parameter-types`.
- Load CLI config from either JSON or YAML.
