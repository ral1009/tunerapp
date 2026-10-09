import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ScoreMeasureIssue } from '@core/score/schema';
import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo } from '@core/score/renderer/scoreCursor';

import { Body, Choice, Display, Eyebrow, GoldButton, Rule, Screen, TextButton, useGutter } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Fix what the photo reading got wrong, one flagged bar at a time: pick a note, nudge its pitch a
// semitone at a time or change its length, apply. The score engine patches the MusicXML
// (score/correctionUI/noteXmlCorrection.ts) and re-checks every bar, so a fixed bar drops off
// the list by itself.

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

function midiOf(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}
// "<Step><#|b|><Octave>", the format the correction code and musicxmlImport use.
function pitchName(midi: number, flats: boolean): string {
  return `${(flats ? FLAT : SHARP)[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
function display(name: string): string {
  return name.replace('#', '♯').replace(/([A-G])b/, '$1♭');
}

const LENGTHS = [
  { value: 0.25, label: 'Sixteenth' },
  { value: 0.5, label: 'Eighth' },
  { value: 1, label: 'Quarter' },
  { value: 2, label: 'Half' },
];

export function FixBarScreen({ layout, id }: { layout: LayoutMode; id: string }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const piece = library.get(id);
  const theme = useScoreTheme();
  const score = useRef<ScoreViewHandle>(null);
  const [notes, setNotes] = useState<CursorNoteInfo[]>([]);
  const [issues, setIssues] = useState<ScoreMeasureIssue[]>(piece?.measureIssues ?? []);
  const [keySignature, setKeySignature] = useState('C');
  const [issueIndex, setIssueIndex] = useState(0);
  const [noteIndex, setNoteIndex] = useState(0); // within the bar
  const [edit, setEdit] = useState<{ midi: number; length: number } | null>(null);
  const [working, setWorking] = useState(false);

  const issue = issues[Math.min(issueIndex, Math.max(0, issues.length - 1))];
  const barIndex = issue ? issue.measureNumber - 1 : -1;
  const barNotes = notes.filter((n) => n.measureIndex === barIndex && n.primaryFrequencyHz !== null);
  const selected = barNotes[Math.min(noteIndex, Math.max(0, barNotes.length - 1))];
  const flats = FLAT_KEYS.has(keySignature);

  // Show the bar being checked and the note being edited.
  useEffect(() => {
    if (barIndex < 0) return;
    score.current?.send({ type: 'selectBars', from: barIndex, to: barIndex });
    score.current?.send({ type: 'scrollToBar', measureIndex: barIndex });
  }, [barIndex, notes]);
  useEffect(() => {
    score.current?.send({ type: 'highlight', highlights: selected ? [{ stepIndex: selected.stepIndex, color: '#B07F2E' }] : [] });
  }, [selected]);

  if (!piece) {
    return (
      <Screen layout={layout}>
        <View style={{ padding: g, gap: 16 }}>
          <TextButton label="← Library" onPress={() => router.replace('/')} />
          <Display size={36}>This piece isn&rsquo;t in your library</Display>
        </View>
      </Screen>
    );
  }

  const onEngine = (event: EngineEvent) => {
    if (event.type === 'loaded' && event.rendered) {
      setNotes(event.notes);
      setIssues(event.meta.measureIssues);
      setKeySignature(event.meta.keySignature);
    }
    if (event.type === 'xmlChanged') {
      setWorking(false);
      setNotes(event.notes);
      setIssues(event.meta.measureIssues);
      setEdit(null);
      library.update(piece.id, { xml: event.xml, measureIssues: event.meta.measureIssues, measureCount: event.meta.measureCount });
      // The fixed bar drops off the list; whatever's next moves into its place.
      setIssueIndex((i) => Math.min(i, Math.max(0, event.meta.measureIssues.length - 1)));
    }
    if (event.type === 'error') setWorking(false);
  };

  const current = selected ? { midi: edit?.midi ?? midiOf(selected.primaryFrequencyHz as number), length: edit?.length ?? selected.durationQuarterNotes } : null;
  const changed = !!(selected && current && (current.midi !== midiOf(selected.primaryFrequencyHz as number) || Math.abs(current.length - selected.durationQuarterNotes) > 1e-6));

  const apply = () => {
    if (!selected || !current || !changed) return;
    const original = midiOf(selected.primaryFrequencyHz as number);
    setWorking(true);
    score.current?.send({
      type: 'correct',
      corrections: [
        {
          measureIndex: barIndex,
          noteIndexInMeasure: noteIndex,
          ...(current.midi !== original ? { pitch: pitchName(current.midi, flats) } : {}),
          ...(Math.abs(current.length - selected.durationQuarterNotes) > 1e-6 ? { durationBeats: current.length } : {}),
        },
      ],
    });
  };

  const header = (
    <View style={[styles.header, { paddingHorizontal: g }, tablet && { paddingTop: 30 }]}>
      <View style={{ gap: 8, flex: 1 }}>
        <TextButton label={`← ${piece.title}`} onPress={() => router.back()} />
        <Display size={tablet ? 52 : 34}>{issue ? `Check bar ${issue.measureNumber}` : 'Every bar adds up'}</Display>
      </View>
      {issue ? (
        <View style={{ alignItems: tablet ? 'flex-end' : 'flex-start', gap: 6 }}>
          <Text style={styles.italic}>
            {issue.kind === 'empty' ? 'The photo reading found no notes here' : issue.kind === 'short' ? 'The photo reading left this bar short' : 'This bar has too much in it'}
            {` (${issue.parsedQuarterNotes} of ${issue.expectedQuarterNotes} beats)`}
          </Text>
          <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
            {issues.map((it, i) => (
              <Pressable key={it.measureNumber} onPress={() => { setIssueIndex(i); setNoteIndex(0); setEdit(null); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Bar ${it.measureNumber}`}>
                <Text style={[styles.issueChip, i === issueIndex && styles.issueChipOn]}>{it.measureNumber}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  const editor = issue && selected && current ? (
    <View style={[styles.editor, { paddingHorizontal: g }, !tablet && { flexDirection: 'column', alignItems: 'stretch', gap: 18 }]}>
      <View style={{ gap: 8 }}>
        <Eyebrow>Note {noteIndex + 1} of {barNotes.length}</Eyebrow>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <TextButton label="‹" onPress={() => { setNoteIndex(Math.max(0, noteIndex - 1)); setEdit(null); }} />
          <Display size={44} style={{ color: colors.bright, minWidth: 86, textAlign: 'center' }}>{display(pitchName(current.midi, flats))}</Display>
          <View>
            <TextButton label="▲" tone="gold" onPress={() => setEdit({ midi: current.midi + 1, length: current.length })} />
            <TextButton label="▼" tone="gold" onPress={() => setEdit({ midi: current.midi - 1, length: current.length })} />
          </View>
          <TextButton label="›" onPress={() => { setNoteIndex(Math.min(barNotes.length - 1, noteIndex + 1)); setEdit(null); }} />
        </View>
      </View>
      <View style={{ gap: 8, flex: tablet ? 1 : undefined }}>
        <Eyebrow tone="muted">Length</Eyebrow>
        <Choice label="Length" value={LENGTHS.find((l) => Math.abs(l.value - current.length) < 1e-6)?.value ?? -1} onChange={(length) => setEdit({ midi: current.midi, length })} options={LENGTHS} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24 }}>
        <TextButton label="Leave it" onPress={() => { setIssueIndex((i) => (i + 1) % Math.max(1, issues.length)); setNoteIndex(0); setEdit(null); }} />
        <GoldButton label={working ? 'Fixing…' : changed ? 'Apply' : 'Next bar →'} onPress={changed ? apply : () => { setIssueIndex((i) => (i + 1) % Math.max(1, issues.length)); setNoteIndex(0); }} />
      </View>
    </View>
  ) : (
    <View style={[styles.editor, { paddingHorizontal: g }]}>
      <Body>{issue ? 'This bar has no notes to edit yet.' : 'Nothing left to check. The score is ready to practise.'}</Body>
      <GoldButton label="Back to the piece" onPress={() => router.back()} />
    </View>
  );

  return (
    <Screen layout={layout}>
      <View style={{ flex: 1 }}>
        {header}
        <Rule style={{ marginHorizontal: g, marginBottom: 14 }} />
        <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, { marginHorizontal: tablet ? g - 28 : 10 }, theme === 'paper' && styles.paper]} />
        {editor}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, paddingTop: 14, paddingBottom: 14 },
  italic: { fontFamily: fonts.display, fontSize: 16, color: colors.soft },
  issueChip: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 1, color: colors.muted, paddingHorizontal: 7, paddingVertical: 6, minWidth: 30, textAlign: 'center' },
  issueChipOn: { color: colors.goldBright, borderBottomWidth: 1, borderBottomColor: colors.gold },
  score: { flex: 1, marginBottom: 14 },
  paper: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
  editor: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 32, paddingVertical: 20, borderTopWidth: 1, borderTopColor: 'rgba(201,164,106,0.3)' },
});
