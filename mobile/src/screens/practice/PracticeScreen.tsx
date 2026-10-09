import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo, QuarterIndexEntry } from '@core/score/renderer/scoreCursor';

import { nearestNote } from '@/audio/notes';
import { Display, Eyebrow, GoldButton, Maple, Rule, Screen, TextButton, useGutter } from '@/components/ui';
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
          <TextButton label="← Library" onPress={() => router.replace('/')} />
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
                  : 'Ready — start playing from the first note'
                : practice.sessionStatus === 'paused'
                  ? 'Paused — holding your place'
                  : practice.phase === 'scoring'
                    ? practice.progress > 0
                      ? `Grading your take… ${Math.round(practice.progress * 100)}%`
                      : 'Lining your take up with the score…'
                    : practice.phase === 'between'
                      ? 'Next pass — play again when you are ready'
                      : 'Listening';

  const jump = () => {
    const value = Number.parseInt(jumpInput, 10);
    if (!Number.isFinite(value)) return;
    const problem = practice.jumpToBar(value);
    setJumpMessage(problem ?? `Jumped to bar ${value}`);
    setJumpInput('');
  };

  const passes = practice.passes;
  const lastPass = passes[passes.length - 1];

  const footer = (
    <Maple direction="horizontal" style={[styles.footer, tablet ? styles.footerTablet : styles.footerPhone]}>
      <View style={[styles.footerInner, { paddingHorizontal: g }, !tablet && { flexDirection: 'column', alignItems: 'stretch', gap: 14 }]}>
        <View style={{ flex: 1, gap: 8, minWidth: 0 }}>
          <Eyebrow>{region ? `Loop · bars ${region.fromBar}–${region.toBar}${passes.length ? ` · pass ${passes.length + (practice.phase === 'scoring' ? 0 : 1)}` : ''}` : 'Status'}</Eyebrow>
          {lastPass ? (
            <View style={styles.passRow}>
              {passes.slice(-4).map((p, i, arr) => (
                <Text key={p.pass} style={[styles.passScore, i === arr.length - 1 && styles.passScoreLast]}>{p.inTune}</Text>
              ))}
              <Text style={styles.passOf}>of {lastPass.notes} in tune</Text>
            </View>
          ) : (
            <Text style={styles.status} numberOfLines={2}>{statusLine}</Text>
          )}
          {lastPass ? <Text style={styles.statusSmall} numberOfLines={1}>{statusLine}</Text> : null}
        </View>

        <View style={[styles.liveNote, !tablet && { alignItems: 'flex-start' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
            <Display size={tablet ? 52 : 40} style={{ color: colors.bright }}>{note ? note.name : '—'}</Display>
            <Text style={styles.cents}>{note ? `${note.cents >= 0 ? '+' : '−'} ${Math.abs(Math.round(note.cents))} cents` : ' '}</Text>
          </View>
        </View>

        <View style={[styles.controls, !tablet && { justifyContent: 'space-between' }]}>
          <View style={styles.jump}>
            <TextInput
              value={jumpInput}
              onChangeText={setJumpInput}
              placeholder="Bar"
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              returnKeyType="go"
              onSubmitEditing={jump}
              accessibilityLabel="Jump to bar"
              style={styles.jumpInput}
            />
            <TextButton label="Jump" onPress={jump} />
          </View>
          {practice.phase === 'error' ? (
            <GoldButton label="Try again" onPress={practice.retry} />
          ) : (
            <GoldButton
              label={region ? 'Stop looping' : 'Finish'}
              onPress={() => (practice.phase === 'playing' || practice.phase === 'ready' ? practice.finish(true) : router.back())}
            />
          )}
        </View>
      </View>
      {jumpMessage ? <Text style={[styles.statusSmall, { paddingHorizontal: g, paddingBottom: 8 }]}>{jumpMessage}</Text> : null}
    </Maple>
  );

  return (
    <Screen layout={layout} edges={['top']}>
      <View style={{ flex: 1 }}>
        <View style={[styles.header, { paddingHorizontal: g }, tablet && { paddingTop: 30 }]}>
          <View style={{ flex: 1, gap: 6 }}>
            <TextButton label="← Back" onPress={() => router.back()} />
            <Display size={tablet ? 48 : 30} numberOfLines={1}>{piece.title}</Display>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Display size={tablet ? 46 : 32} style={{ color: colors.ivory }}>{bar ?? '—'}</Display>
            <Text style={styles.of}>of {measureCount}</Text>
          </View>
        </View>
        <Rule style={{ marginHorizontal: g, marginBottom: 14 }} />
        <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, { marginHorizontal: tablet ? g - 28 : 10 }, theme === 'paper' && styles.paper]} />
        {footer}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, paddingTop: 14, paddingBottom: 14 },
  of: { fontFamily: fonts.sans, fontSize: 11, letterSpacing: 2.6, textTransform: 'uppercase', color: colors.muted },
  score: { flex: 1, marginBottom: 14 },
  paper: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
  footer: { borderTopWidth: 1, borderTopColor: 'rgba(201,164,106,0.35)' },
  footerTablet: { minHeight: 150 },
  footerPhone: {},
  footerInner: { flexDirection: 'row', alignItems: 'center', gap: 28, paddingVertical: 20 },
  status: { fontFamily: fonts.display, fontSize: 18, color: colors.cream },
  statusSmall: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  passRow: { flexDirection: 'row', alignItems: 'baseline', gap: 14 },
  passScore: { fontFamily: fonts.serif, fontSize: 20, color: colors.muted },
  passScoreLast: { fontFamily: fonts.display, fontSize: 32, color: colors.ivory },
  passOf: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
  liveNote: { alignItems: 'center', minWidth: 160 },
  cents: { fontFamily: fonts.sans, fontSize: 13, letterSpacing: 2, color: colors.gold },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  jump: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  jumpInput: { width: 64, height: 44, borderBottomWidth: 1, borderBottomColor: colors.rule, color: colors.ivory, fontFamily: fonts.serif, fontSize: 18, textAlign: 'center' },
});

