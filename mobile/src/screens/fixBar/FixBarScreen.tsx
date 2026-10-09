import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ScoreMeasureIssue } from '@core/score/schema';
import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo } from '@core/score/renderer/scoreCursor';

import { BackLink, Body, Choice, Display, GoldButton, paperSheet, Purfling, Screen, TextButton, useGutter, Wood } from '@/components/ui';
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
          <BackLink label="Library" onPress={() => router.replace('/')} />
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

  const nextBar = () => {
    setIssueIndex((i) => (i + 1) % Math.max(1, issues.length));
    setNoteIndex(0);
    setEdit(null);
  };
  const lengthIs = LENGTHS.find((l) => current && Math.abs(l.value - current.length) < 1e-6)?.value ?? -1;

  const header = (
    <View style={{ paddingHorizontal: g, gap: 6, paddingTop: 10 }}>
      <Display size={tablet ? 52 : 34}>{issue ? `Check bar ${issue.measureNumber}` : 'Every bar adds up'}</Display>
      {issue ? (
        <Text style={styles.lede}>
          {issue.kind === 'empty' ? 'The photo reading found no notes in this bar' : issue.kind === 'short' ? 'The photo reading left this bar short' : 'This bar has too much in it'}
          {` — ${issue.parsedQuarterNotes} of ${issue.expectedQuarterNotes} beats.`}
        </Text>
      ) : null}
    </View>
  );

  const chips = issues.length ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" contentContainerStyle={{ paddingHorizontal: g, gap: 20 }} style={{ flexGrow: 0, marginTop: 6 }}>
      {issues.map((it, i) => {
        const on = i === issueIndex;
        return (
          <Pressable key={it.measureNumber} onPress={() => { setIssueIndex(i); setNoteIndex(0); setEdit(null); }} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`Bar ${it.measureNumber}`} style={[styles.chip, { borderBottomColor: on ? colors.goldBright : 'transparent' }]}>
            <Text style={[styles.chipText, { color: on ? colors.bright : colors.faintText }]}>{it.measureNumber}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  ) : null;

  const editor = issue && selected && current ? (
    <View style={[{ paddingHorizontal: g, paddingTop: 12 }, tablet && styles.editorTablet]}>
      <View style={[tablet && { flex: 1 }]}>
        <View style={styles.editRow}>
          <Text style={styles.editLabel}>Note</Text>
          <View style={styles.editControls}>
            <TextButton label="‹" tone="gold" onPress={() => { setNoteIndex(Math.max(0, noteIndex - 1)); setEdit(null); }} style={styles.arrowButton} />
            <Text style={styles.noteCount}>{noteIndex + 1} <Text style={styles.of}>of {barNotes.length}</Text></Text>
            <TextButton label="›" tone="gold" onPress={() => { setNoteIndex(Math.min(barNotes.length - 1, noteIndex + 1)); setEdit(null); }} style={styles.arrowButton} />
          </View>
        </View>
        <View style={[styles.editRow, { minHeight: 76 }]}>
          <Text style={styles.editLabel}>Pitch</Text>
          <View style={styles.editControls}>
            <TextButton label="▼" tone="gold" onPress={() => setEdit({ midi: current.midi - 1, length: current.length })} style={styles.arrowButton} />
            <Display size={38} style={{ minWidth: 80, textAlign: 'center' }}>{display(pitchName(current.midi, flats))}</Display>
            <TextButton label="▲" tone="gold" onPress={() => setEdit({ midi: current.midi + 1, length: current.length })} style={styles.arrowButton} />
          </View>
        </View>
        <View style={[styles.editRow, { borderBottomWidth: 0 }]}>
          <Text style={styles.editLabel}>Length</Text>
          <Choice label="Length" gap={12} value={lengthIs} onChange={(length) => setEdit({ midi: current.midi, length })} options={LENGTHS} />
        </View>
      </View>
      <View style={[styles.buttons, tablet && { flexDirection: 'column', alignItems: 'flex-end', gap: 12 }]}>
        <TextButton label="Leave it" onPress={nextBar} />
        <GoldButton label={working ? 'Fixing…' : changed ? 'Apply' : 'Next bar'} onPress={changed ? apply : nextBar} />
      </View>
    </View>
  ) : (
    <View style={{ paddingHorizontal: g, paddingTop: 24, paddingBottom: 32, gap: 18 }}>
      <Body>{issue ? 'This bar has no notes to edit yet.' : 'Nothing left to check. The score is ready to practise.'}</Body>
      <GoldButton label="Back to the piece" onPress={() => router.back()} style={{ alignSelf: 'flex-start' }} />
    </View>
  );

  return (
    <Screen layout={layout} edges={['top']}>
      <View style={{ flex: 1 }}>
        <View style={[styles.top, { paddingLeft: g - 10, paddingRight: g }]}>
          <BackLink label={piece.title} onPress={() => router.back()} />
          {issues.length ? <Text style={styles.of}>{Math.min(issueIndex + 1, issues.length)} of {issues.length}</Text> : null}
        </View>
        {header}
        {chips}
        <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, { marginHorizontal: tablet ? 48 : 12 }, theme === 'paper' && paperSheet]} />
        <Wood variant="band">
          <Purfling style={{ marginTop: 34 }} />
          <View style={{ paddingBottom: 26 }}>{editor}</View>
        </Wood>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6 },
  lede: { fontFamily: fonts.sansLight, fontSize: 13, color: colors.soft },
  chip: { minWidth: 22, minHeight: 44, justifyContent: 'center', alignItems: 'center', borderBottomWidth: 1 },
  chipText: { fontFamily: fonts.serif, fontSize: 18 },
  score: { flex: 1, marginTop: 10, marginBottom: 18 },
  editorTablet: { flexDirection: 'row', alignItems: 'center', gap: 56 },
  editRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(237,227,207,0.14)' },
  editLabel: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3.5, textTransform: 'uppercase', color: colors.cream },
  editControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  arrowButton: { minWidth: 44, justifyContent: 'center' },
  noteCount: { fontFamily: fonts.display, fontSize: 20, color: colors.bright },
  of: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.muted },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
});
