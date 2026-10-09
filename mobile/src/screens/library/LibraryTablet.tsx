import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Body, Display, Eyebrow, GoldButton, Maple, PageThumb, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { pageCaps, useLibrary } from '@/data/libraryStore';
import { colors, fonts } from '@/theme/tokens';

import { pieceSubtitle, usePieceStatus } from './LibraryPhone';

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function LibraryTablet() {
  const g = useGutter('tablet');
  const { pieces, current } = useLibrary();
  const status = usePieceStatus();
  return (
    <Screen layout="tablet">
      <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingBottom: 56 }}>
        <View style={styles.header}>
          <View style={{ gap: 14 }}>
            <Eyebrow>{greeting()}</Eyebrow>
            <Display size={64}>Library</Display>
          </View>
          <NavBar current="library" layout="tablet" />
        </View>
        <Rule />

        {current ? (
          <Maple direction="horizontal" style={styles.continue}>
            <View style={styles.continueInner}>
              <View style={{ flex: 1, minWidth: 280 }}>
                <Eyebrow tone="bright">{current.openedAt ? 'Continue where you left off' : 'Start here'}</Eyebrow>
                <View style={styles.titleRow}>
                  <Display size={46} numberOfLines={1}>{current.title}</Display>
                  <Serif size={19} style={{ color: colors.cream }}>{current.composer}</Serif>
                </View>
                <Body style={{ color: colors.cream }}>{status(current.id).score !== null ? `${status(current.id).score}% in tune on your last take` : 'Not played yet'} · {current.measureCount} bars</Body>
              </View>
              <View style={styles.continueActions}>
                <TextButton label="Loop a passage" href={{ pathname: '/choose-bars', params: { id: current.id } }} />
                <GoldButton label="Open" href={{ pathname: '/piece/[id]', params: { id: current.id } }} />
              </View>
            </View>
          </Maple>
        ) : null}

        <Eyebrow tone="muted" style={{ marginTop: 40, marginBottom: 22 }}>Your pieces</Eyebrow>
        <View style={styles.grid}>
          {pieces.map((piece) => (
            <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
              <Pressable accessibilityRole="link" style={styles.tile}>
                <PageThumb caps={pageCaps(piece)} style={styles.thumb} />
                <View style={styles.tileTitle}>
                  <Serif size={18} numberOfLines={1} style={{ flex: 1 }}>{piece.title}</Serif>
                  <Display size={18} style={{ color: colors.gold }}>{status(piece.id).score === null ? '—' : `${status(piece.id).score}%`}</Display>
                </View>
                <Text style={styles.meta} numberOfLines={1}>{pieceSubtitle(piece)}</Text>
              </Pressable>
            </Link>
          ))}
          <Link href="/add-music" asChild>
            <Pressable accessibilityRole="button" style={styles.tile}>
              <View style={[styles.thumb, styles.addTile]}>
                <Display size={44} style={{ color: colors.gold }}>+</Display>
                <Text style={[styles.meta, { color: colors.goldBright, letterSpacing: 2.5, textTransform: 'uppercase', marginTop: 0 }]}>Add music</Text>
              </View>
            </Pressable>
          </Link>
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
  addTile: { borderWidth: 1, borderColor: colors.rule, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 6 },
  tileTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  meta: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted, marginTop: -6 },
});
