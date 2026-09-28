# Kestrel documentation website

This private workspace renders the canonical Markdown in `../../docs` with Docusaurus. Do not copy guides into this application. The home page and search interface live in `src/pages`; navigation lives in `sidebars.js`.

From the repository root, install with `npm ci`, then run:

```sh
npm run docs:dev
npm run docs:build
npm run docs:preview
```

Development and preview commands are for manual browsing. Automated verification uses the production build without starting an HTTP server. The build checks internal links and generates a local Pagefind search index. Search is available in the production preview, not the development server. Mermaid diagrams render in the browser.

The root package overrides pin patched transitive dependencies used by the documentation toolchain: `lodash-es`, `serialize-javascript` in webpack copy/CSS plugins, and the CommonJS-compatible `uuid` 11 line in SockJS. The initial script-disabled temporary lockfile audit reported no vulnerabilities after these corrections. Docusaurus core is also declared as a root development dependency because npm 11.9 drops overrides across workspace links ([npm issue #9659](https://github.com/npm/cli/issues/9659)); keep its version aligned with this workspace. Remove this workaround when the supported npm version propagates overrides correctly, and remove the overrides when upstream dependency ranges include the fixes.

## Publishing

Documentation builds and publication in GitHub Actions are paused. The workflow is preserved as `.github/workflows/docs.yml.disabled`, which GitHub Actions does not load. The root `build:ai` command also excludes the documentation so the validation and package archive jobs do not build the site indirectly. Use `npm run docs:build` to build it locally.

When publication is approved, rename `.github/workflows/docs.yml.disabled` to `.github/workflows/docs.yml`. The restored workflow builds pull requests and deploys pushes to `main`; it does not require adding the documentation back to the root build. In the GitHub repository settings, select **Pages → Build and deployment → Source → GitHub Actions** before the first deployment. The default address is `https://antarestupin.github.io/kestrel-framework/`.

For a custom domain, configure the domain and DNS in GitHub Pages, set the repository variable `DOCS_URL` to the origin (for example `https://docs.example.com`) and `DOCS_BASE_URL` to `/`, then rebuild. These variables can also be supplied locally. Always include the leading and trailing slashes in the base path. No search credentials or backend are needed.

## Authoring and future versions

Use plain Markdown in `docs/**/*.md`; `.mdx` explicitly enables JSX. Keep relative Markdown links so the same content works on GitHub and on the site. Add new pages to `sidebars.js`. Usage and implementation pages should continue linking to one another. Keep design records clearly marked as proposals or historical references.

Versioning is intentionally deferred. When supported framework releases need distinct documentation, run `npm run docs:version --workspace=@kestrel/docs -- <version>`, commit the generated version snapshots and metadata in this workspace, and add Docusaurus's `docsVersionDropdown` navbar item. Review homepage links and Pagefind version filtering at that point; search currently indexes every documentation page. Do not take snapshots for every development change.

Further work: richer homepage illustrations and Studio screenshots, a complete first-application tutorial, and generated API references derived from framework contracts.
