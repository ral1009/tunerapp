import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { EngineEvent, ScoreMeta } from '@core/score/engine/protocol';

import { Body, Display, Eyebrow, GoldButton, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
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

  const takes = (
    <View>
      <Eyebrow tone="muted">Takes</Eyebrow>
      <View style={styles.emptyTakes}>
        <Serif size={17} style={{ color: colors.cream }}>No takes yet</Serif>
        <Body style={{ fontSize: 13 }}>Play it through once and your progress, and the bars that need work, will show here.</Body>
      </View>
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
              {takes}
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
        {takes}
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
  emptyTakes: { gap: 6, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
});
