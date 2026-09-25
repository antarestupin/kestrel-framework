import type { ZodType } from "zod";

import type { DependencyDeclarations } from "../di/index.js";
import type { DefinitionValidation } from "./validation.js";

/** Metadata shared by inspectable Kestrel definitions. */
export interface DefinitionMetadata {
  readonly description?: string;
}

/**
 * Describes the schemas and dependencies shared by executable definitions.
 * Output remains optional because transport controllers may be undocumented.
 */
export interface DefinitionContract<
  InputSchema extends ZodType,
  OutputSchema extends ZodType | undefined,
  Dependencies extends DependencyDeclarations<never>,
> extends DefinitionMetadata {
  readonly inputSchema: InputSchema;
  readonly validation: DefinitionValidation;
  readonly outputSchema?: OutputSchema;
  readonly dependencies: Dependencies;
}
