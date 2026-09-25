# Kestrel web application

This template consumes the provisional `@kestrel/framework` package. No npm release exists or is authorized. Install a local framework archive as described in the framework repository before running commands.

Run `npm run api:generate`, `npm run typecheck`, `npm run test:ai`, and `npm run build:ai`. Run `npm run dev` for development or `NODE_ENV=production npm start` for the compiled application. The example accepts a name and calls a generated HTTP client.

PostgreSQL defaults to port 55432 and database `kestrel_playground`. Provision it using the framework infrastructure or your own database service, then run `npm run db:migrate`. Connection settings are read from the process environment; `.env.example` documents them but is not automatically loaded. Use `npm run db:generate` after editing the application schema. Framework storage schemas must be deliberately composed when adding features that need them; this starter has no local schema-push command.
