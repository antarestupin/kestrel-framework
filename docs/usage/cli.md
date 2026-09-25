# CLI

[Usage index](./README.md) · [Implementation and command lifecycle](../implementation/cli.md)

Declare commands next to their actions and include them in the feature catalog's `controllers.cli` category.

## Expose an action with positional and named arguments

Expose an existing action as a command for operator tasks or scripts. The greeting accepts a positional name and an optional named salutation; the health command demonstrates a standalone handler.

```ts
import { z } from "zod";
import { defineAction } from "@kestrel/framework/actions";
import { App, defineCatalog } from "@kestrel/framework/app";
import { defineActionCliController, defineCliController, option, param } from "@kestrel/framework/cli";

const greet = defineAction({
  name: "greeting.greet",
  input: z.object({ name: z.string(), prefix: z.string().default("Hello") }),
  output: z.string(),
  handler: ({ name, prefix }) => `${prefix}, ${name}!`,
});
const greetCli = defineActionCliController(greet, "greeting greet", {
  // Read the first positional argument as name and --salutation as prefix.
  bindings: { name: param(0), prefix: option("salutation") },
});
const health = defineCliController({
  command: "health read",
  // The standalone command declares its own validated response contract.
  output: z.object({ status: z.literal("ok") }),
  handler: () => ({ status: "ok" as const }),
});
export default new App({}, {
  catalog: defineCatalog({
    greeting: { actions: { greet }, controllers: { cli: { greet: greetCli, health } } },
  }),
});
```

Unbound fields become `--<field>` options. Positional indexes start at zero and must be contiguous. Use `z.coerce.number()` for numeric strings and `repeatableOption()` for repeated options. A custom handler receives `{ input, deps, execution }`, plus `action` on action controllers.

## Launch the application

Use the generic launcher to execute a catalog command without writing a dedicated entry point. Save the module above as `src/example.ts` and invoke the installed `tsx` binary:

```sh
# Load the composed application, then execute its greeting command.
node_modules/.bin/tsx --import zod/compile node_modules/@kestrel/framework/dist/cli/main.js src/example.ts greeting greet Sam --salutation Hi
# Select compact JSON when a script consumes the result.
node_modules/.bin/tsx --import zod/compile node_modules/@kestrel/framework/dist/cli/main.js src/example.ts health read --_format=json
```

An application's `./do` wrapper can supply its module path once. Runtime providers add `run server`, `run workers`, `run scheduled-tasks`, `run workflows` or `run background` commands; only registered providers contribute their commands.

## Control output and errors

Choose an output format and rely on exit codes when another script consumes a command. These conventions let the same command serve interactive use and automation.

`--_format=pretty` is the default; `--_format=json` writes compact JSON. A returned `undefined` produces no result output. An `output` schema validates and transforms results before serialization.

Exit codes are 0 for success/help, 1 for unexpected execution failures and 2 for syntax or input errors. [Representable errors](./errors.md) can select their own code. Embedded callers can use `CliCommandManager.run()` to obtain the code without terminating the process; see the [testing guide](./testing.md).

## Use cases still to document

- Bind repeatable options and coerce transport input before running an action.
- Implement a standalone command with injected dependencies and custom output.
- Apply CLI middleware and capture command output and exit codes in an embedded runner.
