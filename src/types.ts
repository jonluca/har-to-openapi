import type { OpenApiSpec } from "@loopback/openapi-v3-types";

export interface HarToOpenAPIConfig {
  /** if true, we'll treat every url as having the same domain, regardless of what its actual domain is
    * the first domain we see is the domain we'll use
    * @defaultValue `false` */
  forceAllRequestsInSameSpec?: boolean;
  /** if true, every path object will have its own servers entry, defining its base path. This is useful when
    * forceAllRequestsInSameSpec is set */
  addServersToPaths?: boolean;
  /** try and guess common auth headers
    * @defaultValue `true` */
  guessAuthenticationHeaders?: boolean;
  /** if the response has this status code, ignore the body */
  ignoreBodiesForStatusCodes?: number[];
  /** whether non standard methods should be allowed (like HTTP MY_CUSTOM_METHOD)
    * @defaultValue `false` */
  relaxedMethods?: boolean;
  /** whether we should try and parse non application/json responses as json
    * @defaultValue `true` */
  relaxedContentTypeJsonParse?: boolean;
  /** a list of tags that match passed on the path, either [match_and_tag] or [match, tag] */
  tags?: ([string] | [string, string] | string)[] | ((url: string) => string | string[] | void);
  /** response mime types to filter for */
  mimeTypes?: string[];
  /** known security headers for this har, to add to security field in openapi (e.g. "X-Auth-Token") */
  securityHeaders?: string[];
  /** Whether to filter out all standard headers from the parameter list in openapi
    * @defaultValue `true` */
  filterStandardHeaders?: boolean;
  /** Whether to log errors to console
    * @defaultValue `false` */
  logErrors?: boolean;
  /** a string, regex, or callback to filter urls for inclusion */
  urlFilter?: string | RegExp | ((url: string) => boolean | Promise<boolean>);
  /** when we encounter a URL, try and parameterize it, such that something like
    * GET /uuids/123e4567-e89b-12d3-a456-426655440000 becomes GET /uuids/{uuid}
    * @defaultValue `false` */
  attemptToParameterizeUrl?: boolean;
  /** when we encounter a path without a response or with a response that does not have 2xx, dont include it
    * @defaultValue `false` */
  dropPathsWithoutSuccessfulResponse?: boolean;
}

type Required<T, K extends keyof T> = T & { [P in K]-?: T[P] };
type WithRequired<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>> & Required<T, K>;

export type InternalConfig = WithRequired<
  HarToOpenAPIConfig,
  | "filterStandardHeaders"
  | "addServersToPaths"
  | "attemptToParameterizeUrl"
  | "relaxedMethods"
  | "guessAuthenticationHeaders"
  | "dropPathsWithoutSuccessfulResponse"
  | "relaxedContentTypeJsonParse"
  | "forceAllRequestsInSameSpec"
>;

export interface HarToOpenAPISpec {
  spec: OpenApiSpec;
  yamlSpec: string;
  domain: string | undefined;
}
