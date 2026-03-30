import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Har } from "har-format";
import YAML from "js-yaml";
import { generateSpec, generateSpecs } from "./index.js";
import type { HarToOpenAPIConfig, HarToOpenAPISpec } from "./types.js";

type CliFormat = "json" | "yaml";

interface CliDependencies {
  cwd: string;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  readTextFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, contents: string) => Promise<void>;
  ensureDir: (directoryPath: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ParsedCliArgs {
  configPath?: string;
  format: CliFormat;
  inputPath?: string;
  multiSpec: boolean;
  outputDir?: string;
  outputPath?: string;
  overrides: Partial<HarToOpenAPIConfig>;
  showHelp: boolean;
}

const BOOLEAN_FLAG_MAP = {
  "add-servers-to-paths": "addServersToPaths",
  "attempt-to-parameterize-url": "attemptToParameterizeUrl",
  "drop-paths-without-successful-response": "dropPathsWithoutSuccessfulResponse",
  "filter-standard-headers": "filterStandardHeaders",
  "force-all-requests-in-same-spec": "forceAllRequestsInSameSpec",
  "guess-authentication-headers": "guessAuthenticationHeaders",
  "include-non-json-example-responses": "includeNonJsonExampleResponses",
  "log-errors": "logErrors",
  "relaxed-content-type-json-parse": "relaxedContentTypeJsonParse",
  "relaxed-methods": "relaxedMethods",
} as const satisfies Record<string, keyof HarToOpenAPIConfig>;

const LIST_FLAG_MAP = {
  "exclude-domains": "excludeDomains",
  "ignore-bodies-for-status-codes": "ignoreBodiesForStatusCodes",
  "include-domains": "includeDomains",
  "mime-types": "mimeTypes",
  "security-headers": "securityHeaders",
} as const satisfies Record<string, keyof HarToOpenAPIConfig>;

const NUMBER_FLAG_MAP = {
  "min-length-for-numeric-path": "minLengthForNumericPath",
} as const satisfies Record<string, keyof HarToOpenAPIConfig>;

const STRING_FLAG_MAP = {
  "info-description": "infoDescription",
  "info-title": "infoTitle",
  "info-version": "infoVersion",
} as const satisfies Record<string, keyof HarToOpenAPIConfig>;

const HELP_TEXT = `Usage: har-to-openapi [input.har|-] [options]

Convert a HAR file to an OpenAPI document without changing the current library API.

Options:
  -h, --help                                     Show this help output
  -f, --format <yaml|json>                       Output format (default: yaml)
  -o, --output <file>                            Write a single generated spec to a file
      --output-dir <dir>                         Write multi-spec output files into a directory
      --config <file>                            Load HarToOpenAPIConfig from a JSON or YAML file
      --multi-spec                               Generate one spec per detected domain
      --include-domains <list>                   Only include exact hostnames
      --exclude-domains <list>                   Skip exact hostnames
      --force-all-requests-in-same-spec          Collapse all requests into one spec
      --no-force-all-requests-in-same-spec       Disable collapsed single-spec generation
      --info-title <text>                        Override info.title (supports {domain}, {generatedAt})
      --info-version <text>                      Override info.version (supports {domain}, {generatedAt})
      --info-description <text>                  Override info.description (supports {domain}, {generatedAt})
      --add-servers-to-paths                     Add servers entries to operations
      --no-add-servers-to-paths                  Disable operation-level servers entries
      --guess-authentication-headers             Enable auth header detection
      --no-guess-authentication-headers          Disable auth header detection
      --relaxed-methods                          Allow non-standard HTTP methods
      --no-relaxed-methods                       Disable non-standard HTTP methods
      --relaxed-content-type-json-parse          Try JSON parsing for non-JSON content types
      --no-relaxed-content-type-json-parse       Disable relaxed content-type JSON parsing
      --filter-standard-headers                  Exclude standard headers from parameters
      --no-filter-standard-headers               Keep standard headers in parameters
      --log-errors                               Log parsing errors to stderr
      --no-log-errors                            Disable parsing error logs
      --attempt-to-parameterize-url              Detect path parameters from URL segments
      --no-attempt-to-parameterize-url           Disable URL parameterization
      --drop-paths-without-successful-response   Exclude paths without 2xx responses
      --no-drop-paths-without-successful-response
                                                  Keep paths without successful responses
      --include-non-json-example-responses       Include examples for non-JSON text responses
      --no-include-non-json-example-responses    Omit non-JSON text response examples
      --ignore-bodies-for-status-codes <list>    Comma-separated status codes
      --mime-types <list>                        Comma-separated response MIME types
      --security-headers <list>                  Comma-separated security header names
      --min-length-for-numeric-path <number>     Minimum length before numeric path parts become params

Advanced options like tags, urlFilter, and pathReplace can be passed through --config.
Config files can be JSON or YAML.

Examples:
  har-to-openapi capture.har > openapi.yaml
  har-to-openapi capture.har --format json --output openapi.json
  har-to-openapi test/data/base-path.har --multi-spec --output-dir generated
  cat capture.har | har-to-openapi --config har-to-openapi.config.json
`;

const readStream = async (stream: NodeJS.ReadStream) => {
  let output = "";

  for await (const chunk of stream) {
    output += chunk.toString();
  }

  return output;
};

const defaultDependencies: CliDependencies = {
  cwd: process.cwd(),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  readStdin: async () => readStream(process.stdin),
  readTextFile: async (filePath: string) => readFile(filePath, { encoding: "utf8" }),
  writeTextFile: async (filePath: string, contents: string) => writeFile(filePath, contents, { encoding: "utf8" }),
  ensureDir: async (directoryPath: string) => {
    await mkdir(directoryPath, { recursive: true });
  },
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  },
};

const getDependencies = (overrides?: Partial<CliDependencies>): CliDependencies => {
  return { ...defaultDependencies, ...overrides };
};

const resolveFromCwd = (cwd: string, targetPath: string) => {
  if (targetPath === "-") {
    return targetPath;
  }
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
};

const normalizeFormat = (value: string): CliFormat => {
  if (value === "json" || value === "yaml") {
    return value;
  }
  throw new Error(`Unsupported format "${value}". Use "yaml" or "json".`);
};

const parseStringList = (value: string) => {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
};

const parseNumberList = (value: string) => {
  const numbers = parseStringList(value).map((part) => Number(part));
  if (numbers.some((entry) => Number.isNaN(entry))) {
    throw new Error(`Expected a comma-separated list of numbers, received "${value}".`);
  }
  return numbers;
};

const parseNumericValue = (value: string) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected a number, received "${value}".`);
  }
  return parsed;
};

const takeNextValue = (argv: string[], index: number, flag: string) => {
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return next;
};

const parseCliArgs = (argv: string[]): ParsedCliArgs => {
  const parsed: ParsedCliArgs = {
    format: "yaml",
    multiSpec: false,
    overrides: {},
    showHelp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "-h":
      case "--help":
        parsed.showHelp = true;
        continue;
      case "-f":
      case "--format":
        parsed.format = normalizeFormat(takeNextValue(argv, index, argument));
        index += 1;
        continue;
      case "-o":
      case "--output":
        parsed.outputPath = takeNextValue(argv, index, argument);
        index += 1;
        continue;
      case "--output-dir":
        parsed.outputDir = takeNextValue(argv, index, argument);
        index += 1;
        continue;
      case "--config":
        parsed.configPath = takeNextValue(argv, index, argument);
        index += 1;
        continue;
      case "--multi-spec":
        parsed.multiSpec = true;
        continue;
      default:
        break;
    }

    if (argument.startsWith("--no-")) {
      const flag = argument.slice("--no-".length) as keyof typeof BOOLEAN_FLAG_MAP;
      const configKey = BOOLEAN_FLAG_MAP[flag];
      if (!configKey) {
        throw new Error(`Unknown option "${argument}".`);
      }
      parsed.overrides[configKey] = false;
      continue;
    }

    if (argument.startsWith("--")) {
      const flag = argument.slice("--".length);

      if (flag in BOOLEAN_FLAG_MAP) {
        const configKey = BOOLEAN_FLAG_MAP[flag as keyof typeof BOOLEAN_FLAG_MAP];
        parsed.overrides[configKey] = true;
        continue;
      }

      if (flag in LIST_FLAG_MAP) {
        const configKey = LIST_FLAG_MAP[flag as keyof typeof LIST_FLAG_MAP];
        const value = takeNextValue(argv, index, argument);
        switch (configKey) {
          case "excludeDomains":
            parsed.overrides.excludeDomains = parseStringList(value);
            break;
          case "ignoreBodiesForStatusCodes":
            parsed.overrides.ignoreBodiesForStatusCodes = parseNumberList(value);
            break;
          case "includeDomains":
            parsed.overrides.includeDomains = parseStringList(value);
            break;
          case "mimeTypes":
            parsed.overrides.mimeTypes = parseStringList(value);
            break;
          case "securityHeaders":
            parsed.overrides.securityHeaders = parseStringList(value);
            break;
        }
        index += 1;
        continue;
      }

      if (flag in NUMBER_FLAG_MAP) {
        const configKey = NUMBER_FLAG_MAP[flag as keyof typeof NUMBER_FLAG_MAP];
        parsed.overrides[configKey] = parseNumericValue(takeNextValue(argv, index, argument));
        index += 1;
        continue;
      }

      if (flag in STRING_FLAG_MAP) {
        const configKey = STRING_FLAG_MAP[flag as keyof typeof STRING_FLAG_MAP];
        parsed.overrides[configKey] = takeNextValue(argv, index, argument);
        index += 1;
        continue;
      }

      throw new Error(`Unknown option "${argument}".`);
    }

    if (parsed.inputPath) {
      throw new Error(`Received multiple input paths. Use one HAR file path or stdin.`);
    }

    parsed.inputPath = argument;
  }

  if (parsed.outputPath && parsed.outputDir) {
    throw new Error(`Use either --output or --output-dir, not both.`);
  }

  if (parsed.multiSpec && parsed.outputPath) {
    throw new Error(`--multi-spec cannot be combined with --output. Use --output-dir or stdout.`);
  }

  return parsed;
};

const loadConfig = async (
  configPath: string | undefined,
  dependencies: CliDependencies,
): Promise<Partial<HarToOpenAPIConfig>> => {
  if (!configPath) {
    return {};
  }

  const resolvedPath = resolveFromCwd(dependencies.cwd, configPath);
  const rawConfig = await dependencies.readTextFile(resolvedPath);
  let parsedConfig: unknown;

  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch {
    parsedConfig = YAML.load(rawConfig);
  }

  if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
    throw new Error(`Expected ${configPath} to contain a JSON or YAML object.`);
  }

  return parsedConfig as Partial<HarToOpenAPIConfig>;
};

const loadHar = async (inputPath: string | undefined, dependencies: CliDependencies): Promise<Har> => {
  if (inputPath === "-") {
    const input = await dependencies.readStdin();
    return JSON.parse(input) as Har;
  }

  if (inputPath) {
    const resolvedPath = resolveFromCwd(dependencies.cwd, inputPath);
    const input = await dependencies.readTextFile(resolvedPath);
    return JSON.parse(input) as Har;
  }

  if (!dependencies.stdinIsTTY) {
    const input = await dependencies.readStdin();
    return JSON.parse(input) as Har;
  }

  throw new Error(`Missing HAR input path. Pass a file path or pipe HAR JSON over stdin.`);
};

const withTrailingNewline = (value: string) => {
  return value.endsWith("\n") ? value : `${value}\n`;
};

const renderSpec = (spec: HarToOpenAPISpec, format: CliFormat) => {
  if (format === "json") {
    return withTrailingNewline(JSON.stringify(spec.spec, null, 2));
  }

  return withTrailingNewline(spec.yamlSpec);
};

const sanitizeFileSegment = (value: string) => {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "spec";
};

const getSpecFilename = (spec: HarToOpenAPISpec, index: number, format: CliFormat) => {
  const extension = format === "json" ? "json" : "yaml";
  const basename = sanitizeFileSegment(spec.domain || `spec-${index + 1}`);
  return `${basename}.${extension}`;
};

export const runCli = async (argv = process.argv.slice(2), overrides?: Partial<CliDependencies>): Promise<number> => {
  const dependencies = getDependencies(overrides);

  try {
    const parsedArgs = parseCliArgs(argv);

    if (parsedArgs.showHelp) {
      dependencies.stdout(HELP_TEXT);
      return 0;
    }

    const har = await loadHar(parsedArgs.inputPath, dependencies);
    const fileConfig = await loadConfig(parsedArgs.configPath, dependencies);
    const config: Partial<HarToOpenAPIConfig> = { ...fileConfig, ...parsedArgs.overrides };

    if (parsedArgs.multiSpec) {
      const specs = await generateSpecs(har, config);

      if (parsedArgs.outputDir) {
        const resolvedOutputDir = resolveFromCwd(dependencies.cwd, parsedArgs.outputDir);
        await dependencies.ensureDir(resolvedOutputDir);

        await Promise.all(
          specs.map(async (spec, index) => {
            const destination = path.join(resolvedOutputDir, getSpecFilename(spec, index, parsedArgs.format));
            await dependencies.writeTextFile(destination, renderSpec(spec, parsedArgs.format));
          }),
        );
      } else if (parsedArgs.format === "json") {
        dependencies.stdout(
          withTrailingNewline(
            JSON.stringify(
              specs.map((spec) => spec.spec),
              null,
              2,
            ),
          ),
        );
      } else {
        const yamlOutput = specs.map((spec) => spec.yamlSpec.trimEnd()).join("\n---\n");
        dependencies.stdout(withTrailingNewline(yamlOutput));
      }

      return 0;
    }

    const spec = await generateSpec(har, config);
    const output = renderSpec(spec, parsedArgs.format);

    if (parsedArgs.outputPath) {
      const resolvedOutputPath = resolveFromCwd(dependencies.cwd, parsedArgs.outputPath);
      await dependencies.writeTextFile(resolvedOutputPath, output);
    } else {
      dependencies.stdout(output);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(`${message}\n`);
    return 1;
  }
};
