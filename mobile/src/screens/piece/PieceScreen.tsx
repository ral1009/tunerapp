import { Link, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { EngineEvent, ScoreMeta } from '@core/score/engine/protocol';

import { Arrow, BackLink, Body, Display, Eyebrow, GoldButton, Screen, Serif, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { takeScore, useTakes } from '@/data/takesStore';
import { gradeTake, gradingOptions } from '@core/practice/reviewSummary';
import { useSettings } from '@/theme/settings';
import { ScoreView } from '@/score/ScoreView';
import { useScoreTheme, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

export function PieceScreen({ layout, id }: { layout: LayoutMode; id: string }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const piece = library.get(id);
  const theme = useScoreTheme();
  const [meta, setMeta] = useState<ScoreMeta | null>(null);
  const { update } = library;
  const { settings } = useSettings();
  const takes = useTakes().forPiece(id);

  // Opening a piece makes it the one "Continue" offers.
  useEffect(() => {
    if (piece) update(piece.id, { openedAt: Date.now() });
    // Only on arrival, not on every library change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
    if (event.type === 'loaded') setMeta(event.meta);
  };

  const sourceWord = piece.source === 'photo' ? 'from a photo' : piece.source === 'file' ? 'from a file' : 'starter piece';
  const details = [`${piece.measureCount} bars`, sourceWord, takes.length ? `${takes.length} take${takes.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  const eyebrow = [piece.composer || null, meta?.timeSignature ?? null, meta?.tempoBpm ? `♩ = ${meta.tempoBpm}` : null].filter(Boolean).join(' · ');
  const issues = piece.measureIssues;
  const params = { id: piece.id };

  // Oldest to newest whole-piece scores, for the trend.
  const wholeScores = takes
    .filter((t) => !t.region)
    .map((t) => takeScore(t, settings.reference, settings.strictness))
    .filter((v): v is number => v !== null)
    .reverse()
    .slice(-6);
  const lastScore = wholeScores.length ? wholeScores[wholeScores.length - 1] : null;
  const firstScore = wholeScores.length ? wholeScores[0] : null;
  // Per bar, across every take: how often it had a note out of tune or close.
  const trouble = new Array<number>(piece.measureCount).fill(-1);
  for (const take of takes) {
    for (const r of gradeTake(take.records, gradingOptions(settings.reference, settings.strictness)).records) {
      const bar = r.measureIndex;
      if (bar < 0 || bar >= trouble.length || r.verdict === 'not_played') continue;
      if (trouble[bar] < 0) trouble[bar] = 0;
      if (r.verdict === 'out_of_tune') trouble[bar] += 2;
      else if (r.verdict === 'close') trouble[bar] += 1;
    }
  }
  const worstLevel = Math.max(3, takes.length * 2);
  const worstBars = trouble.map((v, i) => ({ v, bar: i + 1 })).filter((b) => b.v >= worstLevel).map((b) => b.bar);
  const troubleColor = (v: number) => (v < 0 ? 'rgba(237,227,207,0.10)' : v >= worstLevel ? colors.outSoft : v >= 2 ? colors.close : v > 0 ? 'rgba(224,174,85,0.5)' : 'rgba(237,227,207,0.16)');
  const troubleHeight = (v: number) => (v <= 0 ? 6 : v >= worstLevel ? 21 : v >= 2 ? 16 : 11);
  const worstLine = worstBars.length ? `${worstBars.length > 1 ? 'bars' : 'bar'} ${worstBars.slice(0, 3).join(', ')}, every take` : null;

  const titleBlock = (
    <View style={{ gap: 8 }}>
      {eyebrow ? <Eyebrow tone="bright">{eyebrow}</Eyebrow> : null}
      <Display size={tablet ? 84 : piece.title.length > 14 ? 46 : 60} numberOfLines={2} style={{ textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 20 }}>{piece.title}</Display>
      <Text style={styles.details}>{details}</Text>
    </View>
  );

  const progress = takes.length ? (
    <View style={{ gap: 26 }}>
      <View style={styles.trendRow}>
        <View style={{ gap: 4 }}>
          <Eyebrow tone="muted">Last take</Eyebrow>
          <Text style={styles.last}>
            {lastScore === null ? '—' : lastScore}
            {lastScore !== null ? <Text style={styles.lastSign}>%</Text> : null}
          </Text>
        </View>
        {wholeScores.length > 1 ? (
          <View style={{ alignItems: 'flex-end', gap: 8 }}>
            <View style={styles.trend} accessible accessibilityLabel={`Last takes: ${wholeScores.join(', ')} percent`}>
              {wholeScores.map((v, i) => (
                <View key={i} style={{ width: 2, height: Math.max(3, (v / 100) * 44), backgroundColor: i === wholeScores.length - 1 ? colors.goldBright : 'rgba(237,227,207,0.35)' }} />
              ))}
            </View>
            {firstScore !== null && lastScore !== null ? (
              <Text style={styles.small}>{lastScore >= firstScore ? `up ${lastScore - firstScore}` : `down ${firstScore - lastScore}`} over {wholeScores.length} takes</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Eyebrow tone="muted">Where the trouble is</Eyebrow>
          {worstLine ? <Text style={styles.worst}>{worstLine}</Text> : null}
        </View>
        <View style={styles.strip} accessible accessibilityLabel="Trouble across the bars">
          {trouble.map((v, i) => (
            <View key={i} style={{ flex: 1, height: troubleHeight(v), backgroundColor: troubleColor(v) }} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={styles.tiny}>1</Text>
          <Text style={styles.tiny}>{piece.measureCount}</Text>
        </View>
      </View>
    </View>
  ) : (
    <View style={{ gap: 6 }}>
      <Serif size={18} style={{ color: colors.cream }}>No takes yet</Serif>
      <Body style={{ fontSize: 13 }}>Play it through once and your progress, and the bars that need work, will show here.</Body>
    </View>
  );

  const actions = (
    <View>
      <GoldButton label="Practise" href={{ pathname: '/practice', params }} style={{ minHeight: 52 }} />
      <Link href={{ pathname: '/choose-bars', params }} asChild>
        <Pressable accessibilityRole="link" style={StyleSheet.flatten([styles.actionRow, { marginTop: 8 }])}>
          <Text style={styles.actionText}>Loop a passage</Text>
          <Arrow />
        </Pressable>
      </Link>
      {issues.length ? (
        <Link href={{ pathname: '/fix-bar', params }} asChild>
          <Pressable accessibilityRole="link" style={styles.actionRow}>
            <Text style={styles.actionText}>
              Check misread bars <Text style={styles.issueCount}>· {issues.length} to check</Text>
            </Text>
            <Arrow />
          </Pressable>
        </Link>
      ) : null}
    </View>
  );

  const recent = takes.length ? (
    <View>
      <Eyebrow tone="muted">Recent takes</Eyebrow>
      <View style={{ marginTop: 6 }}>
        {takes.slice(0, tablet ? 8 : 4).map((t) => {
          const v = takeScore(t, settings.reference, settings.strictness);
          const d = new Date(t.at);
          const day = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
          const what = t.region ? `loop, bars ${t.region.fromBar}–${t.region.toBar}` : 'whole piece';
          return (
            <Pressable key={t.id} accessibilityRole="link" onPress={() => router.push({ pathname: '/review', params: { takeId: t.id } })} style={styles.takeRow}>
              <Text style={styles.takeText}>{`${day}, ${time} · ${what}`}</Text>
              <Text style={styles.takeScore}>{v === null ? '—' : `${v}%`}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  ) : null;

  // Read the score once for its time signature and tempo (not drawn).
  const reader = <ScoreView xml={piece.xml} theme={theme} render={false} onEvent={onEngine} style={styles.hidden} />;

  if (tablet) {
    return (
      <Screen layout={layout} edges={[]} glow={false}>
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <Wood variant="side" style={{ width: '56%' }}>
            <View style={{ flex: 1, paddingHorizontal: g, paddingTop: 44, paddingBottom: 72 }}>
              <BackLink label="Library" tone="light" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
              <View style={{ flex: 1 }} />
              {titleBlock}
            </View>
          </Wood>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingLeft: 48, paddingRight: g, paddingTop: 110, paddingBottom: 48, gap: 40 }}>
            {progress}
            {actions}
            {recent}
          </ScrollView>
        </View>
        {reader}
      </Screen>
    );
  }

  return (
    <Screen layout={layout} edges={['bottom']} glow={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 340 }} />
        <View style={{ paddingLeft: g - 10, paddingTop: 52 }}>
          <BackLink label="Library" tone="light" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        </View>
        <View style={{ paddingHorizontal: g, marginTop: 70, gap: 30 }}>
          {titleBlock}
          {progress}
          {actions}
          {recent}
        </View>
      </ScrollView>
      {reader}
    </Screen>
  );
}

const styles = StyleSheet.create({
  details: { fontFamily: fonts.sansLight, fontSize: 13, color: colors.cream },
  trendRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  last: { fontFamily: fonts.display, fontSize: 46, lineHeight: 48, color: colors.bright },
  lastSign: { fontFamily: fonts.serif, fontSize: 20, color: colors.cream },
  trend: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, height: 44 },
  small: { fontFamily: fonts.sansLight, fontSize: 11, color: colors.soft },
  worst: { fontFamily: fonts.display, fontSize: 13, color: colors.outSoft },
  strip: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 22 },
  tiny: { fontFamily: fonts.sans, fontSize: 10, color: colors.faint },
  actionRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  actionText: { fontFamily: fonts.serif, fontSize: 18, color: colors.ivory },
  issueCount: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.close },
  takeRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  takeText: { flex: 1, fontFamily: fonts.sansLight, fontSize: 13, color: colors.cream },
  takeScore: { fontFamily: fonts.display, fontSize: 17, color: colors.goldBright },
  hidden: { position: 'absolute', width: 600, height: 400, left: -10000, top: 0, opacity: 0 },
});
