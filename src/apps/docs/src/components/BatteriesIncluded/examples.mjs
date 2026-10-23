// Focused public API recipes: display order matches the homepage tab order.
export const capabilityExamples = [
  {
    id: "actions",
    label: "Actions",
    title: "One action. Every entry point.",
    description: "Define business logic with validated inputs and outputs, typed dependency injection, and reusable middleware. Connect the same action to HTTP or CLI with a single line for each controller.",
    guide: "/docs/usage/actions",
    guideLabel: "Actions guide",
    file: "greet.ts",
    language: "typescript",
    code: `export const greet = defineAction({
  name: 'greeting.greet',
  input: z.object({ name: z.string().trim().min(1) }), // Input and output are validated with Zod
  output: z.string(),                                  // Their types are automatically inferred
  dependencies: { greeting: GreetingService },         // Inject dependencies with DI
  handler: ({ name }, { greeting }) => greeting.greet(name),
});

// Bind the action to external controllers in one line
export const greetHttp = defineActionHttpController(greet, get('/greet')); // HTTP: GET /greet?name=Sam
export const greetCli = defineActionCliController(greet, 'greet');         // CLI: ./do greet --name Sam

// Or call directly from a running app
const greeting = await app.get(greet).run({ name: 'Sam' });`,
  },
  {
    id: "orm",
    label: "ORM",
    title: "Your schema. Typed repositories.",
    description: "Build on PostgreSQL and Drizzle with reusable repositories, database migrations, scoped database managers, and explicit transaction boundaries.",
    guide: "/docs/usage/database#create-a-repository-backed-action",
    guideLabel: "Database guide",
    file: "contact_repository.ts",
    language: "typescript",
    code: `// Define the table schema
export const contact = pgTable('contact', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
});

// Interact with the DB using the repository pattern
const contacts = app.get(ContactRepository);
await contacts.create({ name: 'Sam' });
const foundContact = await contacts.findById(id);

// You can wrap calls in a transaction, with auto commit and roll back.
await databaseManager.transaction(async () => {
  await contacts.create({ name: 'Alex' });
  await contacts.create({ name: 'Jo' });
});`,
  },
  {
    id: "api-client",
    label: "API client",
    title: "Your API. Already typed.",
    description: "Call your own API from any frontend with a client generated from your HTTP controller catalog. Inputs and JSON responses follow your server contracts, without handwritten request URLs or duplicated types.",
    guide: "/docs/usage/client#generate-a-typed-http-client",
    guideLabel: "Generated client guide",
    file: "src/client/src/api.ts",
    language: "typescript",
    code: `// createPublicClient is generated from the application's HTTP controller catalog.
const api = createPublicClient({ baseUrl: 'https://mysite.com' });

// The generated hierarchy mirrors the controller catalog.
const greeting = await api.example.greet({ name: 'Sam' });
`,
  },
  {
    id: "http",
    label: "HTTP client",
    title: "External APIs, with boundaries.",
    description: "Call external APIs with request quotas, a circuit breaker, and validated responses. Bound request duration and response size, and stop admitting calls when the dependency is unhealthy.",
    guide: "/docs/usage/outbound_http",
    guideLabel: "Outbound HTTP guide",
    file: "weather_client.ts",
    language: "typescript",
    code: `// Define a throttling policy to manage degraded service
const weatherPolicy = defineAdmissionPolicy({
  id: 'weather-api',
  limits: [
    rateLimit({ id: 'weather-requests', unit: 'requests', limit: 20, per: seconds(1) }),
    circuitBreaker({ id: 'weather-health', failureThreshold: 5, cooldown: seconds(30) }),
  ],
});

// Initialize the client
const weather = createOutboundHttpClient({
  name: 'weather',
  baseUrl: 'https://weather.example',
  timeoutMs: 5_000,
  middleware: [throttleRequests({ throttling, definition: weatherPolicy })],
});

// Use the client
export async function forecast(city: string) {
  return weather.get('/forecast/:city', {
    path: { city },
    // Optionally validate the response before returning it to callers.
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
    code: `export const printGreeting = defineWorker({
  name: 'greeting.print',
  queue: 'greetings',
  input: z.object({ name: z.string() }),
  maxAttempts: 3,          // Instructions to handle job failure
  retryDelayMs: 1_000,
  handler: async (job) => {
    console.log('Hello, ' + job.payload.name + '!');
  },
});

// Push a job, publisher side
await workers.enqueue(printGreeting, { name: "Sam" });`,
  },
  {
    id: "workflows",
    label: "Durable workflows",
    title: "From checkout to delivery.",
    description: "Reserve stock, wait for payment, ship the order, and request a review seven days later. PostgreSQL persists progress and waits across restarts, while replay reuses recorded activity results.",
    guide: "/docs/usage/workflows",
    guideLabel: "Workflow guide",
    file: "fulfill_order.ts",
    language: "typescript",
    code: `const paymentReceived = defineWorkflowSignal({
  name: 'order.payment-received',
  payload: z.object({ paymentId: z.string() }),
});

export const fulfillOrder = defineWorkflow({
  name: 'order.fulfill',
  version: { current: 1, supportedFrom: 1 },
  input: z.object({ orderId: z.string() }), output: z.void(),
  signals: [paymentReceived],
  handler: async (input, workflow) => {
    // Run business effects as idempotent actions; replay reuses recorded results.
    await workflow.run(reserveStock, input);

    // A payment webhook signals this execution, even after a restart.
    await workflow.waitForSignal(paymentReceived);
    await workflow.run(shipOrder, input);

    // Persist the timer: no process needs to stay alive for seven days.
    await workflow.sleep({ days: 7 });
    await workflow.run(requestReview, input);
  },
});`,
  },
  {
    id: "auth",
    label: "Auth",
    title: "Sessions with explicit boundaries.",
    description: "Once session middleware resolves authentication, inject your application user directly into actions and controllers. Kestrel loads it on demand and shares it throughout the execution.",
    guide: "/docs/usage/authentication",
    guideLabel: "Authentication guide",
    file: "protected_action.ts",
    language: "typescript",
    code: `export const welcomeBack = defineAction({
  // ...
  dependencies: { user: currentUser<User>() },
  // The user is already loaded and typed when the handler runs.
  handler: (_input, { user }) => ({ message: 'Welcome back, ' + user.name + '.' }),
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
    code: `export async function generateReport() {
  return locks.runExclusive('report:daily', async (lock) => {
    // Actual work, executed only once
  }, {
    ttlMs: 30_000,        // lock duration
    waitTimeoutMs: 5_000, // wait for 5s to acquire the lock lease
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
    code: `const invitation = defineToken({
  name: 'member.invitation',
  payload: z.object({ memberId: z.string() }),
  usage: 'single',
});

// Issue a token to share with user
const grant = await tokenManager.issue(invitation, { memberId: 'member-1' }, { ttlSeconds: 900 });

// Fetch safe data from given token
const payload = await tokenManager.consume(invitation, token);`,
  },
];
