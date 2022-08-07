const STANDARD_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
type IStandardMethod = typeof STANDARD_METHODS[number];

export const isStandardMethod = (header: string): header is IStandardMethod => {
  return Boolean(header) && STANDARD_METHODS.includes(header.toLowerCase() as IStandardMethod);
};
