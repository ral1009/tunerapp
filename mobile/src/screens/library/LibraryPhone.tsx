import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Body, Display, Eyebrow, GoldButton, Maple, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useLibrary, type Piece } from '@/data/libraryStore';
import { colors, fonts } from '@/theme/tokens';

export function pieceSubtitle(piece: Piece): string {
  const source = piece.source === 'sample' ? 'starter piece' : piece.source === 'photo' ? 'from a photo' : 'from a file';
  return [piece.composer, `${piece.measureCount} bars`, source].filter(Boolean).join(' · ');
}

export function LibraryPhone() {
  const g = useGutter('phone');
  const { pieces, current } = useLibrary();
  return (
    <Screen layout="phone" edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={[styles.header, { paddingHorizontal: g }]}>
          <Display size={36}>Library</Display>
          <TextButton label="+ Add music" tone="gold" href="/add-music" />
        </View>

        {current ? (
          <Maple style={[styles.continue, { marginHorizontal: g - 8 }]}>
            <View style={styles.continueInner}>
              <Eyebrow tone="bright">{current.openedAt ? 'Continue' : 'Start here'}</Eyebrow>
              <Display size={30} style={{ marginTop: 12 }} numberOfLines={1}>{current.title}</Display>
              <Serif size={15} style={{ color: colors.cream }}>{current.composer}</Serif>
              <View style={styles.continueFoot}>
                <Body style={{ color: colors.cream, fontSize: 12, flex: 1 }}>Not played yet</Body>
                <GoldButton label="Open" href={{ pathname: '/piece/[id]', params: { id: current.id } }} style={{ minHeight: 40, paddingHorizontal: 16 }} />
              </View>
            </View>
          </Maple>
        ) : null}

        <View style={{ paddingHorizontal: g, marginTop: 30 }}>
          <Eyebrow tone="muted">Your pieces</Eyebrow>
          {pieces.map((piece) => (
            <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
              <Pressable accessibilityRole="link">
                <View style={styles.row}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Serif size={19} numberOfLines={1}>{piece.title}</Serif>
                    <Text style={styles.meta}>{pieceSubtitle(piece)}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 3 }}>
                    <Display size={22}>—</Display>
                    <Text style={styles.meta}>{piece.measureIssues.length ? `${piece.measureIssues.length} bars to check` : 'new'}</Text>
                  </View>
                </View>
                <Rule soft />
              </Pressable>
            </Link>
          ))}
        </View>
      </ScrollView>
      <NavBar current="library" layout="phone" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 24, paddingBottom: 18 },
  continue: { height: 200, borderWidth: 1, borderColor: 'rgba(201,164,106,0.35)' },
  continueInner: { flex: 1, padding: 24 },
  continueFoot: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
  meta: { fontFamily: fonts.sans, fontSize: 12, color: colors.muted },
});
