<!-- Defines project conventions for coding agents working on this application. Update these instructions as your development workflow evolves. -->

# Application instructions

- Use snake_case for application TypeScript filenames and their tests, including catalog, configuration, and generated HTTP client paths. Keep TypeScript identifiers in their usual casing. Preserve routing conventions and tool-owned filenames such as routeTree.gen.ts, vite.config.ts, and vite-env.d.ts; change generated paths through generator configuration and regenerate the files.

- Write code, comments, and documentation in English.
- Keep application code in this project and consume Kestrel through its public package exports.
- Run commands through `./do`; use `npm run test:ai` and `npm run build:ai` for validation.
- Use unit tests and Fastify injection without starting HTTP listeners. Keep tests compatible with `--no-isolate` and dispose every owned application.
- Regenerate HTTP contracts with `npm run api:generate`; never edit files under `src/generated/` manually.
- Keep database table names singular and preserve the ordered migration history in `src/server/core/db/migrations/`.
- Keep local schema-push exports and table filters aligned; development-only tables must not enter deployment migrations.
- Read environment values only in application configuration and tooling. Comment new behavior and update the README when commands change.
- Never publish packages without explicit owner approval.
