import { terracottaTheme } from "./src/prismThemes.js";

// Deployment settings belong to this application, never to framework libraries.
const url = process.env.DOCS_URL || 'https://antarestupin.github.io';
const baseUrl = process.env.DOCS_BASE_URL || '/kestrel-framework/';

// Inline SVG replaces the theme's external-link glyph and follows the link color.
const githubLinkContent = '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>GitHub';

export default {
  title: 'Kestrel',
  favicon: 'img/favicon.png',
  tagline: 'Compose your application. Keep control of its behavior.',
  url,
  baseUrl,
  trailingSlash: true,
  organizationName: 'antarestupin',
  projectName: 'kestrel-framework',
  onBrokenLinks: 'throw',
  // Existing Markdown stays readable on GitHub; only .mdx opts into JSX.
  markdown: { format: 'detect', mermaid: true, hooks: { onBrokenMarkdownLinks: 'throw' } },
  themes: ['@docusaurus/theme-mermaid'],
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [['classic', {
    docs: {
      // Shared guides remain at the repository root, outside the source workspaces.
      path: '../../../docs',
      routeBasePath: 'docs',
      sidebarPath: './sidebars.js',
      editUrl: 'https://github.com/antarestupin/kestrel-framework/edit/main/docs/',
    },
    blog: false,
    theme: { customCss: './src/css/custom.css' },
  }]],
  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Kestrel',
      // Pair the standalone mark with the navbar title; the homepage keeps the full wordmark.
      logo: { alt: '', src: 'img/kestrel-mark.png', width: 32, height: 32 },
      items: [
        { type: 'doc', docId: 'usage/installation', label: 'Get started', position: 'left' },
        { type: 'docSidebar', sidebarId: 'guides', label: 'Guides', position: 'left' },
        { type: 'docSidebar', sidebarId: 'advanced', label: 'Advanced', position: 'left' },
        { href: 'https://github.com/antarestupin/kestrel-framework', html: githubLinkContent, className: 'kestrel-github-link', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [{ title: 'Learn', items: [
        { label: 'Get started', to: '/docs/usage/installation' },
        { label: 'Guides', to: '/docs/usage/' },
        { label: 'Advanced', to: '/docs/implementation/' },
      ] }],
      copyright: 'Kestrel — a modular application framework.',
    },
    prism: {
      // Keep code blocks dark in both page modes, with the same earth-tone token roles.
      theme: terracottaTheme,
      darkTheme: terracottaTheme,
      additionalLanguages: ['bash', 'typescript', 'sql', 'json'],
      magicComments: [
        // Keep highlighting first: Docusaurus uses it for metastring line ranges.
        {
          className: 'theme-code-block-highlighted-line',
          line: 'highlight-next-line',
          block: { start: 'highlight-start', end: 'highlight-end' },
        },
        {
          className: 'kestrel-code-hidden-line',
          block: { start: 'hide-start', end: 'hide-end' },
        },
      ],
    },
  },
};
