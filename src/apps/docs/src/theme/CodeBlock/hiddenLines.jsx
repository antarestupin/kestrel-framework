import { createContext, useContext } from 'react';

// Each layout owns its disclosure state; unrelated code blocks stay independent.
export const HiddenLinesContext = createContext(null);
export const useHiddenLines = () => useContext(HiddenLinesContext);

export function foldBoundarySeparators(code, lineClassNames) {
  const hiddenClass = 'kestrel-code-hidden-line';
  // Only presentation classes change; expanded and copied code retain their spacing.
  const result = { ...lineClassNames };
  const lines = code.split(/\r?\n/);
  if (result[0]?.includes(hiddenClass)) {
    for (let index = 0; index < lines.length; index += 1) {
      if (result[index]?.includes(hiddenClass)) continue;
      if (lines[index].trim() !== '') break;
      result[index] = [...(result[index] ?? []), hiddenClass];
    }
  }

  // A hidden suffix can leave separators before it and blank lines after its end marker.
  const trailingSeparators = [];
  let hasHiddenSuffix = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineClassNames[index]?.includes(hiddenClass)) {
      hasHiddenSuffix = true;
    } else if (lines[index].trim() === '') {
      trailingSeparators.push(index);
    } else {
      break;
    }
  }
  if (hasHiddenSuffix) {
    for (const index of trailingSeparators) {
      if (!result[index]?.includes(hiddenClass)) {
        result[index] = [...(result[index] ?? []), hiddenClass];
      }
    }
  }
  return result;
}

export function countHiddenLines(lineClassNames) {
  return Object.values(lineClassNames).filter((classes) =>
    classes.includes('kestrel-code-hidden-line'),
  ).length;
}
