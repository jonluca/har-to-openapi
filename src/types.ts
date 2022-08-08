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
  // if true, we'll treat every url as having the same domain, regardless of what its actual domain is
  // the first domain we see is the domain we'll use
  forceAllRequestsInSameSpec?: boolean;
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
}

type Required<T, K extends keyof T> = T & { [P in K]-?: T[P] };
type WithRequired<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>> & Required<T, K>;
export type InternalConfig = WithRequired<
  Config,
  "filterStandardHeaders" | "forceAllRequestsInSameSpec" | "relaxedMethods" | "relaxedContentTypeJsonParse"
>;

export interface IGenerateSpecResponse {
  spec: OpenApiSpec;
  yamlSpec: string;
  domain: string | undefined;
}
