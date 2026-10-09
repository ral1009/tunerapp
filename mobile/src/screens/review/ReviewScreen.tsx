import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { gradingOptions, summarizePracticeSession } from '@core/practice/reviewSummary';
import type { EngineEvent } from '@core/score/engine/protocol';

import { BackLink, Body, Choice, Display, Eyebrow, GoldButton, paperSheet, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { takeScore, useTakes } from '@/data/takesStore';
import { barsLabel, GRADE_COLORS, highlightsFor, problemSpots } from '@/practice/grading';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

function when(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return d.toDateString() === today.toDateString() ? `Today · ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const inWords = (n: number) => (n <= 10 ? WORDS[n] : String(n));

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
  const firstSpotBar = spots[0]?.fromBar;

  // Colour the notes once the score is drawn, and again whenever grading settings change; open
  // the score at the first trouble spot.
  useEffect(() => {
    if (!scoreReady || !take) return;
    score.current?.send({ type: 'highlight', highlights: highlightsFor(take.records, theme, settings.reference, settings.strictness) });
  }, [scoreReady, take, theme, settings.reference, settings.strictness]);
  useEffect(() => {
    if (scoreReady && firstSpotBar) score.current?.send({ type: 'scrollToBar', measureIndex: Math.max(0, firstSpotBar - 1) });
  }, [scoreReady, firstSpotBar]);

  if (!take || !piece) {
    return (
      <Screen layout={layout}>
        <View style={{ padding: g, gap: 16 }}>
          <BackLink label="Library" onPress={() => router.replace('/')} />
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
        ? `Up ${inWords(percent - previousPercent)} since your last take`
        : percent < previousPercent
          ? `Down ${inWords(previousPercent - percent)} since your last take`
          : 'The same as your last take'
      : 'Your first graded take of this';
  const drift = summary.stringDriftCents;
  const c = GRADE_COLORS.ebony;
  const replay = { pathname: '/practice' as const, params: take.region ? { id: piece.id, from: String(take.region.fromBar), to: String(take.region.toBar) } : { id: piece.id } };

  const header = (
    <View style={[styles.header, { paddingLeft: g - 10, paddingRight: g }]}>
      <BackLink label={piece.title} tone="light" onPress={() => router.replace({ pathname: '/piece/[id]', params: { id: piece.id } })} />
      <Eyebrow tone="muted">{when(take.at)}{take.region ? ` · bars ${take.region.fromBar}–${take.region.toBar}` : ''}</Eyebrow>
    </View>
  );

  const headline = (
    <View style={{ alignItems: tablet ? 'flex-start' : 'center' }}>
      <Eyebrow tone="gold" style={tablet ? { fontSize: 11, letterSpacing: 5 } : undefined}>In tune</Eyebrow>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginTop: 4 }}>
        <Text style={[styles.percent, tablet && styles.percentTablet]}>{percent ?? '—'}</Text>
        {percent !== null ? <Text style={[styles.percentSign, tablet && { fontSize: 36, marginTop: 30 }]}>%</Text> : null}
      </View>
      <Text style={[styles.comparison, !tablet && { textAlign: 'center' }]}>
        {comparison} · {summary.averageCentsError.toFixed(0)} cents off on average
      </Text>
    </View>
  );

  const counts = (
    <View style={styles.counts}>
      {[
        { n: summary.inTuneNoteIds.length, label: 'In tune', color: colors.cream },
        { n: summary.closeNoteIds.length, label: 'Close', color: c.close },
        { n: summary.unstableNoteIds.length, label: 'Out', color: c.out },
        { n: summary.unmeasuredNoteIds.length, label: 'Unclear', color: c.unclear },
      ].map((item) => (
        <View key={item.label} style={{ flex: 1, gap: 8 }}>
          <View style={{ width: 18, height: 1, backgroundColor: item.color }} />
          <Text style={[styles.countN, tablet && { fontSize: 36 }]}>{item.n}</Text>
          <Text style={[styles.countLabel, { color: item.color }]}>{item.label}</Text>
        </View>
      ))}
    </View>
  );

  const notes = (
    <>
      {summary.notPlayedNoteIds.length ? <Body style={styles.note}>{summary.notPlayedNoteIds.length} notes weren&rsquo;t reached in this take.</Body> : null}
      {drift !== null && Math.abs(drift) > 8 ? (
        <Body style={[styles.note, { color: colors.close }]}>
          Your open strings were about {Math.abs(Math.round(drift))}¢ {drift < 0 ? 'flat' : 'sharp'} of your fingered notes. They may have drifted — retune before the next take.
        </Body>
      ) : null}
      {graded === 0 ? <Body style={styles.note}>Nothing in this take could be graded. Try playing a little louder, closer to the device.</Body> : null}
    </>
  );

  const strictness = (
    <View style={styles.strictness}>
      <Text style={styles.strictLabel}>Strictness</Text>
      <Choice
        label="Strictness"
        value={settings.strictness}
        onChange={(value) => update({ strictness: value })}
        options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'standard', label: 'Standard' }, { value: 'strict', label: 'Strict' }]}
      />
    </View>
  );

  const spotList = (
    <View>
      <Eyebrow tone="gold">Worth your attention</Eyebrow>
      {spots.length === 0 ? (
        <Body style={{ marginTop: 14 }}>Nothing stood out. Try Strict, or loop a passage you want to polish.</Body>
      ) : (
        <View style={[{ marginTop: 6 }, tablet && styles.spotGrid]}>
          {spots.slice(0, tablet ? 2 : 3).map((spot) => (
            <View key={`${spot.fromBar}-${spot.toBar}`} style={[styles.spot, tablet && { flex: 1 }]}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <Display size={30}>{barsLabel(spot).replace('–', ' – ')}</Display>
                {spot.worstCents ? (
                  <Text style={[styles.spotCents, { color: spot.out ? colors.outSoft : c.close }]}>
                    {spot.worstCents > 0 ? '+' : '−'}{Math.abs(Math.round(spot.worstCents))}¢
                  </Text>
                ) : null}
              </View>
              <Text style={styles.detail}>{spot.detail.charAt(0).toUpperCase() + spot.detail.slice(1)}.</Text>
              <TextButton
                label={spot.fromBar === spot.toBar ? `Loop bar ${spot.fromBar}` : `Loop bars ${spot.fromBar}–${spot.toBar}`}
                tone="gold"
                arrow
                href={{ pathname: '/practice', params: { id: piece.id, from: String(spot.fromBar), to: String(spot.toBar) } }}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );

  const scoreView = <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[{ flex: 1 }, theme === 'paper' && paperSheet]} />;

  if (tablet) {
    return (
      <Screen layout={layout} edges={[]} glow={false}>
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <Wood variant="side" style={{ width: 600 }}>
            <View style={{ paddingTop: 40 }}>{header}</View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingTop: 110, paddingBottom: 40, gap: 0 }}>
              {headline}
              <View style={{ marginTop: 56 }}>{counts}</View>
              {notes}
              <View style={{ marginTop: 44 }}>{strictness}</View>
            </ScrollView>
          </Wood>
          <View style={{ flex: 1, paddingRight: 64, paddingLeft: 40, paddingTop: 64, paddingBottom: 36 }}>
            {spotList}
            <View style={{ flex: 1, marginTop: 30 }}>{scoreView}</View>
            <View style={styles.actionsTablet}>
              <TextButton label="Back to the piece" onPress={() => router.replace({ pathname: '/piece/[id]', params: { id: piece.id } })} />
              <GoldButton label="Play again" href={replay} />
            </View>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen layout={layout} edges={[]} glow={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 430 }} />
        <View style={{ paddingTop: 46 }}>{header}</View>
        <View style={{ paddingHorizontal: g, paddingTop: 40, gap: 0 }}>
          {headline}
          <View style={{ marginTop: 34 }}>{counts}</View>
          {notes}
          <View style={{ marginTop: 24 }}>{strictness}</View>
          <View style={{ marginTop: 26 }}>{spotList}</View>
        </View>
        <View style={{ height: 360, marginHorizontal: 12, marginTop: 18 }}>{scoreView}</View>
        <View style={[styles.actionsPhone, { paddingHorizontal: g }]}>
          <TextButton label="Back to the piece" onPress={() => router.replace({ pathname: '/piece/[id]', params: { id: piece.id } })} />
          <GoldButton label="Play again" href={replay} />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  percent: { fontFamily: fonts.display, fontSize: 176, lineHeight: 164, letterSpacing: -4, color: '#F6EEDC', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 30 },
  percentTablet: { fontSize: 230, lineHeight: 206, letterSpacing: -6 },
  percentSign: { fontFamily: fonts.serif, fontSize: 28, color: '#E9D5AE', marginTop: 22, marginLeft: 6 },
  comparison: { fontFamily: fonts.display, fontSize: 16, color: colors.cream, marginTop: 10 },
  counts: { flexDirection: 'row', gap: 12 },
  countN: { fontFamily: fonts.serif, fontSize: 28, color: colors.ivory },
  countLabel: { fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase' },
  note: { fontSize: 13, marginTop: 14 },
  strictness: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.ruleSoft, paddingTop: 2 },
  strictLabel: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 3, textTransform: 'uppercase', color: colors.faint },
  spotGrid: { flexDirection: 'row', gap: 36 },
  spot: { gap: 6, paddingTop: 18, paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.ruleSoft, marginTop: 12 },
  spotCents: { fontFamily: fonts.display, fontSize: 20 },
  detail: { fontFamily: fonts.sansLight, fontSize: 13, lineHeight: 20, color: colors.soft },
  actionsPhone: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26 },
  actionsTablet: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 40, marginTop: 26 },
});
