import type { OpenApiSpec } from "@loopback/openapi-v3-types";
import type { Entry } from "har-format";

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
  /** a string, regex, or callback to filter urls for inclusion
   * ```ts
   *     urlFilter: /(?<!\.(html|js|css|png|\w{2,4}))$/
   *     urlFilter(url, entry) {
   *       // Chrome Devtools HAR example
   *       return entry._resourceType == 'xhr';
   *     }
   * ``` */
  urlFilter?: string | RegExp | ((url: string, harEntry: Entry) => boolean | Promise<boolean>);
  /** when we encounter a URL, try and parameterize it, such that something like
   * GET /uuids/123e4567-e89b-12d3-a456-426655440000 becomes GET /uuids/{uuid}
   * @defaultValue `false` */
  attemptToParameterizeUrl?: boolean;
  /** when we encounter a path without a response or with a response that does not have 2xx, dont include it
   * @defaultValue `false` */
  dropPathsWithoutSuccessfulResponse?: boolean;
  /** In the config file, you can set your API base path and any number of search/replace commands. For each parameter in
   * ```ts
   *     "pathReplace": {
   *        "key": "value",
   *        "key": "value",
   *     }
   * ```
   * The program executes as:
   * ```ts
   *   path = path.replace(/key/g, value)
   * ```
   * Why would we want to do this? I'm glad you asked. There are various answers:
   *  - Remove query string parameters from the path. Query string parameters are detected automatically and moved to path variables in the OAS file.
   *  - Search and replace IDs in the path. A noisy OAS file will contain one endpoint definition for /account/1 and another endpoint definition for /account/2. By adding replace strings to config.json you can collapse duplicate paths into one endpoint definition and automatically move the path IDs into path parameters in the OAS file.
   */
  pathReplace?: Record<string, string>;
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
