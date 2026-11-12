import { z } from "zod";

import type { ObservationData } from "../../../../observability/definitions.js";
import type {
  DatabaseQueryObservationData,
  DatabaseQueryOrigin,
} from "../../../../db/observations.js";
import type { StudioSourcePathMapping } from "../../../client_config.js";

const queryDisplayDataSchema = z.object({
  sql: z.string(),
  parameters: z.array(z.unknown()).optional(),
  statementName: z.string().optional(),
  command: z.string().optional(),
  rowCount: z.number().optional(),
  errorCode: z.string().optional(),
  origin: z.object({
    function: z.string().optional(),
    file: z.string(),
    line: z.number(),
    column: z.number(),
    stack: z.array(z.string()).optional(),
  }).optional(),
});

/** Narrows persisted generic data before the specialized renderer reads it. */
export function isDatabaseQueryObservationData(
  data: ObservationData,
): data is DatabaseQueryObservationData {
  return queryDisplayDataSchema.safeParse(data).success;
}

/** Creates a local editor link for source locations captured by instrumentation. */
export function createVscodeSourceUrl(
  origin: DatabaseQueryOrigin,
  mapping?: StudioSourcePathMapping,
): string {
  const normalizedFile = mapSourceFile(origin.file, mapping);
  // encodeURI preserves path separators; the explicit replacements protect URL
  // fragment and query delimiters that are valid characters in file names.
  const encodedFile = encodeURI(normalizedFile)
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F");
  const absoluteFile = encodedFile.startsWith("/")
    ? encodedFile
    : `/${encodedFile}`;

  return `vscode://file${absoluteFile}:${origin.line}:${origin.column}`;
}

/** Replaces only a complete runtime-root prefix with its editor equivalent. */
export function mapSourceFile(
  file: string,
  mapping?: StudioSourcePathMapping,
): string {
  const normalizedFile = decodeFilePath(file).replaceAll("\\", "/");

  if (mapping === undefined) {
    return normalizedFile;
  }

  const runtimeRoot = normalizeRoot(mapping.runtimeRoot);
  const editorRoot = normalizeRoot(mapping.editorRoot);

  if (normalizedFile === runtimeRoot) {
    return editorRoot;
  }

  const runtimePrefix = runtimeRoot.endsWith("/") ? runtimeRoot : `${runtimeRoot}/`;
  const editorPrefix = editorRoot.endsWith("/") ? editorRoot : `${editorRoot}/`;
  return normalizedFile.startsWith(runtimePrefix)
    ? `${editorPrefix}${normalizedFile.slice(runtimePrefix.length)}`
    : normalizedFile;
}

/** Runtime stack traces may contain a file URL whose path is already encoded. */
function decodeFilePath(file: string): string {
  if (!file.startsWith("file://")) return file;
  const path = file.slice("file://".length);
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape may be a literal percent in a legacy source path.
    return path;
  }
}

function normalizeRoot(root: string): string {
  const normalizedRoot = root.replaceAll("\\", "/");

  return normalizedRoot === "/"
    ? normalizedRoot
    : normalizedRoot.replace(/\/+$/u, "");
}
