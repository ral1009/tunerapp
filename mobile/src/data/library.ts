// Sample library until takes are saved on the device (step 7 of the plan). Shapes are what the
// real store will provide.

export interface Piece {
  id: string;
  title: string;
  composer: string;
  movement?: string;
  caps: string; // engraved-style title on the page thumbnail
  bars: number;
  takes: number;
  lastScore: number | null; // % in tune on the last take
  trend: string;
  trendUp: boolean;
  needsWork?: string;
}

export const PIECES: Piece[] = [
  { id: 'autumn', title: 'Autumn', composer: 'Vivaldi', movement: 'I. Allegro', caps: "L'AUTUNNO", bars: 112, takes: 4, lastScore: 81, trend: '+ 6 this week', trendUp: true, needsWork: 'bar 14' },
  { id: 'gavotte', title: 'Gavotte in D', composer: 'Gossec', caps: 'GAVOTTE', bars: 48, takes: 4, lastScore: 88, trend: '+ 5 this week', trendUp: true },
  { id: 'twinkle', title: 'Twinkle variations', composer: 'Suzuki Book 1', caps: 'TWINKLE', bars: 24, takes: 9, lastScore: 94, trend: 'steady', trendUp: false },
  { id: 'giga', title: 'Giga', composer: 'Bach · Partita No. 2', caps: 'PARTITA II', bars: 40, takes: 2, lastScore: 62, trend: '+ 11 this week', trendUp: true },
  { id: 'meditation', title: 'Méditation', composer: 'Massenet', caps: 'MÉDITATION', bars: 62, takes: 0, lastScore: null, trend: 'new', trendUp: false },
];

export function continuePiece(): Piece {
  return PIECES[0];
}
