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
  ignoreBodiesForStatusCodes?: number[];
  tags?: ([string] | [string, string])[]; // a list of tags that match passed on the path, either [match_and_tag] or [match, tag]
  mimeTypes?: string[]; // response mime types to filter for
  securityHeaders?: string[]; // known security headers for this har, to add to security field in openapi (e.g. "X-Auth-Token")
  filterStandardHeaders?: boolean; // Whether to filter out all standard headers from the parameter list in openapi
  urlFilter?: string | RegExp | ((url: string) => boolean | Promise<boolean>); // a string, regex, or callback to filter urls for inclusion
}
```

#### `apiBasePath` (string)

- If passed, we'll only filter to urls that start with this base path

```typescript
import { generateSpec } from "har-to-openapi";
const openapi = await generateSpec(har);
const { spec, yamlSpec } = openapi;
// spec = { ... } openapi spec schema document
// yamlSpec = string, "info: ..."
```

#### `dateToDateTime` (boolean)
