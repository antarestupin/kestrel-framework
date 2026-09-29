import React, { useEffect, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import Head from '@docusaurus/Head';
import useBaseUrl from '@docusaurus/useBaseUrl';

export default function Search() {
  const container = useRef(null);
  const [failed, setFailed] = useState(false);
  const bundle = useBaseUrl('/pagefind/');
  useEffect(() => {
    // Load the generated UI only in the browser and dispose it on SPA navigation.
    let disposed = false;
    let ui;
    const script = document.createElement('script');
    script.src = `${bundle}pagefind-ui.js`;
    script.onload = () => {
      if (!disposed) ui = new window.PagefindUI({ element: container.current, bundlePath: bundle, showSubResults: true });
    };
    script.onerror = () => { if (!disposed) setFailed(true); };
    document.body.appendChild(script);
    return () => { disposed = true; ui?.destroy(); script.remove(); };
  }, [bundle]);
  return <Layout title="Search" description="Search the Kestrel guides and advanced documentation.">
    <Head><link rel="stylesheet" href={`${bundle}pagefind-ui.css`} /></Head>
    <main className="container margin-vert--xl kestrel-search">
      <h1>Search the documentation</h1>
      <p>Find usage guides, implementation references, and design records.</p>
      {failed && <p role="alert">Search is unavailable. For local development, build the site and use the preview command.</p>}
      <div ref={container} />
    </main>
  </Layout>;
}
