import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Body, Display, Eyebrow, GoldButton, Maple, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useLibrary, type Piece } from '@/data/libraryStore';
import { takeScore, useTakes, type Take } from '@/data/takesStore';
import { useSettings } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

export function pieceSubtitle(piece: Piece): string {
  const source = piece.source === 'sample' ? 'starter piece' : piece.source === 'photo' ? 'from a photo' : 'from a file';
  return [piece.composer, `${piece.measureCount} bars`, source].filter(Boolean).join(' · ');
}

// The latest whole-piece score (or loop, if that's all there is), and how it moved since the take before.
export function usePieceStatus(): (pieceId: string) => { score: number | null; line: string; up: boolean } {
  const takes = useTakes();
  const { settings } = useSettings();
  return (pieceId) => {
    const mine = takes.forPiece(pieceId);
    if (mine.length === 0) return { score: null, line: 'Not played yet', up: false };
    const whole = mine.filter((t: Take) => !t.region);
    const pool = whole.length ? whole : mine;
    const latest = takeScore(pool[0], settings.reference, settings.strictness);
    const before = pool[1] ? takeScore(pool[1], settings.reference, settings.strictness) : null;
    const delta = latest !== null && before !== null ? latest - before : null;
    const line = delta === null ? `${mine.length} take${mine.length === 1 ? '' : 's'}` : delta > 0 ? `+ ${delta} since last take` : delta < 0 ? `− ${-delta} since last take` : 'steady';
    return { score: latest, line, up: delta !== null && delta > 0 };
  };
}

export function LibraryPhone() {
  const g = useGutter('phone');
  const { pieces, current } = useLibrary();
  const status = usePieceStatus();
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
                <Body style={{ color: colors.cream, fontSize: 12, flex: 1 }}>{status(current.id).score !== null ? `${status(current.id).score}% last take` : 'Not played yet'}</Body>
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
                    <Display size={22}>{status(piece.id).score === null ? '—' : `${status(piece.id).score}%`}</Display>
                    <Text style={[styles.meta, status(piece.id).up && { color: colors.good }]}>
                      {status(piece.id).score === null && piece.measureIssues.length ? `${piece.measureIssues.length} bars to check` : status(piece.id).line}
                    </Text>
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
