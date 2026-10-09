import type { NoteAccuracyRecord } from '@core/practice/cursor';
import { gradeTake, gradingOptions, summarizePracticeSession, type GradeReference, type GradeStrictness } from '@core/practice/reviewSummary';
import type { NoteHighlight } from '@core/score/renderer/scoreCursor';

// Grade colours on the score: deep, ink-strength on paper, brighter on ebony. In-tune notes keep
// the score's own ink, so a clean take still looks like ordinary printed music.
export const GRADE_COLORS = {
  paper: { close: '#B0700C', out: '#B4261C', unclear: '#5A43B0', notPlayed: '#9A9086' },
  ebony: { close: '#E0AE55', out: '#F0705A', unclear: '#A898E6', notPlayed: '#6E6152' },
} as const;

export function highlightsFor(
  records: NoteAccuracyRecord[],
  theme: 'paper' | 'ebony',
  reference: GradeReference,
  strictness: GradeStrictness,
): NoteHighlight[] {
  const summary = summarizePracticeSession(records, gradingOptions(reference, strictness));
  const c = GRADE_COLORS[theme];
  return [
    ...summary.unstableNoteIds.map((id) => ({ stepIndex: Number(id), color: c.out })),
    ...summary.closeNoteIds.map((id) => ({ stepIndex: Number(id), color: c.close })),
    ...summary.unmeasuredNoteIds.map((id) => ({ stepIndex: Number(id), color: c.unclear })),
    ...summary.notPlayedNoteIds.map((id) => ({ stepIndex: Number(id), color: c.notPlayed })),
  ];
}

export interface ProblemSpot {
  fromBar: number;
  toBar: number;
  worstCents: number; // signed, against the chosen reference
  out: number;
  close: number;
  unclear: number;
  detail: string;
}

// "Worth your attention": bars with mistakes, worst first, neighbouring bars merged into one spot.
export function problemSpots(records: NoteAccuracyRecord[], reference: GradeReference, strictness: GradeStrictness, limit = 3): ProblemSpot[] {
  const graded = gradeTake(records, gradingOptions(reference, strictness)).records;
  const byBar = new Map<number, { out: number; close: number; unclear: number; worst: number }>();
  for (const r of graded) {
    const bar = r.measureIndex + 1;
    const entry = byBar.get(bar) ?? { out: 0, close: 0, unclear: 0, worst: 0 };
    if (r.verdict === 'out_of_tune') entry.out += 1;
    if (r.verdict === 'close') entry.close += 1;
    if (r.verdict === 'unmeasured') entry.unclear += 1;
    if ((r.verdict === 'out_of_tune' || r.verdict === 'close') && r.averageCentsOff !== null && Math.abs(r.averageCentsOff) > Math.abs(entry.worst)) entry.worst = r.averageCentsOff;
    byBar.set(bar, entry);
  }
  const bars = [...byBar.entries()].filter(([, e]) => e.out + e.close > 0 || e.unclear >= 2).sort(([a], [b]) => a - b);
  const spots: ProblemSpot[] = [];
  for (const [bar, e] of bars) {
    const last = spots[spots.length - 1];
    if (last && bar === last.toBar + 1) {
      last.toBar = bar;
      last.out += e.out;
      last.close += e.close;
      last.unclear += e.unclear;
      if (Math.abs(e.worst) > Math.abs(last.worstCents)) last.worstCents = e.worst;
    } else {
      spots.push({ fromBar: bar, toBar: bar, worstCents: e.worst, out: e.out, close: e.close, unclear: e.unclear, detail: '' });
    }
  }
  for (const s of spots) {
    const parts = [];
    if (s.out) parts.push(`${s.out} out of tune`);
    if (s.close) parts.push(`${s.close} close`);
    if (s.unclear) parts.push(`${s.unclear} too quick to hear`);
    const lean = s.worstCents < -5 ? 'leaning flat' : s.worstCents > 5 ? 'leaning sharp' : '';
    s.detail = [parts.join(', '), lean].filter(Boolean).join(' — ');
  }
  return spots.sort((a, b) => b.out * 3 + b.close + b.unclear * 0.5 - (a.out * 3 + a.close + a.unclear * 0.5)).slice(0, limit);
}

export function barsLabel(spot: { fromBar: number; toBar: number }): string {
  return spot.fromBar === spot.toBar ? `Bar ${spot.fromBar}` : `Bars ${spot.fromBar}–${spot.toBar}`;
}
