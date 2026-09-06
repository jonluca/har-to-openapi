import type { ConversionReport } from "./types.js";

/** A failed conversion retains its complete machine-readable report. */
export class ConversionError extends Error {
  constructor(public readonly report: ConversionReport) {
    const first =
      report.diagnostics.find((diagnostic) => diagnostic.level === "error") ??
      report.diagnostics.find((diagnostic) => diagnostic.level === "warning");
    super(first ? `Conversion failed: ${first.message}` : "Conversion failed.");
    this.name = "ConversionError";
  }
}
