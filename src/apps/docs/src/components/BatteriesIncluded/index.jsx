import React from 'react';
import Link from '@docusaurus/Link';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import CodeBlock from '@theme/CodeBlock';
import { capabilityExamples } from './examples.mjs';

/** Native Docusaurus tabs retain keyboard navigation and a server-rendered default example. */
export default function BatteriesIncluded() {
  return (
    <section className="container kestrel-section kestrel-batteries" aria-labelledby="batteries-title">
      <div className="kestrel-section-heading">
        <div><p className="kestrel-eyebrow">01 / BATTERIES INCLUDED</p><h2 id="batteries-title">The everyday essentials.<br /><span>Already connected.</span></h2></div>
        <p>From the first validated input to the background job: a shared set of contracts, providers, and tools for the work every application needs.</p>
      </div>
      <div className="kestrel-capability-browser">
        <Tabs defaultValue={capabilityExamples[0].id} className="kestrel-capability-tabs">
          {capabilityExamples.map((example) => (
            <TabItem key={example.id} value={example.id} label={example.label}>
              <div className="kestrel-capability-panel">
                <div className="kestrel-capability-copy">
                  <p className="kestrel-small-label">{example.label}</p>
                  <h3>{example.title}</h3>
                  <p>{example.description}</p>
                  <Link className="kestrel-text-link" to={example.guide}>{example.guideLabel} <span aria-hidden="true">↗</span></Link>
                </div>
                <div className="kestrel-capability-code"><CodeBlock language={example.language} title={example.file}>{example.code}</CodeBlock></div>
              </div>
            </TabItem>
          ))}
        </Tabs>
      </div>
    </section>
  );
}
