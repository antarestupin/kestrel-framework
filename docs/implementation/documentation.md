# Documentation website internals

[Authoring hidden code sections](../contributing.md#focus-code-examples-with-hidden-lines) · [Implementation index](README.md)

The private Docusaurus workspace in `src/apps/docs` renders the canonical Markdown under `docs`. Its Prism configuration registers `hide-start` / `hide-end` as the `kestrel-code-hidden-line` class, preserving the default highlighting directive as the first entry. Docusaurus removes recognized magic comments before tokenization and copying.

## Branding assets

The supplied logo and icon live in `src/apps/docs/static/img/`. Docusaurus resolves the favicon and navbar logo against its configured deployment base; the homepage uses `useBaseUrl` for the same reason. The logo includes a black wordmark, so its light surface stays visible in both themes. The starter owns a copy of the icon at `public/favicon.png`; generated applications can replace it without changing framework configuration. Production Vite configuration explicitly shares the project-root public directory with the development graph. The documentation palette uses terracotta derived from the logo, with darker link and button colors on white surfaces and lighter accents on warm charcoal in dark mode. The light theme uses white page, navigation, and surface backgrounds without a homepage gradient. Shared Infima tokens also color navigation, search results, and code highlights; primary buttons retain explicit contrasting text in both themes. Automatic icon variants and theme-specific artwork remain deferred.

## Syntax colors

`src/apps/docs/src/prismThemes.js` defines a shared Prism theme for both page modes without an additional dependency. It uses terracotta keywords, olive strings, ochre functions, plum literals, and slate types and properties. Code blocks keep a warm charcoal background in both light and dark page modes. Comments and punctuation use quieter neutral colors. Docusaurus applies this theme to the homepage and Markdown code fences through `themeConfig.prism`; line highlighting and folding keep their existing behavior. Token colors target at least 4.5:1 contrast against their normal block background. Language-specific token refinements remain deferred.

## Code block disclosure

When a hidden section starts at the first code line or forms a suffix at the end of the block, the layout also marks exposed blank separators at that boundary as hidden. Trailing blank lines after the final end marker are included when a hidden suffix is present. This affects presentation and the disclosure count only: source text, copied code, expanded spacing, and interior blank lines remain unchanged.

Three small theme overrides compose the original components. `CodeBlock/Layout` owns disclosure state and counts marked lines from Docusaurus metadata. `CodeBlock/Buttons` adds a native button with `aria-expanded` and `aria-controls`, alongside the original copy and word-wrap controls. Blocks without hidden lines use the original layout and buttons.

The layout preserves native code block spacing; the controls overlay the top-right corner like the standard Docusaurus toolbar, without adding top padding. CSS folds marked lines only after hydration; server-rendered HTML remains complete for readers without JavaScript. Print styles reveal all sections and omit the controls. The copy control retains Docusaurus's complete, marker-free code string regardless of disclosure state. Word wrapping remains available on foldable blocks because revealing a section can introduce overflow.

`CodeBlock/Line` preserves the original token rendering and pins the CSS counter to the line's position in the complete example, including custom starting numbers. The layout gives each line a distinct class array and maps that array to its number; Docusaurus passes the array to the line component. This prevents collapsed rows from renumbering visible code. These overrides depend on the Docusaurus code block context and line props; review them when upgrading Docusaurus.

## Verification and deferred work

Each user-triggered expansion applies a two-second CSS background animation to revealed lines, including folded separators. The primary-color tint fades back to the normal background or the permanent highlight color. Removing the expanded state removes the animation, so subsequent expansions replay it. Reduced-motion preferences use a fixed tint for two seconds followed by an immediate return to the original background. Printing and initial server rendering do not animate; no timer or additional dependency is needed.

Run `npm run test:ai` and `npm run docs:build`. When changing the theme or upgrading Docusaurus, verify folding multiple sections, independent blocks, copying the full example in both states, line numbering, highlighting, word wrap, keyboard access, narrow screens, dark mode, printing, and pages without JavaScript. Automated browser checks can intercept requests and serve build artifacts directly without starting an HTTP server.

Independent toggles for individual sections, remembered disclosure preferences, validation of unmatched or nested markers, and support for combining numeric highlight ranges with magic comments are deferred. Prefer paired, non-nested sections and comment-based highlighting with the current native parser.
