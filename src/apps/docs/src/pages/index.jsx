import React, { useEffect, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import ThemedImage from '@theme/ThemedImage';
import '../css/home.css';
import BatteriesIncluded from '../components/BatteriesIncluded';

// Three complementary pillars separate application structure, runtime speed, and developer feedback.
const highlights = [
  {
    iconPath: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    title: 'Designed to grow',
    features: [
      { title: 'Clean by design', text: 'Keep concerns separate with dependency injection, reusable actions, and modular composition.' },
      { title: 'Types throughout', text: 'Connect inputs, outputs, and dependencies with inferred TypeScript types and Zod runtime validation.' },
    ],
  },
  {
    iconPath: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z',
    title: 'Fast at the core',
    features: [
      { title: 'Built on Fastify', text: 'Put a high-performance HTTP server at the heart of your application.' },
      { title: 'Caching included', text: 'Reuse expensive reads with explicit TTLs and your choice of memory, PostgreSQL, or Redis.' },
    ],
  },
  {
    // Both arcs follow the same rotation and meet their arrowheads.
    iconPath: 'M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5',
    title: 'A fast development loop',
    features: [
      { title: 'Thousands of tests in seconds', text: 'Use Vitest and Fastify injection for fast feedback, without starting an HTTP server.' },
      { title: 'Powered by Vite', text: 'See frontend changes with hot module replacement, then build your browser assets for production.' },
    ],
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
  const logoSources = { light: useBaseUrl('img/kestrel-logo.svg'), dark: useBaseUrl('img/kestrel-logo-dark.svg') };
  return (
    <Layout title="Build with Kestrel" description="A TypeScript framework built on Fastify, with Zod contracts, integrated caching, Studio, Atlas, durable workflows, and generated HTTP clients.">
      <main className="kestrel-home">
        <header className="container kestrel-hero">
          <div className="kestrel-hero-copy">
            <div className="kestrel-hero-logo"><ThemedImage sources={logoSources} alt="Kestrel" width="112" height="112" /></div>
            <p className="kestrel-eyebrow">THE TYPESCRIPT WEB APPLICATION FRAMEWORK</p>
            <h1>From idea to running app.<br /><span>Built clean. Built fast.</span></h1>
            <p className="kestrel-lead">Ship web apps that scale at speed with a batteries-included framework.</p>
            <div className="kestrel-actions">
              <Link className="button button--primary button--lg" to="/docs/usage/installation">Start building <span aria-hidden="true">↗</span></Link>
              <a className="kestrel-text-link" href="#developer-tools">Meet your toolkit <span aria-hidden="true">↓</span></a>
            </div>
            <InstallCommand />
            <p className="kestrel-status">Current status: experimental and under active development.</p>
          </div>
        </header>

        <BatteriesIncluded />

        {/* Frontend choices share a generated transport instead of depending on a UI framework. */}
        <section className="container kestrel-section kestrel-frontend" aria-labelledby="frontend-title">
          <div className="kestrel-frontend-copy">
            <h2 id="frontend-title">Your frontend.<br /><span>Your choice.</span></h2>
            <p>Build with React, Vue, Svelte, or your preferred framework. Kestrel keeps your UI independent.</p>
            <p>A generated HTTP client connects your frontend to your server contracts, with typed inputs and responses.</p>
            <Link className="kestrel-text-link" to="/docs/usage/client">Connect your frontend <span aria-hidden="true">↗</span></Link>
          </div>
          <div className="kestrel-frontend-diagram" role="group" aria-label="Kestrel connects to React, Vue, Svelte, or your choice through a generated HTTP client">
            <div className="kestrel-frontend-source"><ThemedImage sources={logoSources} alt="Kestrel" width="80" height="80" /></div>
            <div className="kestrel-frontend-bridge">Generated HTTP client<span>Typed inputs & responses</span></div>
            {/* Named framework tiles illustrate choice; starter presets will be introduced separately. */}
            <ul className="kestrel-frontend-choices">
              <li><svg className="kestrel-framework-mark kestrel-framework-mark--react" viewBox="-12 -12 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle r="1.8" fill="currentColor" stroke="none" /><ellipse rx="11" ry="4.2" /><ellipse rx="11" ry="4.2" transform="rotate(60)" /><ellipse rx="11" ry="4.2" transform="rotate(120)" /></svg>React</li>
              <li><svg className="kestrel-framework-mark" viewBox="0 0 32 28" aria-hidden="true"><path fill="#42b883" d="M0 0h6.4L16 16.6 25.6 0H32L16 28Z" /><path fill="#35495e" d="M6.4 0h6L16 6.2 19.6 0h6L16 16.6Z" /></svg>Vue</li>
              <li><svg className="kestrel-framework-mark" viewBox="0 0 98.1 118" aria-hidden="true"><path d="m91.8 15.6c-10.9-15.7-32.6-20.3-48.2-10.4l-27.5 17.6c-7.5 4.7-12.7 12.4-14.2 21.1-1.3 7.3-.2 14.8 3.3 21.3-2.4 3.6-4 7.6-4.7 11.8-1.6 8.9.5 18.1 5.7 25.4 11 15.7 32.6 20.3 48.2 10.4l27.5-17.5c7.5-4.7 12.7-12.4 14.2-21.1 1.3-7.3.2-14.8-3.3-21.3 2.4-3.6 4-7.6 4.7-11.8 1.7-9-.4-18.2-5.7-25.5" fill="#ff3e00" /><path d="m40.9 103.9c-8.9 2.3-18.2-1.2-23.4-8.7-3.2-4.4-4.4-9.9-3.5-15.3.2-.9.4-1.7.6-2.6l.5-1.6 1.4 1c3.3 2.4 6.9 4.2 10.8 5.4l1 .3-.1 1c-.1 1.4.3 2.9 1.1 4.1 1.6 2.3 4.4 3.4 7.1 2.7.6-.2 1.2-.4 1.7-.7l27.4-17.5c1.4-.9 2.3-2.2 2.6-3.8s-.1-3.3-1-4.6c-1.6-2.3-4.4-3.3-7.1-2.6-.6.2-1.2.4-1.7.7l-10.5 6.7c-1.7 1.1-3.6 1.9-5.6 2.4-8.9 2.3-18.2-1.2-23.4-8.7-3.1-4.4-4.4-9.9-3.4-15.3.9-5.2 4.1-9.9 8.6-12.7l27.5-17.5c1.7-1.1 3.6-1.9 5.6-2.5 8.9-2.3 18.2 1.2 23.4 8.7 3.2 4.4 4.4 9.9 3.5 15.3-.2.9-.4 1.7-.7 2.6l-.5 1.6-1.4-1c-3.3-2.4-6.9-4.2-10.8-5.4l-1-.3.1-1c.1-1.4-.3-2.9-1.1-4.1-1.6-2.3-4.4-3.3-7.1-2.6-.6.2-1.2.4-1.7.7l-27.4 17.5c-1.4.9-2.3 2.2-2.6 3.8s.1 3.3 1 4.6c1.6 2.3 4.4 3.3 7.1 2.6.6-.2 1.2-.4 1.7-.7l10.5-6.7c1.7-1.1 3.6-1.9 5.6-2.5 8.9-2.3 18.2 1.2 23.4 8.7 3.2 4.4 4.4 9.9 3.5 15.3-.9 5.2-4.1 9.9-8.6 12.7l-27.5 17.5c-1.7 1.1-3.6 1.9-5.6 2.5" fill="#fff" /></svg>Svelte</li>
              <li><svg className="kestrel-framework-mark kestrel-framework-mark--custom" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 9-7 7 7 7m12-14 7 7-7 7M19 5l-6 22" /></svg>Your choice</li>
            </ul>
          </div>
        </section>

        <section id="developer-tools" className="container kestrel-section kestrel-product-section" aria-labelledby="studio-title">
          <div className="kestrel-product-card">
            <div className="kestrel-product-copy">
              <h2 id="studio-title">Explore. Inspect. Debug.<br /><span>At ease with Studio.</span></h2>
              <p>Follow a request from input to execution trace, with your local tools in one workspace.</p>
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
              <h2 id="atlas-title">Your backoffice, already within reach.<br /><span>Meet Atlas.</span></h2>
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

        {/* Three balanced cards distinguish architecture, runtime performance, and development speed. */}
        <section className="container kestrel-highlights" aria-label="Built for growing applications">
          {highlights.map((highlight, i) => (
            <article key={i}>
              {/* Large decorative SVGs give each pillar a distinct visual anchor. */}
              <div className="kestrel-highlight-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={highlight.iconPath} /></svg>
              </div>
              <h2>{highlight.title}</h2>
              <ul className="kestrel-highlight-features">
                {highlight.features.map((feature) => <li key={feature.title}><strong>{feature.title}.</strong> {feature.text}</li>)}
              </ul>
            </article>
          ))}
        </section>

        <section className="container kestrel-closing" aria-labelledby="start-title">
          <h2 id="start-title">Your next idea starts here.<br /><span>Build on Kestrel.</span></h2>
          <div className="kestrel-actions"><Link className="button button--primary button--lg" to="/docs/usage/installation">Create your application ↗</Link><Link className="kestrel-text-link" to="/docs/usage/">Read the guides →</Link></div><p className="kestrel-status">Kestrel is experimental. Explore the guides and evaluate it for your project.</p>
        </section>
      </main>
    </Layout>
  );
}
