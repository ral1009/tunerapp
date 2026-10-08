import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Body, Display, Eyebrow, GoldButton, Maple, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { continuePiece, PIECES } from '@/data/library';
import { colors, fonts } from '@/theme/tokens';

export function LibraryPhone() {
  const g = useGutter('phone');
  const current = continuePiece();
  return (
    <Screen layout="phone" edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={[styles.header, { paddingHorizontal: g }]}>
          <Display size={36}>Library</Display>
          <TextButton label="+ Add music" tone="gold" href="/add-music" />
        </View>

        <Maple style={[styles.continue, { marginHorizontal: g - 8 }]}>
          <View style={styles.continueInner}>
            <Eyebrow tone="bright">Continue</Eyebrow>
            <Display size={30} style={{ marginTop: 12 }}>{current.title}</Display>
            <Serif size={15} style={{ color: colors.cream }}>{current.composer} · {current.movement}</Serif>
            <View style={styles.continueFoot}>
              <Body style={{ color: colors.cream, fontSize: 12, flex: 1 }}>
                {current.lastScore}% last take · {current.needsWork} needs work
              </Body>
              <GoldButton label="Play" href="/practice" style={{ minHeight: 40, paddingHorizontal: 16 }} />
            </View>
          </View>
        </Maple>

        <View style={{ paddingHorizontal: g, marginTop: 30 }}>
          <Eyebrow tone="muted">Your pieces</Eyebrow>
          {PIECES.slice(1).map((piece) => (
            <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
              <Pressable accessibilityRole="link">
                <View style={styles.row}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Serif size={19}>{piece.title}</Serif>
                    <Text style={styles.meta}>
                      {piece.composer} · {piece.takes ? `${piece.takes} takes` : 'not played yet'}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 3 }}>
                    <Display size={22}>{piece.lastScore === null ? '—' : `${piece.lastScore}%`}</Display>
                    <Text style={[styles.meta, { color: piece.trendUp ? colors.good : colors.muted }]}>{piece.trend}</Text>
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
