// Design tokens for "Atelier" (the "Violin App — Wood & Luxury" canvas): ebony black, ivory
// Bodoni, gold hairlines, and one lit wood surface per screen (theme/woods.ts). One dark palette:
// the score itself is the only thing that switches between paper and ebony (settings.scoreTheme).

export const colors = {
  ebony: '#0B0806',
  ebonyRaised: '#15100C',
  ink: '#EDE3CF',
  ivory: '#F2E8D5',
  bright: '#FBF3E4',
  champagne: '#F2E2BF',
  cream: '#D9C7A7',
  soft: '#A8977D',
  muted: '#8C7C66',
  faint: '#6E6152',
  faintText: '#7A6A55',
  gold: '#C9A46A',
  goldBright: '#E3C58F',
  goldDeep: '#9A7A48',
  markerGold: '#F2D9A0',
  rule: 'rgba(201,164,106,0.22)',
  ruleSoft: 'rgba(201,164,106,0.16)',
  // Grades on the dark ground.
  good: '#D9C7A7',
  close: '#E0AE55',
  out: '#F0705A',
  outSoft: '#E8806C',
  quick: '#A898E6',
  // The paper score.
  paper: '#FAF6EC',
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
export const gutters = { phone: 28, tablet: 72 } as const;
