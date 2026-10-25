import React from 'react';
import Layout from '@theme/Layout';
import ContactEmail from '../components/ContactEmail';

// Keep this notice in the site layout so it stays accessible outside the guides.
export default function Legal() {
  return <Layout title="Legal notice & privacy" description="Publisher, hosting, and privacy information for the Kestrel documentation website.">
    <main className="container margin-vert--xl">
      <div className="row">
        <article className="col col--8 col--offset-2 markdown">
          <h1>Legal notice &amp; privacy</h1>

          <h2>Publisher and contact</h2>
          <p>The publisher and publication director is Antarès Tupin, acting as a private individual in a non-professional capacity.</p>
          <p>Contact: <ContactEmail /></p>

          <h2>Hosting</h2>
          <p>This website is hosted on GitHub Pages, provided by GitHub, Inc., 88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, United States. Telephone: <a href="tel:+18774484820">+1 877 448 4820</a>.</p>

          <h2>Personal data</h2>
          <p>GitHub records visitors’ IP addresses for security purposes. Its <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">privacy statement</a> describes its processing, retention, international transfers, and privacy contacts.</p>
          <p>When you email the project, Antarès Tupin uses your email address and message to handle your request, based on the legitimate interest in responding to project inquiries. Correspondence is handled by the publisher through Gmail and kept for the time needed to resolve your request and related follow-up, or to meet legal obligations. The <a href="https://policies.google.com/privacy">Google Privacy Policy</a> describes Gmail’s processing, including transfers outside the European Economic Area.</p>
          <p>For data handled by the publisher, you may request access, correction, deletion, or restriction of processing, and object to processing where applicable, using the contact address above. For GitHub’s processing, use its privacy contacts. You may lodge a complaint with the <a href="https://www.cnil.fr/en">CNIL</a> or your local data protection authority.</p>
        </article>
      </div>
    </main>
  </Layout>;
}
