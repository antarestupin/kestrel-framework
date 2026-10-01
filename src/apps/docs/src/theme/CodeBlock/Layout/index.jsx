import React, { useId, useMemo, useState } from 'react';
import useIsBrowser from '@docusaurus/useIsBrowser';
import OriginalLayout from '@theme-original/CodeBlock/Layout';
import { CodeBlockContextProvider, useCodeBlockContext } from '@docusaurus/theme-common/internal';
import { HiddenLinesContext, countHiddenLines, foldBoundarySeparators } from '../hiddenLines';
import styles from './styles.module.css';

export default function CodeBlockLayout(props) {
  const { metadata, wordWrap } = useCodeBlockContext();
  const [expanded, setExpanded] = useState(false);
  const isBrowser = useIsBrowser();
  const contentId = useId();
  const numbered = useMemo(() => {
    const foldedClasses = foldBoundarySeparators(metadata.code, metadata.lineClassNames);
    // Give every line its own class array so Line can recover its original number.
    const lineClassNames = Object.fromEntries(metadata.code.split('\n').map((_, index) =>
      [index, [...(foldedClasses[index] ?? [])]],
    ));
    const lineNumbers = new Map(Object.entries(lineClassNames).map(([index, classes]) =>
      [classes, (metadata.lineNumbersStart ?? 1) + Number(index)],
    ));
    return { metadata: { ...metadata, lineClassNames }, lineNumbers };
  }, [metadata]);
  const count = countHiddenLines(numbered.metadata.lineClassNames);

  if (!count) return <OriginalLayout {...props} />;

  return (
    <HiddenLinesContext.Provider value={{ count, expanded, setExpanded, contentId, lineNumbers: numbered.lineNumbers }}>
      {/* Keep wrapping available when revealing previously hidden long lines. */}
      <CodeBlockContextProvider metadata={numbered.metadata} wordWrap={{ ...wordWrap, isCodeScrollable: true }}>
        {/* Without JavaScript the full example remains readable and selectable. */}
        <div id={contentId} className={styles.disclosure} data-expanded={!isBrowser || expanded} data-revealed={expanded}>
          <OriginalLayout {...props} />
        </div>
      </CodeBlockContextProvider>
    </HiddenLinesContext.Provider>
  );
}
