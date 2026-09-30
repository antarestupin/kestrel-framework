# Events

[Usage index](./README.md) · [Implementation and scope ownership](../implementation/events.md)

Use events for validated, in-process notifications. Use [workers](./workers.md) when delivery must survive a process restart.

## Declare an event and listen in an application

Use an in-process event when local components should react to a notification without being called directly by its producer. This example validates a member-created payload and handles it synchronously.

```ts
import { z } from "zod";
import { App } from "@kestreljs/framework/app";
import { defineEvent } from "@kestreljs/framework/events";

const memberCreated = defineEvent({
  name: "member.created", schema: z.object({ memberId: z.string() }),
});
const app = new App({});
const stopListening = app.eventBus.listen(memberCreated, ({ memberId }) => {
  console.log("Member created", memberId);
});
app.eventBus.dispatch(memberCreated, { memberId: "member-1" });
// Remove the registration when this owner no longer needs notifications.
stopListening();
```

`listen` callbacks must be synchronous. Dispatch validates the payload, invokes listeners in registration order and rethrows synchronous failures. Use `listenOnce` for a one-time listener and `waitFor` to await the next dispatch; neither replays past events.

## Await asynchronous listeners

Use asynchronous listeners when reactions perform awaited work, such as updating another local component. Drain them before the owner releases resources they may still need.

```ts
const stopAsync = app.eventBus.listenAsync(memberCreated, async ({ memberId }) => {
  await Promise.resolve(memberId);
});
app.eventBus.dispatch(memberCreated, { memberId: "member-2" });
// Dispatch is synchronous; wait explicitly for asynchronous listeners to finish.
await app.eventBus.wait();
stopAsync();
await app.dispose();
```

Async listeners run concurrently and are owned by the dispatching scope's deferred tasks. `wait()` drains them and propagates collected failures. Application lifecycle boundaries drain their own tasks before releasing resources.

## Emit from an action and observe descendant scopes

Inject the scoped bus when a business action publishes events. An application-level listener can opt into descendant scopes to observe notifications from individual executions.

```ts
import { defineAction } from "@kestreljs/framework/actions";
import { eventBusDependency } from "@kestreljs/framework/events";

const notifyCreated = defineAction({
  name: "member.notify-created", input: z.object({ memberId: z.string() }),
  output: z.void(), dependencies: { events: eventBusDependency },
  handler: (input, { events }) => { events.dispatch(memberCreated, input); },
});
function observeMemberEvents(application: App<{}>) {
  // Observe descendant execution scopes and return the removal function for cleanup.
  return application.eventBus.listen(memberCreated, (payload, context) => {
    console.log(context.scope.id, payload.memberId);
  }, { scope: "descendants" });
}
```

Listeners observe their exact scope by default; root listeners must opt into descendants to see execution events. Sibling executions remain isolated. A listener registration can return its removal function to its owner for cleanup. Provider boot order, rather than concurrent lifecycle listeners, should express infrastructure dependencies.

## Use cases still to document

- Wait for a one-off event and clean up listeners when their owner finishes.
- Dispatch across nested scopes and demonstrate listener ownership.
- Handle synchronous and asynchronous listener failures.
