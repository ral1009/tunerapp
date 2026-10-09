import type { ImageSourcePropType } from 'react-native';

// The woods a player can put behind their music: the parts of a violin and its bow. Textures are
// generated (scripts/textures/real_woods.py, modelled on photographs: soft flame that comes and
// goes, pore flecks along the grain, uneven colour), not photographs, so they ship with the app.
export type WoodKey = 'maple' | 'golden' | 'pernambuco' | 'walnut' | 'rosewood' | 'ebony';

export interface Wood {
  key: WoodKey;
  name: string;
  part: string;
  line: string;
  source: ImageSourcePropType;
  // Where the interesting part of the board is, for cropping (0..1 of width / height).
  focus: { x: number; y: number };
}

export const WOODS: Wood[] = [
  { key: 'maple', name: 'Violin maple', part: 'The back', line: 'Flamed maple under an orange-red varnish', source: require('@/assets/images/woods/maple.jpg'), focus: { x: 0.5, y: 0.35 } },
  { key: 'golden', name: 'Golden maple', part: 'The back', line: 'Tighter flame, lighter golden varnish', source: require('@/assets/images/woods/golden.jpg'), focus: { x: 0.5, y: 0.35 } },
  { key: 'pernambuco', name: 'Pernambuco', part: 'The bow', line: 'Plain, dense red-brown — the bow-maker’s wood', source: require('@/assets/images/woods/pernambuco.jpg'), focus: { x: 0.5, y: 0.5 } },
  { key: 'walnut', name: 'Curly walnut', part: 'The case', line: 'Brown with a fine rippled curl', source: require('@/assets/images/woods/walnut.jpg'), focus: { x: 0.5, y: 0.5 } },
  { key: 'rosewood', name: 'Figured rosewood', part: 'The pegs', line: 'Flowing grain with a whorl', source: require('@/assets/images/woods/rosewood.jpg'), focus: { x: 0.72, y: 0.55 } },
  { key: 'ebony', name: 'Ebony', part: 'The fingerboard', line: 'Near black, a quiet satin sheen', source: require('@/assets/images/woods/ebony.jpg'), focus: { x: 0.5, y: 0.3 } },
];

export function woodFor(key: WoodKey): Wood {
  return WOODS.find((w) => w.key === key) ?? WOODS[0];
}
