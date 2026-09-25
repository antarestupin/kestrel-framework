# Kestrel documentation

Kestrel is the reusable framework in `packages/kestrel/src`. Its documentation has two entry points, with the same library names on both sides.

| Your goal | Start here |
| --- | --- |
| Build an application or find how to do something | [Using Kestrel](./usage/README.md): concise guides and commented code recipes by library. |
| Understand internals, write an adapter or maintain Kestrel | [Understanding and extending Kestrel](./implementation/README.md): architecture, detailed contracts, execution scenarios and design decisions. |

Start with [application composition](./usage/app.md), [configuration](./usage/configuration.md) and [actions](./usage/actions.md), then choose a transport or feature from the usage index. Each usage guide links to its implementation reference, and each reference links back.

Usage guides describe the implemented API in this checkout. Plans and historical specifications are collected under [design records and future work](./implementation/README.md#design-records-and-future-work), with their status stated explicitly. Guarantees and limitations that affect application correctness remain in the usage guides.

For checkout setup and local package consumption, see [installation](./usage/installation.md) and [distribution internals](./implementation/distribution.md).
