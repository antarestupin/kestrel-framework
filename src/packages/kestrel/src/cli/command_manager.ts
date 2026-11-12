import { AsyncLocalStorage } from "node:async_hooks";

import {
  Command,
  CommanderError,
  Option,
} from "commander";
import {
  type input,
  type output,
  prettifyError,
  ZodError,
  type ZodType,
} from "zod";

import { parseSchema } from "../definitions/index.js";
import {
  type App,
  executionCompletedObservation,
  executionStartedObservation,
  getExecutionObservationError,
  getExecutionObservationContext,
  setExecutionLogContext,
} from "../app/index.js";
import type {
  DependencyContainer,
  DependencyDeclarations,
  ResolvedDependencies,
} from "../di/index.js";
import type { CliErrorRepresentation } from "../errors/index.js";
import { runMiddlewarePipeline } from "../middleware/index.js";
import {
  observerDependency,
  type Observer,
} from "../observability/index.js";
import type { CliInputBinding } from "./bindings.js";
import type {
  CliController,
  CliObjectSchema,
} from "./controller.js";

export type CliOutputFormat = "pretty" | "json";

export interface CliCommandManagerOptions {
  name?: string;
  version?: string;
  writeOutput?: (value: string) => void;
  writeError?: (value: string) => void;
}

class CliInputError extends Error {
  public constructor(public readonly cause: ZodError) {
    super("The command input is invalid.", { cause });
  }
}

class CliHandledError extends Error {
  public constructor(
    public readonly representation: CliErrorRepresentation,
  ) {
    super(representation.message);
  }
}

interface RegisteredFieldBinding {
  field: string;
  binding: CliInputBinding;
  optionAttribute?: string;
}

/**
 * Registers CLI controllers and executes commands without owning process exit.
 */
export class CliCommandManager<Config> {
  private readonly program: Command;
  private readonly controllers: AnyRegisteredCliController[] = [];
  private readonly writeOutput: (value: string) => void;
  private readonly writeError: (value: string) => void;
  // Keep the caller's raw arguments available to prepareWorkloads after parsing.
  private readonly invocationArguments = new AsyncLocalStorage<readonly string[]>();

  public constructor(
    private readonly app: App<Config>,
    options: CliCommandManagerOptions = {},
  ) {
    this.writeOutput =
      options.writeOutput ?? ((value) => process.stdout.write(value));
    this.writeError =
      options.writeError ?? ((value) => process.stderr.write(value));
    this.program = this.configureCommand(new Command())
      .name(options.name ?? "do")
      .addOption(
        new Option(
          "--_format <format>",
          "Output format.",
        )
          .choices(["pretty", "json"])
          .default("pretty"),
      );

    if (options.version !== undefined) {
      this.program.version(options.version);
    }
  }

  /**
   * Adds one controller to the command tree.
   */
  public register<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    const ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    const ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: CliController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): this {
    const segments = controller.command.split(" ");
    const command = this.configureCommand(new Command(segments.pop()));
    const fieldBindings = this.configureInput(
      command,
      controller,
    );

    command.description(controller.description ?? "");

    command.action(async () => {
      // Capture Commander state before any async work can allow another parse.
      const rawInput = this.readInput(command, fieldBindings);
      const { _format: format } = command.optsWithGlobals<{ _format: CliOutputFormat }>();

      // Commander only calls the action for a parsed command. Help and version
      // flags can also appear as literal input, so raw tokens cannot select boot.
      if (this.app.state === "composing") {
        this.prepareController(controller as AnyRegisteredCliController, this.invocationArguments.getStore() ?? []);
        await this.app.start();
      }

      const execution = await this.app.createExecutionScope();
      try {
        const observer = controller.observe
          ? this.resolveObserver(execution.container)
          : undefined;
        const operation = controller.command;
        setExecutionLogContext(execution.context, {
          operation,
          transport: "cli",
        });
        const startedAt = performance.now();
        let outcome: "failure" | "success" = "success";
        let executionError: unknown;

        await this.app.runInObservationContext(observer, async () => {
          observer?.record(executionStartedObservation, {
            operation,
            transport: "cli",
          });

          try {
            let input: output<ControllerInputSchema>;

            try {
              input = await parseSchema(
                controller.inputSchema,
                rawInput,
                controller.validation.input,
              );
            } catch (error: unknown) {
              if (error instanceof ZodError) {
                throw new CliInputError(error);
              }

              throw error;
            }

            const parsedResult = await runMiddlewarePipeline(
              controller.middleware,
              { controller, input, execution },
              execution.container,
              async () => {
                const dependencies = await execution.container.resolveDependenciesAsync(
                  controller.dependencies,
                );
                const result = controller.source === "standalone"
                  ? await controller.handler({
                      input,
                      deps: dependencies,
                      execution,
                      writeProgress: (message) => this.writeError(`${message}\n`),
                    })
                  : await this.runActionController(
                      controller,
                      input,
                      dependencies,
                      execution,
                    );

                return controller.outputSchema === undefined
                  ? result
                  : parseSchema(controller.outputSchema, result, controller.validation.output);
              },
            );
            this.printResult(parsedResult, format);
          } catch (error: unknown) {
            outcome = "failure";
            executionError = error;
            // Input errors retain Commander's dedicated usage-oriented rendering.
            if (error instanceof CliInputError) {
              throw error;
            }

            throw new CliHandledError(
              execution.errorHandler.handleCli(error, {
                executionId: execution.id,
              }),
            );
          } finally {
            try {
              observer?.record(
                executionCompletedObservation,
                {
                  operation,
                  transport: "cli",
                  ...getExecutionObservationContext(execution.context),
                  ...(executionError === undefined
                    ? {}
                    : getExecutionObservationError(executionError)),
                },
                {
                  outcome,
                  durationMs: performance.now() - startedAt,
                },
              );
            } finally {
              // Finish the scope in its observer context even if completion recording throws.
              await execution.dispose(outcome);
            }
          }
        });
      } catch (error: unknown) {
        // Observer setup and start recording can fail before the command runs.
        await execution.dispose("failure").catch(() => undefined);
        throw error;
      }
    });

    // Validate the complete command before publishing it to either lookup.
    this.attachCommand(command, segments, controller.command);
    this.controllers.push(controller as AnyRegisteredCliController);
    return this;
  }

  private resolveObserver(
    container: DependencyContainer<Config>,
  ): Observer | undefined {
    return container.hasRegistration("observer")
      ? container.resolve(observerDependency)
      : undefined;
  }

  /**
   * Parses user arguments and returns a process-compatible exit code.
   */
  public async run(arguments_: readonly string[]): Promise<number> {
    try {
      // An empty invocation shows the discoverable command catalog.
      const normalizedArguments =
        arguments_.length === 0 ? ["--help"] : [...arguments_];

      await this.invocationArguments.run(arguments_, () =>
        this.program.parseAsync(normalizedArguments, { from: "user" }));

      return 0;
    } catch (error: unknown) {
      if (error instanceof CommanderError) {
        if (
          error.code === "commander.helpDisplayed"
          || error.code === "commander.version"
          // An explicit help subcommand succeeds. Usage help for a missing subcommand fails.
          || (error.code === "commander.help" && error.exitCode === 0)
        ) {
          return 0;
        }

        return 2;
      }

      if (error instanceof CliInputError) {
        this.writeError(
          `Invalid command input:\n${prettifyError(error.cause)}\n`,
        );

        return 2;
      }

      if (error instanceof CliHandledError) {
        this.writeError(`${error.representation.message}\n`);

        return error.representation.exitCode;
      }

      // Errors outside command execution cannot use an execution-scoped
      // handler and retain a minimal defensive fallback.
      this.writeError("An unexpected CLI error occurred.\n");

      return 1;
    }
  }

  /** Resolves controller metadata before application bootstrap begins. */
  public prepare(arguments_: readonly string[]): void {
    this.prepareController(this.resolveController(arguments_), arguments_);
  }

  private prepareController(
    controller: AnyRegisteredCliController | undefined,
    arguments_: readonly string[],
  ): void {
    this.app.prepareBootPlan(
      controller?.prepareWorkloads?.(arguments_)
        ?? controller?.workloads
        ?? [],
      controller?.runningMode ?? "standard",
      controller?.runtime ?? "command",
    );
  }

  private resolveController(
    arguments_: readonly string[],
  ): AnyRegisteredCliController | undefined {
    const commandArguments = removeGlobalOptions(arguments_);

    return this.controllers
      .filter((controller) => {
        const segments = controller.command.split(" ");

        return segments.every(
          (segment, index) => commandArguments[index] === segment,
        );
      })
      // Each matching path is a prefix of the invocation. The longest is most specific.
      .sort((left, right) => right.command.length - left.command.length)[0];
  }

  private attachCommand(command: Command, segments: readonly string[], path: string): void {
    let parent = this.program;

    for (const segment of segments) {
      const existing = parent.commands.find(
        (command) => command.name() === segment,
      );

      if (existing !== undefined) {
        parent = existing;
        continue;
      }

      const group = this.configureCommand(
        new Command(segment),
      );

      parent.addCommand(group);
      parent = group;
    }

    if (
      parent.commands.some(
        (registered) => registered.name() === command.name(),
      )
    ) {
      throw new Error(`CLI command "${path}" is already registered.`);
    }

    parent.addCommand(command);
  }

  private configureInput<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    command: Command,
    controller: CliController<
      ActionInputSchema,
      ActionOutputSchema,
      ActionDependencies,
      ControllerInputSchema,
      ControllerOutputSchema,
      ControllerDependencies
    >,
  ): RegisteredFieldBinding[] {
    const fields = Object.entries(
      controller.inputSchema.shape,
    ) as [string, ZodType][];
    const registered = fields.map(([field, schema]) => {
      if (field === "_format") {
        throw new Error(
          'The CLI input field "_format" is reserved.',
        );
      }

      const binding: CliInputBinding = Object.hasOwn(controller.bindings, field)
        ? controller.bindings[field] ?? { kind: "option" }
        : { kind: "option" };

      return {
        field,
        binding,
        schema,
      };
    });
    const parameters = registered.flatMap(({ field, binding, schema }) =>
      binding.kind === "parameter" ? [{ field, index: binding.index, schema }] : [],
    ).sort((left, right) => left.index - right.index);

    parameters.forEach((item, expectedIndex) => {
      if (item.index !== expectedIndex) {
        throw new Error(
          "CLI positional parameter indexes must be unique and contiguous.",
        );
      }

      command.argument(
        item.schema.isOptional()
          ? `[${item.field}]`
          : `<${item.field}>`,
        item.schema.description,
      );
    });

    const optionAttributes = new Set<string>();
    return registered.map(({ field, binding, schema }) => {
      if (binding.kind === "parameter") {
        return { field, binding };
      }

      const optionName = binding.name ?? field;

      assertOptionName(optionName);

      const cliOption = new Option(
        `--${optionName} <${field}>`,
        schema.description,
      );
      // Schema-bound options always take values, including literal --no-* names.
      cliOption.negate = false;
      const optionAttribute = cliOption.attributeName();
      if (optionAttributes.has(optionAttribute)) {
        throw new Error(`CLI option "--${optionName}" conflicts with another input option.`);
      }
      optionAttributes.add(optionAttribute);

      if (binding.repeatable === true) {
        cliOption.argParser((value: string, previous: unknown) => [
          // Commander's initial lookup can see a prototype property of the same name.
          ...(Array.isArray(previous) ? previous : []),
          value,
        ]);
      }

      if (!schema.isOptional()) {
        cliOption.makeOptionMandatory();
      }

      command.addOption(cliOption);

      return {
        field,
        binding,
        optionAttribute,
      };
    });
  }

  private async runActionController<
    ActionInputSchema extends CliObjectSchema,
    ActionOutputSchema extends ZodType,
    ActionDependencies extends DependencyDeclarations<Config>,
    ControllerInputSchema extends CliObjectSchema,
    ControllerOutputSchema extends ZodType | undefined,
    ControllerDependencies extends DependencyDeclarations<Config>,
  >(
    controller: Extract<
      CliController<
        ActionInputSchema,
        ActionOutputSchema,
        ActionDependencies,
        ControllerInputSchema,
        ControllerOutputSchema,
        ControllerDependencies
      >,
      { source: "action" }
    >,
    input_: output<ControllerInputSchema>,
    dependencies: ResolvedDependencies<ControllerDependencies>,
    execution: Awaited<ReturnType<App<Config>["createExecutionScope"]>>,
  ): Promise<unknown> {
    const action = execution.get(controller.action);

    return controller.handler === undefined
      ? action.run(input_ as input<ActionInputSchema>)
      : controller.handler({
          action,
          input: input_,
          deps: dependencies,
          execution,
          writeProgress: (message) => this.writeError(`${message}\n`),
        });
  }

  private readInput(
    command: Command,
    bindings: RegisteredFieldBinding[],
  ): Record<string, unknown> {
    const options = command.opts<Record<string, unknown>>();
    // Zod must also see omitted fields as missing when their names shadow a prototype property.
    const input: Record<string, unknown> = Object.create(null);

    for (const { field, binding, optionAttribute } of bindings) {
      const value = binding.kind === "parameter"
        ? command.processedArgs[binding.index]
        : optionAttribute !== undefined && Object.hasOwn(options, optionAttribute) ? options[optionAttribute] : undefined;
      if (value !== undefined) input[field] = value;
    }

    return input;
  }

  private printResult(
    result: unknown,
    format: CliOutputFormat,
  ): void {
    const serialized =
      format === "pretty"
        ? JSON.stringify(result, null, 2)
        : JSON.stringify(result);

    if (serialized !== undefined) {
      this.writeOutput(`${serialized}\n`);
    }
  }

  private configureCommand(command: Command): Command {
    return command
      .showHelpAfterError()
      .exitOverride()
      .configureOutput({
        writeOut: this.writeOutput,
        writeErr: this.writeError,
      });
  }
}

type AnyRegisteredCliController = CliController<any, any, any, any, any, any>;

/** Removes the root output option so it does not affect command selection. */
function removeGlobalOptions(arguments_: readonly string[]): string[] {
  const result: string[] = [];

  const argumentsIterator = arguments_.values();
  for (const argument of argumentsIterator) {
    if (argument === "--_format") {
      argumentsIterator.next();
      continue;
    }

    if (argument.startsWith("--_format=")) {
      continue;
    }

    result.push(argument);
  }

  return result;
}

function assertOptionName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError(`Invalid CLI option name "${name}".`);
  }
}
