// Deployment settings belong to this application, never to framework libraries.
const url = process.env.DOCS_URL || 'https://antarestupin.github.io';
const baseUrl = process.env.DOCS_BASE_URL || '/kestrel-framework/';

export default {
  title: 'Kestrel',
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
      items: [
        { type: 'doc', docId: 'usage/installation', label: 'Get started', position: 'left' },
        { type: 'docSidebar', sidebarId: 'guides', label: 'Guides', position: 'left' },
        { type: 'docSidebar', sidebarId: 'advanced', label: 'Advanced', position: 'left' },
        { to: '/search', label: 'Search', position: 'right' },
        { href: 'https://github.com/antarestupin/kestrel-framework', label: 'GitHub', position: 'right' },
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
