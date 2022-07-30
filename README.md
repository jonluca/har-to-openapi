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

`<Lottie>` component can be used in a declarative way:

```jsx
import {generateSpec} from "har-to-openapi";


const spec = generateSpec(har);
```


## API
