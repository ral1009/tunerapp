// Design tokens for the "ebony and gold" look (see the UI concepts canvas). One dark palette: the
// score itself is the only thing that switches between paper and ebony (settings.scoreTheme).

export const colors = {
  ebony: '#0C0907',
  ebonyRaised: '#15100C',
  ink: '#E9DFCB',
  ivory: '#F2E8D5',
  bright: '#F6ECDA',
  cream: '#CDBFA6',
  soft: '#A8977D',
  muted: '#8C7C66',
  faint: '#6E6152',
  gold: '#C9A46A',
  goldBright: '#E3C58F',
  goldDeep: '#B08D57',
  rule: 'rgba(201,164,106,0.22)',
  ruleSoft: 'rgba(201,164,106,0.13)',
  // Grades on the dark ground.
  good: '#9FC79A',
  close: '#E0AE55',
  out: '#F0705A',
  quick: '#A898E6',
  // The paper score.
  paper: '#FAF7F0',
  paperInk: '#14110E',
  paperGold: '#9A6F2C',
} as const;

// Font family names are the keys loaded in src/app/_layout.tsx.
export const fonts = {
  display: 'BodoniModa_400Regular_Italic',
  displayMedium: 'BodoniModa_500Medium_Italic',
  serif: 'BodoniModa_400Regular',
  serifMedium: 'BodoniModa_500Medium',
  sans: 'HankenGrotesk_400Regular',
  sansMedium: 'HankenGrotesk_500Medium',
  sansLight: 'HankenGrotesk_300Light',
} as const;

// Side margins: generous on iPad, comfortable on a phone.
export const gutters = { phone: 28, tablet: 88 } as const;
