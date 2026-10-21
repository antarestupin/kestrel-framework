import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import ThemedImage from '@theme/ThemedImage';
import '../css/home.css';
import BatteriesIncluded from '../components/BatteriesIncluded';

// Pair short introductions with scannable feature lists; capability tabs provide code recipes.
const highlights = [
  {
    category: 'ARCHITECTURE', symbol: '{}', title: 'Designed to grow',
    text: 'Keep your application understandable as features, integrations, and teams grow.',
    features: [
      { title: 'Explicit dependencies', text: 'Inject services, configuration, and other actions, with clear resource lifetimes.' },
      { title: 'Typed contracts', text: 'Connect Zod runtime validation with inferred TypeScript inputs and outputs.' },
      { title: 'Reusable behavior', text: 'Share actions across HTTP, CLI, and background work without duplicating business logic.' },
      { title: 'Modular composition', text: 'Organize feature catalogs and choose providers and adapters at the application boundary.' },
    ],
    to: '/docs/usage/di', link: 'Explore the architecture',
  },
  {
    category: 'PERFORMANCE', symbol: '↗', title: 'A fast development loop',
    text: 'Move quickly from implementation to feedback, with familiar tools at each layer.',
    features: [
      { title: 'Fastify at the core', text: 'Build your HTTP application on a server designed for speed.' },
      { title: 'Fast tests with Vitest', text: 'Run actions and exercise real routing through Fastify injection, without a listening server.' },
      { title: 'Vite integration', text: 'Use hot module replacement locally and Vite builds for production browser assets.' },
      { title: 'Integrated caching', text: 'Reuse expensive reads with explicit TTLs and memory, PostgreSQL, or Redis adapters.' },
    ],
    to: '/docs/usage/testing', link: 'See how testing works',
  },
  {
    category: 'FRONTEND', symbol: '<>', title: 'Your frontend, your choice',
    text: 'Keep your UI independent while connecting it to explicit server contracts.',
    features: [
      { title: 'Framework agnostic', text: 'Use React, Vue, Svelte, or another frontend with its own Vite plugins.' },
      { title: 'Generated HTTP client', text: 'Generate typed calls from your controller catalog, with inferred inputs and responses.' },
      { title: 'Browser-safe transport', text: 'Call server operations without bundling their server runtime dependencies into the UI.' },
      { title: 'Integrated delivery', text: 'Serve a built SPA alongside your API, with explicit asset paths and route boundaries.' },
    ],
    to: '/docs/usage/client', link: 'Connect your frontend',
  },
  {
    category: 'BACKGROUND', symbol: '↳', title: 'Work beyond the request',
    text: 'Choose the right execution model for jobs, long-running processes, and recurring work.',
    features: [
      { title: 'Typed workers', text: 'Queue individual jobs or batches with validation and configurable retry policies.' },
      { title: 'Durable workflows', text: 'Coordinate activities, signals, and timers with PostgreSQL persistence and replay.' },
      { title: 'Scheduled tasks', text: 'Run recurring maintenance and calendar-based jobs through dedicated schedulers.' },
      { title: 'Coordinated runtimes', text: 'Share startup, supervision, and shutdown, or deploy workloads in separate processes.' },
    ],
    to: '/docs/usage/background', link: 'Explore background work',
  },
];

const installCommand = 'npx @kestreljs/create-kestrel my-app';

/** Copy only the command, with accessible feedback and a cleaned-up confirmation timer. */
function InstallCommand() {
  const [status, setStatus] = useState('idle');
  useEffect(() => {
    if (status !== 'copied') return undefined;
    const timer = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setStatus('copied');
    } catch {
      // Keep the selectable command available when clipboard access is unavailable or denied.
      setStatus('error');
    }
  }

  return (
    <>
      <div className="kestrel-install">
        <span aria-hidden="true">$</span><code>{installCommand}</code>
        <button className="kestrel-copy-command" type="button" onClick={copyCommand} aria-label={status === 'copied' ? 'Command copied' : 'Copy create command'} title={status === 'copied' ? 'Copied!' : 'Copy command'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {status === 'copied' ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>}
          </svg>
        </button>
      </div>
      {/* Successful copying only changes the button icon and label, without adding page content. */}
      {status === 'error' && <p className="kestrel-copy-error" role="status">Clipboard unavailable. Select the command to copy it manually.</p>}
    </>
  );
}

/** Keep screenshots intact and make interface details available at full resolution. */
function ProductScreenshot({ src, alt, width, height }) {
  const url = useBaseUrl(src);
  return (
    <figure className="kestrel-product-shot">
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open full-size image: ${alt}`}>
        <img src={url} alt={alt} width={width} height={height} loading="lazy" decoding="async" />
      </a>
    </figure>
  );
}

export default function Home() {
  const logoSources = { light: useBaseUrl('img/kestrel-logo.png'), dark: useBaseUrl('img/kestrel-logo-dark.png') };
  return (
    <Layout title="Build with Kestrel" description="A TypeScript framework built on Fastify, with Zod contracts, integrated caching, Studio, Atlas, durable workflows, and generated HTTP clients.">
      <main className="kestrel-home">
        <header className="container kestrel-hero">
          <div className="kestrel-hero-copy">
            <div className="kestrel-hero-logo"><ThemedImage sources={logoSources} alt="Kestrel" width="112" height="112" /></div>
            <p className="kestrel-eyebrow">THE TYPESCRIPT APPLICATION FRAMEWORK</p>
            <h1>Build fast. See everything.<br /><span>Keep control.</span></h1>
            <p className="kestrel-lead">Fastify at the core. Zod at the boundaries. A complete toolkit to build, inspect, and run your application.</p>
            <div className="kestrel-actions">
              <Link className="button button--primary button--lg" to="/docs/usage/installation">Start building <span aria-hidden="true">↗</span></Link>
              <a className="kestrel-text-link" href="#developer-tools">Meet your toolkit <span aria-hidden="true">↓</span></a>
            </div>
            <InstallCommand />
            <p className="kestrel-status">Experimental · Available on npm · Explicit, modular composition</p>
          </div>
        </header>

        <BatteriesIncluded />

        <section id="developer-tools" className="container kestrel-section kestrel-product-section" aria-labelledby="studio-title">
          <div className="kestrel-product-card">
            <div className="kestrel-product-copy">
              <p className="kestrel-eyebrow">02 / THE DEVELOPMENT LOOP</p>
              <h2 id="studio-title">Less guessing.<br /><span>Your application, in view.</span></h2>
              <p>Studio brings your local application into focus, from the first request to the execution trace.</p>
              <ul className="kestrel-product-benefits">
                <li><strong>Explore & execute.</strong> Browse actions and controllers, then try requests with reusable examples.</li>
                <li><strong>Follow the execution.</strong> Inspect timelines, observations, and logs in one workspace.</li>
                <li><strong>Keep tools close.</strong> Explore workflows, workers, and captured email alongside your database tools.</li>
              </ul>
              <Link className="kestrel-text-link" to="/docs/usage/studio">Explore Studio <span aria-hidden="true">↗</span></Link>
            </div>
            <ProductScreenshot src="img/studio-http-explorer.png" alt="Studio HTTP explorer showing a controller catalog, a health request response, and an execution timeline." width="2886" height="1752" />
          </div>
        </section>

        <section className="container kestrel-section kestrel-product-section" aria-labelledby="atlas-title">
          <div className="kestrel-product-card kestrel-product-card--reverse">
            <div className="kestrel-product-copy">
              <p className="kestrel-eyebrow">03 / THE ADMINISTRATION LAYER</p>
              <h2 id="atlas-title">Meet Atlas.<br /><span>Your backoffice, assembled.</span></h2>
              <p>Turn selected application operations into an administration interface, without a separate admin build.</p>
              <ul className="kestrel-product-benefits">
                <li><strong>Describe your resources.</strong> Connect operations to collections, forms, relations, and record actions.</li>
                <li><strong>Reuse your business logic.</strong> Choose the operations your bundled interface exposes.</li>
                <li><strong>Own the access rules.</strong> Supply your application's authentication and authorization.</li>
              </ul>
              <Link className="kestrel-text-link" to="/docs/usage/atlas">Build with Atlas <span aria-hidden="true">↗</span></Link>
            </div>
            <ProductScreenshot src="img/atlas-resource-browser.png" alt="Atlas administration interface showing a member collection, search and filter controls, and record actions." width="2868" height="1746" />
          </div>
        </section>

        {/* Four feature summaries follow the Studio and Atlas product showcases. */}
        <section className="container kestrel-highlights" aria-label="Built for growing applications">
          {highlights.map((highlight) => (
            <article key={highlight.category}>
              <div className="kestrel-highlight-label"><span aria-hidden="true">{highlight.symbol}</span>{highlight.category}</div>
              <h2>{highlight.title}</h2>
              <p>{highlight.text}</p>
              <ul className="kestrel-highlight-features">
                {highlight.features.map((feature) => <li key={feature.title}><strong>{feature.title}.</strong> {feature.text}</li>)}
              </ul>
              <Link to={highlight.to}>{highlight.link} <span aria-hidden="true">→</span></Link>
            </article>
          ))}
        </section>

        <section className="container kestrel-closing" aria-labelledby="start-title">
          <p className="kestrel-eyebrow">MAKE IT YOURS</p><h2 id="start-title">Your next application.<br /><span>A clearer starting point.</span></h2><p>Create a project with local Studio, optional Atlas, and your choice of cache backend.</p>
          <div className="kestrel-actions"><Link className="button button--primary button--lg" to="/docs/usage/installation">Create your application ↗</Link><Link className="kestrel-text-link" to="/docs/usage/">Read the guides →</Link></div><p className="kestrel-status">Kestrel is experimental. Explore the guides and evaluate it for your project.</p>
        </section>
      </main>
    </Layout>
  );
}
