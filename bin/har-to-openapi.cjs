#!/usr/bin/env node
"use strict";

const handleCliError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

const main = async (argv = process.argv.slice(2)) => {
  const { runCli } = await import("../dist/cli.js");
  process.exitCode = await runCli(argv);
};

void main().catch(handleCliError);
