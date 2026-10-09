import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

import { firstPosition, nearestNote } from '@/audio/notes';
import { BackLink, Display, Eyebrow, GoldButton, IntonationScale, paperSheet, Progress, Purfling, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { useTakes } from '@/data/takesStore';
import { highlightsFor } from '@/practice/grading';
import { usePractice, type PracticeResult } from '@/practice/usePractice';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

export function PracticeScreen({ layout, id, fromBar, toBar }: { layout: LayoutMode; id: string; fromBar?: number; toBar?: number }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const takes = useTakes();
  const piece = library.get(id);
  const theme = useScoreTheme();
  const { settings } = useSettings();
  const score = useRef<ScoreViewHandle>(null);
  const [notes, setNotes] = useState<CursorNoteInfo[] | null>(null);
  const [quarterIndex, setQuarterIndex] = useState<QuarterIndexEntry[]>([]);
  const [measureCount, setMeasureCount] = useState(piece?.measureCount ?? 0);
  const [lastTakeId, setLastTakeId] = useState<string | null>(null);
  const [jumping, setJumping] = useState(false);
  const [jumpInput, setJumpInput] = useState('');
  const [jumpMessage, setJumpMessage] = useState<string | null>(null);
  const region = fromBar && toBar ? { fromBar: Math.min(fromBar, toBar), toBar: Math.max(fromBar, toBar) } : null;

  const moveCursor = useCallback((quarter: number) => {
    score.current?.send({ type: 'cursor', action: 'show' });
    score.current?.send({ type: 'seek', quarter });
  }, []);

  const onTake = useCallback(
    (result: PracticeResult) => {
      if (!piece) return;
      const takeId = takes.add({ pieceId: piece.id, region: result.region, source: result.source, records: result.records });
      setLastTakeId(takeId);
      // Loop passes stay on this screen: colour the bars just played, keep going.
      score.current?.send({ type: 'highlight', highlights: highlightsFor(result.records, theme, settings.reference, settings.strictness) });
    },
    [piece, takes, theme, settings.reference, settings.strictness],
  );

  const practice = usePractice({
    xml: piece?.xml ?? '',
    notes,
    quarterIndex,
    region,
    reference: settings.reference,
    strictness: settings.strictness,
    moveCursor,
    onTake,
  });

  // A whole-piece take goes straight to its review.
  useEffect(() => {
    if (practice.phase === 'done' && lastTakeId && !practice.looping) router.replace({ pathname: '/review', params: { takeId: lastTakeId } });
  }, [practice.phase, lastTakeId, practice.looping]);

  useEffect(() => {
    if (region && notes) score.current?.send({ type: 'selectBars', from: region.fromBar - 1, to: region.toBar - 1 });
  }, [region?.fromBar, region?.toBar, notes]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setQuarterIndex(event.quarterIndex);
      setMeasureCount(event.meta.measureCount);
    }
  };

  const bar = practice.currentStep !== null && notes ? (notes[practice.currentStep]?.measureIndex ?? 0) + 1 : null;
  const note = practice.liveHz ? nearestNote(practice.liveHz, settings.referencePitchHz) : null;
  const statusLine =
    practice.phase === 'error'
      ? practice.error ?? 'Something went wrong'
      : practice.micStatus === 'denied'
        ? 'Microphone access is off'
        : practice.phase === 'loading'
          ? 'Opening the score…'
          : practice.phase === 'connecting'
            ? 'Connecting…'
            : practice.phase === 'preparing' || practice.sessionStatus === 'preparing'
              ? 'Preparing the score…'
              : practice.phase === 'ready' || practice.sessionStatus === 'waiting'
                ? region
                  ? `Ready — start playing from bar ${region.fromBar}`
                  : 'Ready — start from the first note'
                : practice.sessionStatus === 'paused'
                  ? 'Paused — holding your place'
                  : practice.phase === 'scoring'
                    ? practice.progress > 0
                      ? `Grading your take… ${Math.round(practice.progress * 100)}%`
                      : 'Lining your take up with the score…'
                    : practice.phase === 'between'
                      ? 'Next pass — play again when you’re ready'
                      : null;

  const jump = () => {
    const value = Number.parseInt(jumpInput, 10);
    if (!Number.isFinite(value)) return;
    const problem = practice.jumpToBar(value);
    setJumpMessage(problem ?? `Jumped to bar ${value}`);
    setJumpInput('');
    setJumping(false);
  };

  const passes = practice.passes;
  const lastPass = passes[passes.length - 1];
  const passNumber = passes.length + (practice.phase === 'scoring' ? 0 : 1);
  const caption = statusLine ?? (note ? firstPosition(note.midi) : 'Listening');
  const cents = note ? Math.round(note.cents) : null;

  const finishButton =
    practice.phase === 'error' ? (
      <GoldButton label="Try again" onPress={practice.retry} />
    ) : (
      <GoldButton
        label={region ? 'Stop looping' : 'Finish'}
        onPress={() => (practice.phase === 'playing' || practice.phase === 'ready' ? practice.finish(true) : router.back())}
      />
    );

  const jumpControl = jumping ? (
    <View style={styles.jump}>
      <TextInput
        value={jumpInput}
        onChangeText={setJumpInput}
        placeholder="Bar"
        placeholderTextColor={colors.faint}
        keyboardType="number-pad"
        returnKeyType="go"
        autoFocus
        onSubmitEditing={jump}
        onBlur={() => !jumpInput && setJumping(false)}
        accessibilityLabel="Bar to jump to"
        style={styles.jumpInput}
      />
      <TextButton label="Go" onPress={jump} />
    </View>
  ) : (
    <TextButton label="Jump to bar" onPress={() => setJumping(true)} />
  );

  const readout = (
    <View style={styles.readout}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 14, flex: 1, minWidth: 0 }}>
        {note ? <Display size={tablet ? 88 : 64} style={{ lineHeight: tablet ? 90 : 66 }}>{note.name}</Display> : null}
        <Text style={[styles.caption, statusLine ? styles.captionStatus : null]} numberOfLines={2}>{caption}</Text>
      </View>
      {cents !== null ? <Text style={styles.cents}>{cents >= 0 ? '+' : '−'}{Math.abs(cents)}¢</Text> : null}
    </View>
  );

  const loopLine = region ? (
    <View style={styles.loopLine}>
      <Eyebrow tone="bright">Loop · bars {region.fromBar}–{region.toBar} · pass {passNumber}</Eyebrow>
      {lastPass ? (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
          {passes.slice(-4).map((p, i, arr) => (
            <Text key={p.pass} style={i === arr.length - 1 ? styles.passLast : styles.passOld}>{p.inTune}</Text>
          ))}
          <Text style={styles.passOf}>of {lastPass.notes} in tune</Text>
        </View>
      ) : null}
    </View>
  ) : null;

  const band = (
    <Wood variant="band" style={tablet ? styles.bandTablet : styles.bandPhone}>
      <Purfling style={{ marginTop: tablet ? 34 : 30 }} />
      {tablet ? (
        <View style={[styles.bandTabletInner, { paddingHorizontal: g }]}>
          <View style={{ flex: 1, gap: 6 }}>
            {loopLine}
            {readout}
          </View>
          <View style={{ width: 440 }}>
            <IntonationScale cents={cents} />
          </View>
          <View style={styles.controls}>
            {jumpControl}
            {finishButton}
          </View>
        </View>
      ) : (
        <View style={{ paddingHorizontal: g, paddingTop: 18, paddingBottom: 26, gap: 14 }}>
          {loopLine}
          {readout}
          <IntonationScale cents={cents} />
          <View style={[styles.controls, { justifyContent: 'space-between' }]}>
            {jumpControl}
            {finishButton}
          </View>
        </View>
      )}
      {jumpMessage ? <Text style={[styles.jumpMessage, { paddingHorizontal: g }]}>{jumpMessage}</Text> : null}
    </Wood>
  );

  return (
    <Screen layout={layout} edges={['top']}>
      <View style={{ flex: 1 }}>
        <View style={[styles.header, { paddingLeft: g - 10, paddingRight: g }, tablet && { paddingTop: 24 }]}>
          <View style={{ flex: 1, gap: tablet ? 8 : 0 }}>
            <BackLink label={tablet ? 'Library' : piece.title} onPress={() => router.back()} />
            {tablet ? (
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 18, paddingLeft: 10 }}>
                <Display size={52} numberOfLines={1}>{piece.title}</Display>
                {piece.composer ? <Text style={styles.composer}>{piece.composer}</Text> : null}
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Display size={tablet ? 52 : 30}>{bar ?? '—'}</Display>
            <Text style={styles.of}>of {measureCount}</Text>
          </View>
        </View>
        <Progress value={bar && measureCount ? bar / measureCount : 0} style={{ marginHorizontal: g, marginBottom: 14 }} />
        <ScoreView
          ref={score}
          xml={piece.xml}
          theme={theme}
          onEvent={onEngine}
          style={[styles.score, { marginHorizontal: tablet ? 48 : 12 }, theme === 'paper' && paperSheet]}
        />
        {band}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, paddingTop: 8, paddingBottom: 10 },
  composer: { fontFamily: fonts.serif, fontSize: 19, color: colors.soft },
  of: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.muted },
  score: { flex: 1, marginBottom: 18 },
  bandPhone: {},
  bandTablet: { minHeight: 230 },
  bandTabletInner: { flexDirection: 'row', alignItems: 'center', gap: 40, paddingTop: 34, paddingBottom: 40 },
  readout: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  caption: { flexShrink: 1, fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.cream, paddingBottom: 8 },
  captionStatus: { fontFamily: fonts.display, fontSize: 19, lineHeight: 26, letterSpacing: 0, textTransform: 'none', paddingBottom: 2 },
  cents: { fontFamily: fonts.display, fontSize: 22, color: colors.goldBright, paddingBottom: 8 },
  loopLine: { gap: 6 },
  passOld: { fontFamily: fonts.serif, fontSize: 18, color: colors.muted },
  passLast: { fontFamily: fonts.display, fontSize: 30, color: colors.bright },
  passOf: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.cream },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 32 },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  jumpInput: { width: 64, height: 44, borderBottomWidth: 1, borderBottomColor: colors.gold, color: colors.bright, fontFamily: fonts.display, fontSize: 22, textAlign: 'center' },
  jumpMessage: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.soft, paddingBottom: 12, marginTop: -14 },
});
