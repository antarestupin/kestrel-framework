import React from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import OriginalButtons from '@theme-original/CodeBlock/Buttons';
import CopyButton from '@theme/CodeBlock/Buttons/CopyButton';
import WordWrapButton from '@theme/CodeBlock/Buttons/WordWrapButton';
import Button from '@theme/CodeBlock/Buttons/Button';
import { useHiddenLines } from '../hiddenLines';
import styles from './styles.module.css';

export default function CodeBlockButtons(props) {
  const disclosure = useHiddenLines();
  if (!disclosure) return <OriginalButtons {...props} />;

  const { count, expanded, setExpanded, contentId } = disclosure;
  const label = expanded ? 'Hide extra lines' : `Show ${count} hidden ${count === 1 ? 'line' : 'lines'}`;

  return (
    <BrowserOnly>
      {() => (
        <div className={[props.className, styles.buttons].filter(Boolean).join(' ')}>
          <Button
            className={styles.disclosureButton}
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}>
            {label}
          </Button>
          <WordWrapButton />
          {/* The native copy button reads the complete, marker-free metadata.code. */}
          <CopyButton />
        </div>
      )}
    </BrowserOnly>
  );
}
