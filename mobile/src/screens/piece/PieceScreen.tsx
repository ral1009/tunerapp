import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { EngineEvent, ScoreMeta } from '@core/score/engine/protocol';

import { Body, Display, Eyebrow, GoldButton, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
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
          <TextButton label="← Library" onPress={() => router.replace('/')} />
          <Display size={36}>This piece isn&rsquo;t in your library</Display>
        </View>
      </Screen>
    );
  }

  const onEngine = (event: EngineEvent) => {
    if (event.type === 'loaded') setMeta(event.meta);
  };

  const details = [
    `${piece.measureCount} bars`,
    meta?.keySignature ? `${meta.keySignature}` : null,
    meta?.timeSignature ?? null,
    meta?.tempoBpm ? `♩ = ${meta.tempoBpm}` : null,
  ].filter(Boolean).join(' · ');
  const issues = piece.measureIssues;
  const params = { id: piece.id };

  const actions = (
    <View style={[styles.actions, tablet && { flexDirection: 'column', alignItems: 'stretch', gap: 6 }]}>
      <GoldButton label="Play from the start" href={{ pathname: '/practice', params }} style={tablet ? undefined : { flex: 1 }} />
      <TextButton label="Loop a passage" href={{ pathname: '/choose-bars', params }} style={tablet ? { alignSelf: 'center' } : undefined} />
    </View>
  );

  const issueNote = issues.length ? (
    <View style={styles.issue}>
      <Text style={styles.issueTitle}>
        {issues.length === 1 ? '1 bar doesn’t add up' : `${issues.length} bars don’t add up`}
      </Text>
      <Body style={{ fontSize: 13 }}>
        Usually a note the photo reading got wrong: bar {issues.slice(0, 6).map((i) => i.measureNumber).join(', ')}
        {issues.length > 6 ? '…' : ''}. Following can stall there.
      </Body>
      <TextButton label="Check those bars →" tone="gold" href={{ pathname: '/fix-bar', params }} />
    </View>
  ) : null;

  // Oldest to newest whole-piece scores, for the progress line.
  const wholeScores = takes
    .filter((t) => !t.region)
    .map((t) => takeScore(t, settings.reference, settings.strictness))
    .filter((v): v is number => v !== null)
    .reverse()
    .slice(-6);
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
  const troubleColor = (v: number) => (v < 0 ? '#1E1813' : v >= Math.max(3, takes.length * 2) ? '#E06A55' : v > 0 ? '#B88A3E' : '#3A2E24');

  const takesBlock = (
    <View style={{ gap: 6 }}>
      {wholeScores.length ? (
        <View style={{ marginBottom: 14 }}>
          <Eyebrow tone="muted">In tune, take by take</Eyebrow>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
            {wholeScores.map((v, i) => (
              <Text key={i} style={i === wholeScores.length - 1 ? styles.scoreLast : styles.scoreOld}>{v}%</Text>
            ))}
          </View>
        </View>
      ) : null}
      {takes.length ? (
        <View style={{ marginBottom: 14 }}>
          <Eyebrow tone="muted">Where the trouble is</Eyebrow>
          <View style={{ flexDirection: 'row', gap: 1, height: 26, marginTop: 10 }}>
            {trouble.map((v, i) => (
              <View key={i} style={{ flex: 1, backgroundColor: troubleColor(v) }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
            <Text style={styles.small}>Bar 1</Text>
            <Text style={styles.small}>Bar {piece.measureCount}</Text>
          </View>
        </View>
      ) : null}
      <Eyebrow tone="muted">Takes</Eyebrow>
      {takes.length === 0 ? (
        <View style={styles.emptyTakes}>
          <Serif size={17} style={{ color: colors.cream }}>No takes yet</Serif>
          <Body style={{ fontSize: 13 }}>Play it through once and your progress, and the bars that need work, will show here.</Body>
        </View>
      ) : (
        takes.slice(0, 8).map((t) => {
          const v = takeScore(t, settings.reference, settings.strictness);
          return (
            <Pressable key={t.id} accessibilityRole="link" onPress={() => router.push({ pathname: '/review', params: { takeId: t.id } })} style={styles.takeRow}>
              <View style={{ flex: 1 }}>
                <Serif size={16}>{new Date(t.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}, {new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Serif>
                <Text style={styles.small}>{t.region ? `Loop, bars ${t.region.fromBar}–${t.region.toBar}` : 'Whole piece'}</Text>
              </View>
              <Display size={20}>{v === null ? '—' : `${v}%`}</Display>
            </Pressable>
          );
        })
      )}
    </View>
  );

  const score = <ScoreView xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, theme === 'paper' ? styles.paper : styles.ebony]} />;

  const header = (
    <View style={{ gap: 12 }}>
      <TextButton label="← Library" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={styles.titleRow}>
        <Display size={tablet ? 60 : 38} numberOfLines={2}>{piece.title}</Display>
        {piece.composer ? <Serif size={tablet ? 21 : 16} style={{ color: colors.soft }}>{piece.composer}</Serif> : null}
      </View>
      <Text style={styles.details}>{details}</Text>
    </View>
  );

  if (tablet) {
    return (
      <Screen layout={layout}>
        <View style={{ flex: 1, paddingHorizontal: g, paddingTop: 36, paddingBottom: 32 }}>
          {header}
          <Rule style={{ marginTop: 26, marginBottom: 28 }} />
          <View style={{ flex: 1, flexDirection: 'row', gap: 56 }}>
            <View style={{ flex: 1 }}>{score}</View>
            <ScrollView style={{ width: 320, flexGrow: 0 }} contentContainerStyle={{ gap: 28 }}>
              {actions}
              {issueNote}
              {takesBlock}
            </ScrollView>
          </View>
        </View>
      </Screen>
    );
  }

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingTop: 22, paddingBottom: 32, gap: 22 }}>
        {header}
        <View style={{ height: 300 }}>{score}</View>
        {actions}
        {issueNote}
        {takesBlock}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16 },
  details: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 2, textTransform: 'uppercase', color: colors.muted },
  score: { flex: 1 },
  paper: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 18 }, elevation: 10 },
  ebony: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.rule },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  issue: { gap: 6, paddingVertical: 16, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(240,112,90,0.35)' },
  issueTitle: { fontFamily: fonts.serif, fontSize: 18, color: colors.out },
  scoreOld: { fontFamily: fonts.serif, fontSize: 17, color: colors.muted },
  scoreLast: { fontFamily: fonts.display, fontSize: 30, color: colors.ivory },
  small: { fontFamily: fonts.sans, fontSize: 11, color: colors.faint },
  takeRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft, minHeight: 52 },
  emptyTakes: { gap: 6, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
});
