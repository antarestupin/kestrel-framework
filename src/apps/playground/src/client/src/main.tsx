// Mounts the starter screen. Replace this component with your application.
import { createRoot } from "react-dom/client";
import "./styles.css";

/** A small welcome screen with the next steps for a new Kestrel application. */
function Application() {
  return (
    <main className="welcome">
      <header className="brand" aria-label="Kestrel">
        <span className="brand-mark" aria-hidden="true">k.</span>
        <span>kestrel</span>
      </header>

      <section className="intro" aria-labelledby="welcome-title">
        <p className="status"><span aria-hidden="true" />Your Kestrel app is running</p>
        <h1 id="welcome-title">A fresh start.<br /><span>Make it yours.</span></h1>
        <p className="description">Welcome to Kestrel. Your next idea starts here.</p>
        <p className="edit-hint">Get started by editing <code>src/client/src/main.tsx</code></p>
      </section>

      <nav className="resources" aria-label="Developer resources">
        {/* Keep the placeholder local until the public documentation is available. */}
        <a className="resource" href="#documentation" aria-describedby="documentation">
          <div className="resource-heading">
            <h2>Documentation</h2>
            <span className="resource-arrow" aria-hidden="true">↗</span>
          </div>
          <p>Get to know the framework.<br />From your first action to your next application.</p>
          <span className="resource-caption" id="documentation">Coming soon</span>
        </a>
        {/* Studio is mounted on the application's origin during local development. */}
        <a className="resource" href="/_studio">
          <div className="resource-heading">
            <h2>Kestrel Studio</h2>
            <span className="resource-arrow" aria-hidden="true">↗</span>
          </div>
          <p>Take a look inside your app.<br />Explore your actions, routes, and database.</p>
          <span className="resource-caption">Open Studio <span aria-hidden="true">→</span></span>
        </a>
      </nav>

      <footer>Small beginnings. Endless possibilities.</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Application />);
