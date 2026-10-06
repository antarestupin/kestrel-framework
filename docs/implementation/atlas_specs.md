# Atlas

[Documentation](../README.md) · [Implementation index](./README.md)

> Historical design sketches. Examples here are illustrative; use the [Atlas usage guide](../usage/atlas.md) for the implemented API.

## Goal

The goal is to add to Kestrel the capacity to build internal websites (operations portals, CRM, HR management…) in a process that is:
- Fast: everything that can be automatised is; a fully-functional result is available in a few lines of code
- Flexible: progressive customisation is possible, from no code to low code and custom code

This capability will be used to automatically include an Atlas application in an app created with Kestrel, or to build an autonomous website.

## Model

### Source

Interaction sources.

Examples: backend, external API, DB.

### Action

Write interactions with the Source (CRUD or domain-specific).

Examples: create, update, delete, banUser, approveComment.

### Query

Queries to retrieve data from the Source (CRUD or domain-specific).

Examples: getById, list, search, mostLikedComments.

### Component

UI elements that can use other Components, Queries and Actions to display data and interact with the Sources.

Examples: CommentCard, UserHistory, MenuItem, ModerationPage.

### Resource

Higher-level element easing orchestration of Actions, Queries and Components related to a resource. Not mandatory everywhere.

Examples: Comment, User.

The Ressource may guess and automatise CRUD operations and displays on a resource, and take complementary domain-specific queries, actions, view components…

## Speed vs Control spectrum

The goal is to require a little work as possible and allow progressive customisation. Kestrel will use a standard expected behaviour by default.

The level of customisation work can go this way in descending order:
- Automated behaviour
- Dynamically configured behaviour (through the Atlas UI)
- Low code behaviour
- Custom code

Atlas can be configured to use dynamic components that will be displayed in 2 modes:
- Editor mode: so Atlas users with the right access can create and configure them by themselves (e.g. product analytics dashboards)
- Read mode: the actual display expected in Atlas

## Low-code workflow

Dynamic components have their configuration stored in the DB during the edition phase.

When dynamic components are to be displayed (cache is not included in description for simplicity):

- The client fetches needed configuration for display through a call to backend, that retrieves it from DB
- The client requests data to backend, that calls the sources (so credentials stay in backend)
- Components are rendered along the way when they have everything needed (configuration and data)

## Example illustration pieces of code

These examples are not contract, I'm not sure yet of the exact API. They're mostly here to illustrate a few things I have in mind.

Minimal Atlas application with Resources and basic CRUD functionality:

```js
const dataSource = new CatalogSource(appCatalog); // from server/core/appCatalog

const userResource = new Resource()

const atlasApp = new AtlasApp();
atlasApp
  .setDefaultSource(dataSource)
  .addResource(new CatalogResource(appCatalog.user))
  .addResource(new CatalogResource(appCatalog.debate.comment));

export default const App = () => <Atlas app={atlasApp} />;
```

For an Atlas application using an external API:

```js
const dataSource = new ApiSource("https://example.com/api");

const atlasApp = new AtlasApp();
atlasApp
  .setDefaultSource(dataSource)
  .addResource(new ApiResource("user"))
  .addResource(new ApiResource("comment"));

export default const App = () => <Atlas app={atlasApp} />;
```

Menu customization:

```js
// get menu data from configuration
const menuData = getMenuConfig();

// sections can be modified manually
menuData.sections.analytics.register({
  name: "Revenue",
  to: "...",
});

// ...

// Display can be manually defined
<Menu>
  <Section name="Analytics">
    <Item name="Sales" to="..." />
    <RemainingItems section={menuData.sections.analytics}> // remaining items in section
  </Section>
  // ...
  <RemainingSections /> // remaining sections, doesn't include "analytics"
</Menu>
```

Manually-defined page with dynamic elements:

```js
<Page>
  <Grid layout="...">
    <SomeCustomComponent /> // defined manually by devs
    <SomeDynamicComponent /> // relying on configuration to know behaviour
  </Grid>
</Page>
```

Automation is assumed by default everywhere, and can be converted from auto to manual easily, using a way to dump any component:
- `<AutoMenu />` is equivalent to `<Menu><RemainingSections /></Menu>`
- `<RemainingSections />` is equivalent to `remainingSections.map(sectionData => <Section ...sectionData />)`
- `<AutoPage />` is equivalent to `<Page><DynamicCanvas /></Page>` where AutoCanvas provides a UI to define the page content
- `<AutoResourceReadPage />` is a more complex example but by default displays a generic UI for given resource, and can be dumped into modifyable code

## Notes

- It must be easy for devs to convert automated components into low-code ones, so they can quickly customize some parts when needed
- The dynamic components' configuration must be exportable so they can be imported in other envs, e.g. local
- There must be ways to extend Kestrel, e.g. to provide specialized components, external data sources…
