import type { ObservationData } from "../../../../observability/definitions.js";
import type {
  DatabaseQueryObservationData,
  DatabaseQueryOrigin,
} from "../../../../db/observations.js";
import type { StudioSourcePathMapping } from "../../../client_config.js";

/** Narrows persisted generic data before the specialized renderer reads it. */
export function isDatabaseQueryObservationData(
  data: ObservationData,
): data is DatabaseQueryObservationData {
  return typeof data.sql === "string";
}

/** Creates a local editor link for source locations captured by instrumentation. */
export function createVscodeSourceUrl(
  origin: DatabaseQueryOrigin,
  mapping?: StudioSourcePathMapping,
): string {
  const file = origin.file.startsWith("file://")
    ? origin.file.slice("file://".length)
    : origin.file;
  const normalizedFile = mapSourceFile(file, mapping);
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
  const normalizedFile = file.replaceAll("\\", "/");

  if (mapping === undefined) {
    return normalizedFile;
  }

  const runtimeRoot = normalizeRoot(mapping.runtimeRoot);
  const editorRoot = normalizeRoot(mapping.editorRoot);

  if (normalizedFile === runtimeRoot) {
    return editorRoot;
  }

  return normalizedFile.startsWith(`${runtimeRoot}/`)
    ? `${editorRoot}${normalizedFile.slice(runtimeRoot.length)}`
    : normalizedFile;
}

function normalizeRoot(root: string): string {
  const normalizedRoot = root.replaceAll("\\", "/");

  return normalizedRoot === "/"
    ? normalizedRoot
    : normalizedRoot.replace(/\/+$/u, "");
}
