// Focused public API recipes: display order matches the homepage tab order.
export const capabilityExamples = [
  {
    id: "validation",
    label: "Validation",
    title: "One contract, checked at runtime.",
    description: "Use Zod input and output schemas to connect runtime validation with inferred TypeScript types. Keep the same contract for direct and transport calls.",
    guide: "/docs/usage/definitions",
    guideLabel: "Validation guide",
    file: "normalize_contact.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { defineAction } from '@kestreljs/framework/actions';

export const normalizeContact = defineAction({
  name: 'contact.normalize',
  input: z.object({
    name: z.string().trim().min(1),
    email: z.email(),
  }),
  output: z.object({ name: z.string(), email: z.email() }),
  // Input types and schema transformations reach the handler.
  handler: ({ name, email }) => ({ name, email }),
});`,
  },
  {
    id: "orm",
    label: "ORM",
    title: "Your schema. Typed repositories.",
    description: "Build on PostgreSQL and Drizzle with reusable repositories, scoped database managers, and explicit transaction boundaries.",
    guide: "/docs/usage/database#create-a-repository-backed-action",
    guideLabel: "Database guide",
    file: "contact_repository.ts",
    language: "typescript",
    code: `import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { Repository, PostgresDrizzleManager } from '@kestreljs/framework/db';

export const contact = pgTable('contact', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});
type NewContact = typeof contact.$inferInsert;

export class ContactRepository extends Repository<
  typeof contact, string, NewContact, Partial<NewContact>
> {
  // DI supplies the manager for the current execution.
  constructor({ databaseManager }: { databaseManager: PostgresDrizzleManager }) {
    super(databaseManager, { table: contact, idColumn: contact.id });
  }
}`,
  },
  {
    id: "auth",
    label: "Auth",
    title: "Sessions with explicit boundaries.",
    description: "Password authentication and stateful sessions integrate with reusable action middleware. Protect behavior once, across its transports.",
    guide: "/docs/usage/authentication",
    guideLabel: "Authentication guide",
    file: "protected_action.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { defineAction } from '@kestreljs/framework/actions';
import { requireAuthentication } from '@kestreljs/framework/authentication';

export const welcomeBack = defineAction({
  name: 'account.welcome-back',
  input: z.object({}),
  output: z.object({ message: z.string() }),
  // Enforce authentication even for direct action calls.
  middleware: [requireAuthentication],
  handler: () => ({ message: 'Welcome back.' }),
});`,
  },
  {
    id: "http",
    label: "HTTP client",
    title: "External APIs, with boundaries.",
    description: "Give outbound requests a time budget, a response-size limit, and a validated response shape before data reaches your application.",
    guide: "/docs/usage/outbound_http",
    guideLabel: "Outbound HTTP guide",
    file: "weather_client.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { createOutboundHttpClient, json } from '@kestreljs/framework/outbound_http';

const weather = createOutboundHttpClient({
  name: 'weather', baseUrl: 'https://weather.example',
  timeoutMs: 5_000,
  maxResponseBytes: 128 * 1_024,
});
export async function forecast(city: string) {
  return weather.get('/forecast/:city', {
    path: { city },
    // Validate the response before returning it to callers.
    response: json(z.object({ temperature: z.number() })),
  });
}`,
  },
  {
    id: "workers",
    label: "Workers",
    title: "Move work beyond the request.",
    description: "Declare typed jobs with retry policies. Publish individually or in batches, and run workers separately or through the shared background runtime.",
    guide: "/docs/usage/workers",
    guideLabel: "Worker guide",
    file: "greeting_worker.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { defineWorker } from '@kestreljs/framework/workers';

export const printGreeting = defineWorker({
  name: 'greeting.print',
  queue: 'greetings',
  input: z.object({ name: z.string() }),
  maxAttempts: 3,
  retryDelayMs: 1_000,
  handler: async (job, _deps, { signal }) => {
    // Honor cooperative cancellation before an effect.
    signal.throwIfAborted();
    console.log('Hello, ' + job.payload.name + '!');
  },
});`,
  },
  {
    id: "workflows",
    label: "Durable workflows",
    title: "Wait, resume, and keep the history.",
    description: "Coordinate actions and durable timers with PostgreSQL persistence. Resume after process restarts and reuse recorded activity outcomes during replay.",
    guide: "/docs/usage/workflows",
    guideLabel: "Workflow guide",
    file: "welcome_workflow.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { defineAction } from '@kestreljs/framework/actions';
import { defineWorkflow } from '@kestreljs/framework/workflows';

export const greet = defineAction({
  name: 'greeting.prepare', input: z.string(), output: z.string(),
  handler: (name) => 'Hello, ' + name + '!',
});
export const welcome = defineWorkflow({
  name: 'onboarding.welcome',
  version: { current: 1, supportedFrom: 1 },
  input: z.string(), output: z.string(),
  handler: async (name, workflow) => {
    // The timer is persisted instead of holding a request open.
    await workflow.sleep({ minutes: 5 });
    return workflow.run(greet, name);
  },
});`,
  },
  {
    id: "email",
    label: "Email",
    title: "Compose once. Choose delivery.",
    description: "Send text, HTML, and attachments through a shared email API. Capture messages locally during development, then select SMTP or SES for delivery.",
    guide: "/docs/usage/email",
    guideLabel: "Email guide",
    file: "welcome_email.ts",
    language: "typescript",
    code: `import { EmailClient, MemoryEmailAdapter } from '@kestreljs/framework/email';

// Test transport: no email leaves the process.
const email = new EmailClient({
  name: 'transactional', driver: new MemoryEmailAdapter(),
});
try {
  await email.send({
    from: 'hello@example.com',
    to: 'member@example.com',
    subject: 'Welcome aboard',
    text: 'Your account is ready.',
  }, { operation: 'member.welcome' });
} finally {
  await email.close();
}`,
  },
  {
    id: "cache",
    label: "Cache",
    title: "Reuse the result, not the work.",
    description: "Load on cache misses, set explicit TTLs, and coalesce concurrent loads within a process. Choose memory, PostgreSQL, or Redis behind the same cache facade.",
    guide: "/docs/usage/cache",
    guideLabel: "Cache guide",
    file: "cached_greeting.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import { defineAction } from '@kestreljs/framework/actions';
import { cacheDependency } from '@kestreljs/framework/cache';

export const cachedGreeting = defineAction({
  name: 'greeting.cached',
  input: z.object({ name: z.string() }),
  output: z.string(),
  dependencies: { cache: cacheDependency },
  handler: ({ name }, { cache }) => cache.remember(
    'greeting:' + name,
    // Only load when there is no reusable cached value.
    async () => 'Hello, ' + name + '!',
    { ttlSeconds: 30 },
  ),
});`,
  },
  {
    id: "lock",
    label: "Lock",
    title: "Coordinate work on shared resources.",
    description: "Protect named resources with finite leases. Callback APIs renew ownership and release leases when the protected operation completes.",
    guide: "/docs/usage/lock",
    guideLabel: "Lock guide",
    file: "report_lock.ts",
    language: "typescript",
    code: `import type { Locks } from '@kestreljs/framework/lock';

export async function generateReport(
  locks: Locks,
  write: (token: bigint, signal: AbortSignal) => Promise<void>,
) {
  return locks.runExclusive('report:daily', async (lock, { signal }) => {
    // Forward cancellation; the destination enforces fencing.
    await write(lock.fencingToken, signal);
  }, {
    ttlMs: 30_000,
    waitTimeoutMs: 5_000,
  });
}`,
  },
  {
    id: "tokens",
    label: "Tokens",
    title: "Typed capabilities with a lifecycle.",
    description: "Issue invitations and verification links with typed payloads. Stored tokens support expiry, revocation, and atomic single-use consumption.",
    guide: "/docs/usage/tokens",
    guideLabel: "Token guide",
    file: "invitation_token.ts",
    language: "typescript",
    code: `import { z } from 'zod';
import {
  defineToken, MemoryTokenStorageAdapter,
  StoredTokenStrategy, TokenManager,
} from '@kestreljs/framework/tokens';

const invitation = defineToken({
  name: 'member.invitation',
  payload: z.object({ memberId: z.string() }),
  usage: 'single',
});
const tokens = new TokenManager({
  stored: new StoredTokenStrategy(new MemoryTokenStorageAdapter(), { tokenBytes: 32 }),
}, { maxPayloadBytes: 4_096 });
const grant = await tokens.issue(invitation, { memberId: 'member-1' }, { ttlSeconds: 900 });

// Deliver only to the intended bearer; never log the token.
const payload = await tokens.consume(invitation, grant.token);
if (payload === undefined) throw new Error('Invalid invitation.');`,
  },
];
