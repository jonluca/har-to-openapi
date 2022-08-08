// Map some known parameters to their OpenAPI3 counterparts, otherwise just fallback
import type { ResponseObject } from "@loopback/openapi-v3-types";

export const addResponse = (status: number, method: string): ResponseObject => {
  switch (status) {
    case 200:
    case 201:
      switch (method) {
        case "get":
          return { description: "Success" };
        case "delete":
          return { description: "Deleted" };
        case "patch":
          return { description: "Updated" };
        case "post":
          return { description: "Created" };
        default:
          return { description: "Success" };
      }
    case 304:
      return { description: "Not modified" };
    case 400:
      switch (method) {
        case "delete":
          return { description: "Deletion failed" };
        default:
          return { description: "Bad request" };
      }
    case 401:
      return { description: "Unauthorized" };
    case 404:
      return { description: "Not found" };
    case 405:
      return { description: "Not allowed" };
    case 500:
    case 501:
    case 502:
    case 503:
      return { description: "Server error" };
    default:
      if (status > 200 && status < 300) {
        switch (method) {
          case "get":
            return { description: "Success" };
          case "delete":
            return { description: "Deleted" };
          case "patch":
            return { description: "Updated" };
          case "post":
            return { description: "Created" };
        }
      } else if (status >= 300 && status < 400) {
        return { description: "Redirect" };
      } else if (status >= 400 && status < 500) {
        return { description: "Client error" };
      } else if (status >= 500 && status < 600) {
        return { description: "Server error" };
      }
  }
  return { description: "Unknown" };
};
