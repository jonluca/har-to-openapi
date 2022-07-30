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
  pathReplace?: {
    [search: string]: string;
  };
  tags?: string[][];
}
