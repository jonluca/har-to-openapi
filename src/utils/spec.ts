import type { OpenApiSpec } from "@loopback/openapi-v3-types";

export type OpenApiVersion = "3.0.0" | "3.1.0";

export const createApiSpec = (openapiVersion: OpenApiVersion): OpenApiSpec => {
  return {
    openapi: openapiVersion,
    info: {
      title: "LoopBack Application",
      version: "1.0.0",
    },
    paths: {},
    servers: [{ url: "/" }],
  };
};
