import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Body, Display, Eyebrow, GoldButton, Maple, PageThumb, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { continuePiece, PIECES } from '@/data/library';
import { colors, fonts } from '@/theme/tokens';

export function LibraryTablet() {
  const g = useGutter('tablet');
  const current = continuePiece();
  return (
    <Screen layout="tablet">
      <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingBottom: 56 }}>
        <View style={styles.header}>
          <View style={{ gap: 14 }}>
            <Eyebrow>Good evening</Eyebrow>
            <Display size={64}>Library</Display>
          </View>
          <NavBar current="library" layout="tablet" />
        </View>
        <Rule />

        <Maple direction="horizontal" style={styles.continue}>
          <View style={styles.continueInner}>
            <View style={{ flex: 1, minWidth: 280 }}>
              <Eyebrow tone="bright">Continue where you left off</Eyebrow>
              <View style={styles.titleRow}>
                <Display size={46}>{current.title}</Display>
                <Serif size={19} style={{ color: colors.cream }}>{current.composer} · {current.movement}</Serif>
              </View>
              <Body style={{ color: colors.cream }}>
                {current.lastScore}% in tune on your last take · {current.needsWork} still needs work
              </Body>
            </View>
            <View style={styles.continueActions}>
              <TextButton label="Loop bar 14" href="/choose-bars" />
              <GoldButton label="Play from the start" href="/practice" />
            </View>
          </View>
        </Maple>

        <Eyebrow tone="muted" style={{ marginTop: 40, marginBottom: 22 }}>Your pieces</Eyebrow>
        <View style={styles.grid}>
          {PIECES.map((piece) => (
            <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
              <Pressable accessibilityRole="link" style={styles.tile}>
                <PageThumb caps={piece.caps} style={styles.thumb} />
                <View style={styles.tileTitle}>
                  <Serif size={18} numberOfLines={1} style={{ flex: 1 }}>{piece.title}</Serif>
                  <Display size={18} style={{ color: colors.gold }}>{piece.lastScore === null ? '—' : `${piece.lastScore}%`}</Display>
                </View>
                <Text style={styles.meta}>{piece.composer} · {piece.takes ? `${piece.takes} takes` : 'new'}</Text>
              </Pressable>
            </Link>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, paddingTop: 40, paddingBottom: 26 },
  continue: { marginTop: 36, borderWidth: 1, borderColor: 'rgba(201,164,106,0.35)' },
  continueInner: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 28, padding: 40 },
  titleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, marginTop: 14, marginBottom: 10 },
  continueActions: { flexDirection: 'row', alignItems: 'center', gap: 28 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 40 },
  tile: { width: 190, gap: 12 },
  thumb: { height: 260 },
  tileTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  meta: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted, marginTop: -6 },
});
