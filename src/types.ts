import type { OpenApiSpec } from "@loopback/openapi-v3-types";

export interface ExampleFile {
  [path: string]: {
    [method: string]: {
      request: {
        [exampleName: string]: any;
      };
      response: {
        [statusCode: string]: {
          [exampleName: string]: any;
        };
      };
    };
  };
}

export interface Config {
  apiBasePath?: string; // if passed, we'll only filter to urls that include this
  ignoreBodiesForStatusCodes?: number[];
  tags?: string[][];
  mimeTypes?: string[];
  securityHeaders?: string[];
  filterStandardHeaders?: boolean;
  urlFilter?: string | RegExp | ((url: string) => boolean | Promise<boolean>);
}

export interface IGenerateSpecResponse {
  spec: OpenApiSpec;
  yamlSpec: string;
}
