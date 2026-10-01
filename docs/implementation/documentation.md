# Documentation website internals

[Authoring hidden code sections](../contributing.md#focus-code-examples-with-hidden-lines) · [Implementation index](README.md)

The private Docusaurus workspace in `src/apps/docs` renders the canonical Markdown under `docs`. Its Prism configuration registers `hide-start` / `hide-end` as the `kestrel-code-hidden-line` class, preserving the default highlighting directive as the first entry. Docusaurus removes recognized magic comments before tokenization and copying.

## Code block disclosure

When a hidden section starts at the first code line or forms a suffix at the end of the block, the layout also marks exposed blank separators at that boundary as hidden. Trailing blank lines after the final end marker are included when a hidden suffix is present. This affects presentation and the disclosure count only: source text, copied code, expanded spacing, and interior blank lines remain unchanged.

Three small theme overrides compose the original components. `CodeBlock/Layout` owns disclosure state and counts marked lines from Docusaurus metadata. `CodeBlock/Buttons` adds a native button with `aria-expanded` and `aria-controls`, alongside the original copy and word-wrap controls. Blocks without hidden lines use the original layout and buttons.

The layout preserves native code block spacing; the controls overlay the top-right corner like the standard Docusaurus toolbar, without adding top padding. CSS folds marked lines only after hydration; server-rendered HTML remains complete for readers without JavaScript. Print styles reveal all sections and omit the controls. The copy control retains Docusaurus's complete, marker-free code string regardless of disclosure state. Word wrapping remains available on foldable blocks because revealing a section can introduce overflow.

`CodeBlock/Line` preserves the original token rendering and pins the CSS counter to the line's position in the complete example, including custom starting numbers. The layout gives each line a distinct class array and maps that array to its number; Docusaurus passes the array to the line component. This prevents collapsed rows from renumbering visible code. These overrides depend on the Docusaurus code block context and line props; review them when upgrading Docusaurus.

## Verification and deferred work

Each user-triggered expansion applies a two-second CSS background animation to revealed lines, including folded separators. The primary-color tint fades back to the normal background or the permanent highlight color. Removing the expanded state removes the animation, so subsequent expansions replay it. Reduced-motion preferences use a fixed tint for two seconds followed by an immediate return to the original background. Printing and initial server rendering do not animate; no timer or additional dependency is needed.

Run `npm run test:ai` and `npm run docs:build`. When changing the theme or upgrading Docusaurus, verify folding multiple sections, independent blocks, copying the full example in both states, line numbering, highlighting, word wrap, keyboard access, narrow screens, dark mode, printing, and pages without JavaScript. Automated browser checks can intercept requests and serve build artifacts directly without starting an HTTP server.

Independent toggles for individual sections, remembered disclosure preferences, validation of unmatched or nested markers, and support for combining numeric highlight ranges with magic comments are deferred. Prefer paired, non-nested sections and comment-based highlighting with the current native parser.
