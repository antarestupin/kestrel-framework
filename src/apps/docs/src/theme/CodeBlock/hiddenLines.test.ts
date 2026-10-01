import { describe, expect, it, vi } from 'vitest';
import config from '../../../docusaurus.config.js';
import { countHiddenLines, foldBoundarySeparators } from './hiddenLines.jsx';

// The native parser also exports React utilities; no browser lifecycle is needed here.
vi.mock('@docusaurus/useIsomorphicLayoutEffect', () => ({ default: () => {} }));

// Load only the installed parser: the internal barrel pulls in the entire site runtime.
const { parseLines, getLineNumbersStart } = await import(new URL(
  '../src/utils/codeBlockUtils.tsx', import.meta.resolve('@docusaurus/theme-common'),
).href);

const magicComments = config.themeConfig.prism.magicComments;
const parse = (code: string, language = 'ts', metastring?: string) =>
  parseLines(code, { language, metastring, magicComments });

describe('documentation hidden code sections', () => {
  it('folds blank lines exposed by a hidden prefix without changing copy text or later spacing', () => {
    const result = parse('// hide-start\nsetup();\n// hide-end\n\n  \nrun();\n\nfinish();');
    const originalCode = result.code;
    const classes = foldBoundarySeparators(result.code, result.lineClassNames);
    expect(countHiddenLines(classes)).toBe(3);
    expect(classes[1]).toEqual(['kestrel-code-hidden-line']);
    expect(classes[2]).toEqual(['kestrel-code-hidden-line']);
    expect(classes[4]).toBeUndefined();
    expect(result.lineClassNames[1]).toBeUndefined();
    expect(result.code).toBe(originalCode);
  });

  it('preserves deliberate leading whitespace when the beginning is not hidden', () => {
    const result = parse('\nrun();\n// hide-start\ncleanup();\n// hide-end\n\n');
    expect(foldBoundarySeparators(result.code, result.lineClassNames)[0]).toBeUndefined();
  });

  it('folds blank separators around a hidden suffix while preserving interior spacing and copy text', () => {
    const result = parse('run();\n\nfinish();\n\n  \n// hide-start\ncleanup();\n// hide-end\n\n');
    const classes = foldBoundarySeparators(result.code, result.lineClassNames);
    expect(countHiddenLines(classes)).toBe(4);
    expect(classes[1]).toBeUndefined();
    for (const index of [3, 4, 5, 6]) {
      expect(classes[index]).toEqual(['kestrel-code-hidden-line']);
    }
    expect(result.lineClassNames[3]).toBeUndefined();
    expect(result.code).toBe('run();\n\nfinish();\n\n  \ncleanup();\n');
  });

  it('preserves trailing whitespace when a middle section is hidden', () => {
    const result = parse('run();\n// hide-start\nsetup();\n// hide-end\nfinish();\n\n');
    expect(foldBoundarySeparators(result.code, result.lineClassNames)).toEqual(result.lineClassNames);
  });

  it('folds separators at both boundaries without duplicating classes in an entirely hidden block', () => {
    const result = parse('// hide-start\nsetup();\n// hide-end\n\n// hide-start\ncleanup();\n// hide-end');
    const classes = foldBoundarySeparators(result.code, result.lineClassNames);
    expect(countHiddenLines(classes)).toBe(3);
    expect(classes[1]).toEqual(['kestrel-code-hidden-line']);
  });

  it('folds multiple sections while preserving full, marker-free copy content', () => {
    const result = parse([
      '// hide-start', 'import example from "example";', '', '// hide-end',
      '// highlight-next-line', 'example();',
      '// hide-start', 'example.dispose();', '// hide-end',
    ].join('\n'));

    expect(result.code).toBe('import example from "example";\n\nexample();\nexample.dispose();');
    expect(countHiddenLines(result.lineClassNames)).toBe(3);
    expect(result.lineClassNames[2]).toEqual(['theme-code-block-highlighted-line']);
    expect(result.lineClassNames[3]).toEqual(['kestrel-code-hidden-line']);
  });

  it.each([
    ['ts', '//'], ['bash', '#'], ['sql', '--'],
  ])('uses native %s comment syntax', (language, prefix) => {
    const result = parse(`${prefix} hide-start\nsetup();\n${prefix} hide-end\nrun();`, language);
    expect(result.code).toBe('setup();\nrun();');
    expect(countHiddenLines(result.lineClassNames)).toBe(1);
  });

  it('retains highlighting inside a folded section', () => {
    const result = parse('// hide-start\n// highlight-start\nsetup();\n// highlight-end\n// hide-end\nrun();');
    expect(result.lineClassNames[0]).toEqual(['theme-code-block-highlighted-line', 'kestrel-code-hidden-line']);
    expect(countHiddenLines(result.lineClassNames)).toBe(1);
  });

  it('leaves ordinary code and numeric highlighting unchanged', () => {
    expect(countHiddenLines(parse('run();').lineClassNames)).toBe(0);
    expect(parse('setup();\nrun();', 'ts', '{2}').lineClassNames[1]).toEqual(['theme-code-block-highlighted-line']);
    expect(getLineNumbersStart({ showLineNumbers: undefined, metastring: 'showLineNumbers=10' })).toBe(10);
  });

  it('documents native numeric-range precedence instead of silently claiming folding support', () => {
    const code = '// hide-start\nsetup();\n// hide-end\nrun();';
    const result = parse(code, 'ts', '{2}');
    expect(result.code).toBe(code);
    expect(countHiddenLines(result.lineClassNames)).toBe(0);
  });
});
