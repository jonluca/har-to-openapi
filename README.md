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
const openapi = await generateSpec(har);
const { spec, yamlSpec } = openapi;
// spec = { ... } openapi spec schema document
// yamlSpec = string, "info: ..."
```

## Options

```typescript
export interface Config {
  // if true, we'll treat every url as having the same domain, regardless of what its actual domain is
  // the first domain we see is the domain we'll use
  forceAllRequestsInSameSpec?: boolean;
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
  // when we encounter a path without a response or with a response that does not have 2xx, dont include it
  dropPathsWithoutSuccessfulResponse?: boolean;
}
```
