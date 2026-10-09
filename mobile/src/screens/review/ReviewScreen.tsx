import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { gradingOptions, summarizePracticeSession } from '@core/practice/reviewSummary';
import type { EngineEvent } from '@core/score/engine/protocol';

import { Body, Choice, Display, Eyebrow, GoldButton, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { takeScore, useTakes } from '@/data/takesStore';
import { barsLabel, GRADE_COLORS, highlightsFor, problemSpots } from '@/practice/grading';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ReviewScreen({ layout, takeId }: { layout: LayoutMode; takeId: string }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const takes = useTakes();
  const library = useLibrary();
  const take = takes.get(takeId);
  const piece = take ? library.get(take.pieceId) : undefined;
  const theme = useScoreTheme();
  const { settings, update } = useSettings();
  const score = useRef<ScoreViewHandle>(null);
  const [scoreReady, setScoreReady] = useState(false);

  const records = take?.records ?? [];
  const options = gradingOptions(settings.reference, settings.strictness);
  const summary = summarizePracticeSession(records, options);
  const graded = summary.inTuneNoteIds.length + summary.closeNoteIds.length + summary.unstableNoteIds.length;
  const percent = take ? takeScore(take, settings.reference, settings.strictness) : null;
  const spots = problemSpots(records, settings.reference, settings.strictness);
  const previous = take ? takes.forPiece(take.pieceId).filter((t) => t.at < take.at && !t.region === !take.region)[0] : undefined;
  const previousPercent = previous ? takeScore(previous, settings.reference, settings.strictness) : null;

  // Colour the notes once the score is drawn, and again whenever grading settings change.
  useEffect(() => {
    if (!scoreReady || !take) return;
    score.current?.send({ type: 'highlight', highlights: highlightsFor(take.records, theme, settings.reference, settings.strictness) });
  }, [scoreReady, take, theme, settings.reference, settings.strictness]);

  if (!take || !piece) {
    return (
      <Screen layout={layout}>
        <View style={{ padding: g, gap: 16 }}>
          <TextButton label="← Library" onPress={() => router.replace('/')} />
          <Display size={36}>This take isn&rsquo;t available</Display>
        </View>
      </Screen>
    );
  }

  const onEngine = (event: EngineEvent) => {
    if (event.type === 'loaded' && event.rendered) setScoreReady(true);
  };

  const comparison =
    previousPercent !== null && percent !== null
      ? percent > previousPercent
        ? `${percent - previousPercent} better than last time`
        : percent < previousPercent
          ? `${previousPercent - percent} below last time`
          : 'the same as last time'
      : 'your first graded take of this';
  const drift = summary.stringDriftCents;
  // The side panel sits on the dark ground whichever score theme is on.
  const c = GRADE_COLORS.ebony;

  const headline = (
    <View>
      <Eyebrow tone="muted">In tune</Eyebrow>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 10 }}>
        <Display size={tablet ? 120 : 96} style={{ color: colors.bright, lineHeight: tablet ? 116 : 94 }}>{percent ?? '—'}</Display>
        {percent !== null ? <Serif size={28} style={{ color: colors.gold, marginTop: 8 }}>%</Serif> : null}
      </View>
      <Text style={styles.italic}>
        {comparison} · {summary.averageCentsError.toFixed(0)} cents on average
      </Text>
      <View style={styles.counts}>
        <Text style={styles.count}>{summary.inTuneNoteIds.length} in tune</Text>
        <Text style={[styles.count, { color: c.close }]}>{summary.closeNoteIds.length} close</Text>
        <Text style={[styles.count, { color: c.out }]}>{summary.unstableNoteIds.length} out</Text>
        {summary.unmeasuredNoteIds.length ? <Text style={[styles.count, { color: c.unclear }]}>{summary.unmeasuredNoteIds.length} too quick</Text> : null}
        {summary.notPlayedNoteIds.length ? <Text style={[styles.count, { color: colors.muted }]}>{summary.notPlayedNoteIds.length} not played</Text> : null}
      </View>
      {drift !== null && Math.abs(drift) > 8 ? (
        <Body style={{ color: colors.close, marginTop: 10, fontSize: 13 }}>
          Your open strings were about {Math.abs(Math.round(drift))}¢ {drift < 0 ? 'flat' : 'sharp'} of your fingered notes. They may have drifted — retune before the next take.
        </Body>
      ) : null}
      {graded === 0 ? <Body style={{ marginTop: 10 }}>Nothing in this take could be graded. Try playing a little louder, closer to the device.</Body> : null}
    </View>
  );

  const attention = (
    <View>
      <Eyebrow>Worth your attention</Eyebrow>
      {spots.length === 0 ? (
        <Body style={{ marginTop: 14 }}>Nothing stood out. Try Strict, or loop a passage you want to polish.</Body>
      ) : (
        spots.map((spot, i) => (
          <View key={`${spot.fromBar}-${spot.toBar}`} style={styles.spot}>
            <Text style={[styles.numeral, { color: spot.out ? c.out : spot.close ? c.close : c.unclear }]}>{['i', 'ii', 'iii'][i]}</Text>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                <Serif size={19}>{barsLabel(spot)}</Serif>
                {spot.worstCents ? (
                  <Text style={[styles.cents, { color: spot.out ? c.out : c.close }]}>
                    {spot.worstCents > 0 ? '+' : '−'} {Math.abs(Math.round(spot.worstCents))} cents
                  </Text>
                ) : null}
              </View>
              <Text style={styles.detail}>{spot.detail}</Text>
              <TextButton label="Loop these bars →" tone="gold" href={{ pathname: '/practice', params: { id: piece.id, from: String(spot.fromBar), to: String(spot.toBar) } }} />
            </View>
          </View>
        ))
      )}
    </View>
  );

  const strictness = (
    <Choice
      label="How strict"
      value={settings.strictness}
      onChange={(strictness) => update({ strictness })}
      options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'standard', label: 'Standard' }, { value: 'strict', label: 'Strict' }]}
    />
  );

  const scoreView = (
    <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[{ flex: 1 }, theme === 'paper' && styles.paper]} />
  );

  const title = (
    <View style={{ gap: 10 }}>
      <TextButton label={`← ${piece.title}`} onPress={() => router.replace({ pathname: '/piece/[id]', params: { id: piece.id } })} />
      <Eyebrow>{when(take.at)}{take.region ? ` · loop, bars ${take.region.fromBar}–${take.region.toBar}` : ''}</Eyebrow>
      <Display size={tablet ? 56 : 36} numberOfLines={1}>{piece.title}</Display>
    </View>
  );

  if (tablet) {
    return (
      <Screen layout={layout}>
        <View style={{ flex: 1, paddingHorizontal: g, paddingTop: 30, paddingBottom: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
            {title}
            {strictness}
          </View>
          <Rule style={{ marginTop: 22, marginBottom: 24 }} />
          <View style={{ flex: 1, flexDirection: 'row', gap: 56 }}>
            <View style={{ flex: 1 }}>{scoreView}</View>
            <ScrollView style={{ width: 360, flexGrow: 0 }} contentContainerStyle={{ gap: 34, paddingBottom: 20 }}>
              {headline}
              {attention}
              <GoldButton label="Play it again" href={{ pathname: '/practice', params: take.region ? { id: piece.id, from: String(take.region.fromBar), to: String(take.region.toBar) } : { id: piece.id } }} />
            </ScrollView>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingTop: 20, paddingBottom: 32, gap: 26 }}>
        {title}
        {headline}
        {strictness}
        {attention}
        <View style={{ height: 340 }}>{scoreView}</View>
        <GoldButton label="Play it again" href={{ pathname: '/practice', params: take.region ? { id: piece.id, from: String(take.region.fromBar), to: String(take.region.toBar) } : { id: piece.id } }} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  italic: { fontFamily: fonts.display, fontSize: 16, color: colors.soft, marginTop: 12 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, marginTop: 14 },
  count: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.6, color: colors.cream },
  spot: { flexDirection: 'row', gap: 12, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  numeral: { width: 28, fontFamily: fonts.display, fontSize: 21 },
  cents: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 1 },
  detail: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.soft },
  paper: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
});
