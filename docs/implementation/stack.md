# Stack

[Documentation](../README.md) · [Implementation index](./README.md)

- **Node.js**
- **Fastify**
- **Zod** for validation
- **PostgreSQL, Drizzle** for DB
- **Commander** for CLI command parsing, wrapped by typed CLI controllers using Zod contracts
- **React, Vite, TanStack Router and TanStack Query** for the application client
- **@fastify/vite** to serve browser clients through the existing Fastify server
- **Vitest** for testing

## Configuration

### tsconfig file

There are 2 tsconfig files:
- tsconfig.json: configures the IDE npm run typecheck, without producing files thanks to noEmit: true
- tsconfig.build.json: reenables the production into dist/ and excludes *.test.ts files from the production build

### .nvmrc

Indicates version managers like nvm which Node version is used. We may remove it to use dev container only.

## .env

Local configuration can be placed in `.env`; see `.env.example` for the available HTTP settings. Supported application environments are `local`, `test`, `stage`, and `prod`.
