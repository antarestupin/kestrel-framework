import React, { useEffect, useRef, useState } from 'react';

export default function ContactEmail() {
  const [email, setEmail] = useState(null);
  const link = useRef(null);

  // Preserve keyboard focus when the reveal button becomes a mail link.
  useEffect(() => {
    if (email) link.current?.focus();
  }, [email]);

  function revealEmail() {
    // Deter simple HTML harvesters; client-side obfuscation is not encryption.
    setEmail(['contact', 'kestreljs'].join('.') + '@' + ['gmail', 'com'].join('.'));
  }

  return <>
    <span aria-live="polite">
      {email
        ? <a ref={link} href={`mailto:${email}`}>{email}</a>
        : <button type="button" className="button button--secondary button--sm" onClick={revealEmail}>Show email address</button>}
    </span>
    {/* Keep contact available when JavaScript is disabled, without a plain address. */}
    <noscript> contact.kestreljs [at] gmail [dot] com</noscript>
  </>;
}
