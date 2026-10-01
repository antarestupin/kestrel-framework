import React from 'react';
import OriginalLine from '@theme-original/CodeBlock/Line';
import { useHiddenLines } from '../hiddenLines';

export default function CodeBlockLine(props) {
  const disclosure = useHiddenLines();
  if (!disclosure) return <OriginalLine {...props} />;

  return (
    <OriginalLine
      {...props}
      getLineProps={(input) => {
        const lineProps = props.getLineProps(input);
        return {
          ...lineProps,
          'data-numbered': props.showLineNumbers ? 'true' : undefined,
          // Hidden rows do not increment CSS counters; pin each row to its source number.
          style: props.showLineNumbers ? {
            ...lineProps.style,
            counterSet: `line-count ${disclosure.lineNumbers.get(props.classNames)}`,
          } : lineProps.style,
        };
      }}
    />
  );
}
