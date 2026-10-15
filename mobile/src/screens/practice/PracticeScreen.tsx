import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

import { firstPosition, nearestNote } from '@/audio/notes';
import { BackLink, Display, Eyebrow, GoldButton, IntonationScale, paperSheet, Progress, Purfling, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { ServerStatusLine } from '@/components/ServerStatus';
import { useLibrary } from '@/data/libraryStore';
import { useTakes } from '@/data/takesStore';
import { highlightsFor } from '@/practice/grading';
import { createEngineAligner } from '@/practice/engineAligner';
import { traceEvent } from '@/practice/takeTrace';
import { createEngineGrader } from '@/practice/engineGrader';
import { useLiveValue, type LiveValue } from '@/practice/liveValue';
import { probeRender } from '@/practice/perfProbe';
import { usePractice, type PracticeResult } from '@/practice/usePractice';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';
import { useStayAwake } from '@/components/useStayAwake';

export function PracticeScreen({ layout, id, fromBar, toBar }: { layout: LayoutMode; id: string; fromBar?: number; toBar?: number }) {
  useStayAwake('practice');
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
  probeRender();
  const region = fromBar && toBar ? { fromBar: Math.min(fromBar, toBar), toBar: Math.max(fromBar, toBar) } : null;

  // Grading runs in the score engine's page (its own thread, with a JIT), not on the app's thread.
  const [grader] = useState(createEngineGrader);
  // Score following runs there too, unless Settings says the laptop server.
  const [engineAligner] = useState(createEngineAligner);
  const onDevice = settings.scoreFollowing !== 'server';
  useEffect(() => {
    grader.attach((command) => score.current?.send(command));
    engineAligner.attach((command) => score.current?.send(command));
  }, [grader, engineAligner]);

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
    grader: grader.grade,
    makeTransport: onDevice ? engineAligner.transport : undefined,
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
    if (grader.handle(event) || engineAligner.handle(event)) return;
    if (event.type === 'error') traceEvent('engineError', event.message);
    if (event.type === 'loaded' && event.rendered) {
      setNotes(event.notes);
      setQuarterIndex(event.quarterIndex);
      setMeasureCount(event.meta.measureCount);
    }
  };

  const bar = practice.currentStep !== null && notes ? (notes[practice.currentStep]?.measureIndex ?? 0) + 1 : null;
  const statusLine =
    practice.phase === 'error'
      ? practice.error ?? 'Something went wrong'
      : practice.micStatus === 'denied'
        ? 'Microphone access is off — allow it in Settings'
        : practice.micStatus === 'error'
          ? practice.micError ?? 'The microphone couldn’t start'
        : practice.phase === 'loading'
          ? 'Opening the score…'
          : practice.phase === 'connecting'
            ? onDevice
              ? 'Preparing the score…' // nothing to connect to: the engine is building its reference
              : 'Connecting…'
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

  const finishButton =
    practice.phase === 'error' ? (
      <GoldButton label="Try again" onPress={practice.retry} style={styles.finish} />
    ) : (
      <GoldButton
        label={region ? 'Stop looping' : 'Finish'}
        style={styles.finish}
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

  const readout = <LiveReadout liveHz={practice.liveHz} a4={settings.referencePitchHz} statusLine={statusLine} tablet={tablet} />;

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

  // The bottom bar is kept low so the music gets the screen: one row on an iPad (live note, the
  // scale, the controls), two short rows on a phone. Messages (server, loop, a jump) take a thin
  // line above it only while there is something to say.
  const scale = <LiveScale liveHz={practice.liveHz} a4={settings.referencePitchHz} />;
  const band = (
    <Wood variant="band">
      <Purfling />
      <View style={[styles.notices, { paddingHorizontal: g }]}>
        {onDevice ? null : <ServerStatusLine quietWhenOnline compact />}
        {loopLine}
        {jumpMessage ? <Text style={styles.jumpMessage}>{jumpMessage}</Text> : null}
      </View>
      {tablet ? (
        <View style={[styles.bandRow, { paddingHorizontal: g }]}>
          <View style={{ flex: 1, minWidth: 220 }}>{readout}</View>
          <View style={{ flex: 1.2, maxWidth: 420 }}>{scale}</View>
          <View style={styles.controls}>
            {jumpControl}
            {finishButton}
          </View>
        </View>
      ) : (
        <View style={{ paddingHorizontal: g, paddingTop: 4, paddingBottom: 10, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ flex: 1, minWidth: 0 }}>{readout}</View>
            <View style={{ width: '46%' }}>{scale}</View>
          </View>
          <View style={[styles.controls, { justifyContent: 'space-between' }]}>
            {jumpControl}
            {finishButton}
          </View>
        </View>
      )}
    </Wood>
  );

  return (
    <Screen layout={layout} edges={['top']}>
      <View style={{ flex: 1 }}>
        <View style={[styles.header, { paddingLeft: g - 10, paddingRight: g }]}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 18 }}>
            <BackLink label={tablet ? 'Music' : piece.title} onPress={() => router.back()} />
            {tablet ? (
              <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 14 }}>
                <Display size={28} numberOfLines={1} style={{ flexShrink: 1 }}>{piece.title}</Display>
                {piece.composer ? <Text style={styles.composer} numberOfLines={1}>{piece.composer}</Text> : null}
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={styles.of}>Bar</Text>
            <Display size={tablet ? 30 : 24}>{bar ?? '·'}</Display>
            <Text style={styles.of}>of {measureCount}</Text>
          </View>
        </View>
        <Progress value={bar && measureCount ? bar / measureCount : 0} style={{ marginHorizontal: g, marginBottom: 8 }} />
        <ScoreView
          ref={score}
          xml={piece.xml}
          theme={theme}
          onEvent={onEngine}
          style={[styles.score, { marginHorizontal: tablet ? 24 : 8 }, theme === 'paper' && paperSheet]}
        />
        {band}
      </View>
    </Screen>
  );
}

// The live note and its cents: subscribed to the live pitch on their own, so a reading redraws
// these few views and not the whole screen.
function LiveReadout({ liveHz, a4, statusLine, tablet }: { liveHz: LiveValue<number | null>; a4: number; statusLine: string | null; tablet: boolean }) {
  const hz = useLiveValue(liveHz);
  const note = hz ? nearestNote(hz, a4) : null;
  const caption = statusLine ?? (note ? firstPosition(note.midi) : 'Listening');
  const cents = note ? Math.round(note.cents) : null;
  return (
    <View style={styles.readout}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 14, flex: 1, minWidth: 0 }}>
        {note ? <Display size={tablet ? 52 : 40}>{note.name}</Display> : null}
        <Text style={[styles.caption, statusLine ? styles.captionStatus : null]} numberOfLines={2}>{caption}</Text>
      </View>
      {cents !== null ? <Text style={styles.cents}>{cents >= 0 ? '+' : '−'}{Math.abs(cents)}¢</Text> : null}
    </View>
  );
}

function LiveScale({ liveHz, a4 }: { liveHz: LiveValue<number | null>; a4: number }) {
  const hz = useLiveValue(liveHz);
  return <IntonationScale cents={hz ? Math.round(nearestNote(hz, a4).cents) : null} />;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 4, paddingBottom: 6 },
  composer: { flexShrink: 0, fontFamily: fonts.serif, fontSize: 15, color: colors.soft },
  of: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.muted },
  score: { flex: 1, marginBottom: 8 },
  notices: { gap: 4, paddingTop: 8 },
  bandRow: { flexDirection: 'row', alignItems: 'center', gap: 32, paddingTop: 4, paddingBottom: 12 },
  readout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 52 },
  caption: { flexShrink: 1, fontFamily: fonts.sansMedium, fontSize: 9.5, letterSpacing: 2.5, textTransform: 'uppercase', color: colors.cream },
  captionStatus: { fontFamily: fonts.display, fontSize: 16, lineHeight: 21, letterSpacing: 0, textTransform: 'none' },
  cents: { fontFamily: fonts.display, fontSize: 20, color: colors.goldBright },
  loopLine: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  passOld: { fontFamily: fonts.serif, fontSize: 18, color: colors.muted },
  passLast: { fontFamily: fonts.display, fontSize: 22, color: colors.bright },
  passOf: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.cream },
  finish: { minHeight: 40, paddingHorizontal: 22 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  jumpInput: { width: 64, height: 44, borderBottomWidth: 1, borderBottomColor: colors.gold, color: colors.bright, fontFamily: fonts.display, fontSize: 22, textAlign: 'center' },
  jumpMessage: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.soft },
});
