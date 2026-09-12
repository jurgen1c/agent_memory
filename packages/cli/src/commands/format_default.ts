import { loadConfig } from "../../../core/src/config";
import { MissingConfigError } from "../../../core/src/errors";

/** Explicit flags win. Old or uninitialized apps retain legacy dispatch. */
export function withDefaultFormatVersion(args: string[], cwd?: string): string[] {
  if (args.some(arg => arg === "--format-version" || arg.startsWith("--format-version="))) return args;
  try {
    return loadConfig({ cwd }).config.retrieval?.default_format_version === 2
      ? [...args, "--format-version", "2"] : args;
  } catch (error) {
    if (error instanceof MissingConfigError) return args;
    throw error;
  }
}
