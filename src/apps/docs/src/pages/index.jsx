import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';

// Keep the first example aligned with the existing actions guide.
const example = `import { z } from 'zod';
import { defineAction } from '@kestreljs/framework/actions';

export const greet = defineAction({
  name: 'greeting.greet',
  description: 'Create a greeting.',
  input: z.object({ name: z.string() }),
  output: z.string(),
  // Reuse this behavior across your application transports.
  handler: ({ name }) => \`Hello, \${name}!\`,
});`;

export default function Home() {
  return (
    <Layout title="Build with Kestrel" description="A modular TypeScript application framework with reusable actions, explicit configuration, and replaceable infrastructure adapters.">
      <main>
        <header className="kestrel-hero container">
          <div>
            <p className="kestrel-eyebrow">A MODULAR TYPESCRIPT FRAMEWORK</p>
            <h1>Your application.<br />Explicit by design.</h1>
            <p className="kestrel-lead">Compose reusable actions, expose them through multiple transports, and choose the infrastructure your application needs.</p>
            <div className="kestrel-actions">
              <Link className="button button--primary button--lg" to="/docs/usage/installation">Get started</Link>
              <Link className="button button--secondary button--lg" to="/docs/usage/">Explore the guides</Link>
            </div>
            <p className="kestrel-status">Under active development. Packages are currently consumed from local archives.</p>
          </div>
          <div className="kestrel-example"><CodeBlock language="typescript" title="greet.ts">{example}</CodeBlock></div>
        </header>
        <section className="container kestrel-features" aria-label="Explore Kestrel">
          <article><h2>Define behavior once</h2><p>Build validated actions and expose them through HTTP, CLI commands, or background workers.</p><Link to="/docs/usage/actions">Explore actions →</Link></article>
          <article><h2>Compose what you need</h2><p>Connect providers, configuration, and adapters while keeping resource ownership explicit.</p><Link to="/docs/usage/app">Compose an application →</Link></article>
          <article><h2>Understand the details</h2><p>Go from practical recipes to architecture, execution guarantees, and adapter contracts.</p><Link to="/docs/implementation/">Read the advanced documentation →</Link></article>
        </section>
      </main>
    </Layout>
  );
}
