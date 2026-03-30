# HAR to OpenAPI

[![npm Version](https://img.shields.io/npm/v/har-to-openapi.svg)](https://www.npmjs.com/package/har-to-openapi) [![License](https://img.shields.io/npm/l/har-to-openapi.svg)](https://www.npmjs.com/package/har-to-openapi)

Convert a HAR file to an OpenAPI spec

# Introduction

_This library is loosely based on [har2openapi](https://github.com/dcarr178/har2openapi), but cleaned up and changed for usage in a more programmatic fashion_

# Getting Started

```
yarn add har-to-openapi
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

The package can now also be used as a CLI without changing the existing library API.

```bash
bunx har-to-openapi capture.har > openapi.yaml
bunx har-to-openapi capture.har --format json --output openapi.json
bunx har-to-openapi test/data/base-path.har --multi-spec --output-dir generated
bunx har-to-openapi test/data/base-path.har --multi-spec --include-domains example.com
cat capture.har | bunx har-to-openapi --config har-to-openapi.config.yaml
```

The CLI supports common boolean and list options as flags, and advanced JSON-serializable configuration through `--config`. Config files can be JSON or YAML.

## Options

```typescript
export interface Config {
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
