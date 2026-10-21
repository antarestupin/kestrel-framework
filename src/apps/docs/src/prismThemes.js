// Keep token roles consistent across modes while pairing terracotta with muted earth tones.
function createTheme(plain, palette) {
  return {
    plain,
    styles: [
      { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: palette.comment, fontStyle: 'italic' } },
      { types: ['punctuation', 'operator'], style: { color: palette.punctuation } },
      { types: ['keyword', 'tag', 'important', 'atrule'], style: { color: palette.terracotta } },
      { types: ['string', 'char', 'attr-value', 'inserted'], style: { color: palette.olive } },
      { types: ['function', 'selector', 'attr-name'], style: { color: palette.ochre } },
      { types: ['number', 'boolean', 'constant', 'symbol', 'deleted'], style: { color: palette.plum } },
      { types: ['class-name', 'builtin', 'property', 'regex', 'variable', 'url'], style: { color: palette.slate } },
      { types: ['bold'], style: { fontWeight: 'bold' } },
      { types: ['italic'], style: { fontStyle: 'italic' } },
    ],
  };
}

// Keep warm charcoal code surfaces and readable token colors in both page themes.
export const terracottaTheme = createTheme(
  { color: '#f0e3da', backgroundColor: '#2b231f' },
  {
    comment: '#b5a397', punctuation: '#c7b3a6', terracotta: '#ed9d79',
    olive: '#bdcc91', ochre: '#e7bf7b', plum: '#d7a9cd', slate: '#9bc6d0',
  },
);
