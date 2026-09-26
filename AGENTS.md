# Agent instructions

- Write code, comments, and documentation in English.
- Never publish to npm without explicit owner approval.
- This repository must contain only Kestrel and public examples.
- Use npm run test:ai and npm run build:ai.
- Use unit tests and fastify.inject(), without starting HTTP servers.
- Keep tests compatible with --no-isolate and dispose all owned resources.
- Keep adapter implementation, tests, exports, and supporting files together.
- Check security advisories and audit a temporary script-disabled lockfile before installing unfamiliar dependencies.
- Keep lower-level library dependencies acyclic; move common contracts downward or inject composition dependencies.
- Framework code and tests must not import application code. Keep browser entry points free of server runtime dependencies.
- Production behavior receives configuration; environment reads belong to applications and test infrastructure.
- Keep database table names singular and schema-push exports aligned with table filters.
- Update linked usage and implementation documentation under docs when changing APIs.
- Comment new behavior, keep Markdown paragraphs unwrapped, and document deferred evolutions.
- Suggest a commit message at each change; the message must be concise (1 line)
- Run npm run test:ai directly, without shell redirection or wrappers, so the existing command approval remains reusable. Capture output through the execution tool.
