import { router } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BackLink, Display, GoldButton, Screen, TextButton, useGutter } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { ScoreView } from '@/score/ScoreView';
import { useScoreTheme, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Reading the music: the score on its own, as printed pages on an iPad (each page fits the screen
// whole when the iPad is upright) and as one continuous strip on a phone. Practise opens the
// practice screen; Details opens the piece's progress and takes. Annotation will live here later.
export function ScoreScreen({ layout, id }: { layout: LayoutMode; id: string }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const piece = library.get(id);
  const theme = useScoreTheme();
  const { update } = library;

  // Opening a piece makes it the one "Continue" offers.
  useEffect(() => {
    if (piece) update(piece.id, { openedAt: Date.now() });
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

  const params = { id: piece.id };
  const issues = piece.measureIssues.length;
  const details = [piece.composer || null, `${piece.measureCount} bars`].filter(Boolean).join(' · ');
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const title = <Display size={tablet ? 34 : 28} numberOfLines={tablet ? 1 : 2}>{piece.title}</Display>;
  const subtitle = (
    <Text style={styles.details} numberOfLines={1}>
      {details}
      {issues ? <Text style={styles.issues}>{`  ·  ${issues} ${issues === 1 ? 'bar' : 'bars'} to check`}</Text> : null}
    </Text>
  );
  const detailsButton = <TextButton label="Details" tone="muted" href={{ pathname: '/piece/[id]', params }} />;
  const practise = <GoldButton label="Practise" href={{ pathname: '/practice', params }} style={styles.practise} />;

  return (
    <Screen layout={layout} edges={['top']} glow={false}>
      {tablet ? (
        <View style={[styles.header, { paddingLeft: g - 10, paddingRight: g }]}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <BackLink label="Library" onPress={back} />
            <View style={{ paddingLeft: 10, gap: 2 }}>
              {title}
              {subtitle}
            </View>
          </View>
          <View style={styles.actions}>
            {issues ? <TextButton label="Fix bars" tone="gold" href={{ pathname: '/fix-bar', params }} /> : null}
            {detailsButton}
            {practise}
          </View>
        </View>
      ) : (
        <View style={{ paddingLeft: g - 10, paddingRight: g, paddingTop: 4, paddingBottom: 10, gap: 4 }}>
          <View style={[styles.actions, { justifyContent: 'space-between' }]}>
            <BackLink label="Library" onPress={back} />
            <View style={styles.actions}>
              {detailsButton}
              {practise}
            </View>
          </View>
          <View style={{ paddingLeft: 10, gap: 2 }}>
            {title}
            {subtitle}
          </View>
        </View>
      )}
      <View style={styles.rule} />
      <ScoreView
        xml={piece.xml}
        theme={theme}
        layout={tablet ? 'pages' : 'scroll'}
        style={[styles.score, !tablet && { marginHorizontal: 0, backgroundColor: theme === 'paper' ? colors.paper : colors.ebony }]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, paddingTop: 6, paddingBottom: 12 },
  details: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.soft },
  issues: { color: colors.close },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  practise: { minHeight: 44, paddingHorizontal: 22 },
  rule: { height: 1, backgroundColor: colors.ruleSoft },
  score: { flex: 1 },
});
