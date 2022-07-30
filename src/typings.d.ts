type JSONSchema = object;

declare module "json-schema-deref-sync" {
  declare function index(schema: JSONSchema, options?: json_schema_deref_sync.Options): JSONSchema;
  interface Options {
    baseFolder?: string;
    failOnMissing?: boolean;
    loaders?: {
      [key: string]: (reference: string, options?: Options) => JSONSchema;
    };
    mergeAdditionalProperties?: boolean;
    removeIds?: boolean;
  }

  export = index;
}
