import { Link } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Display, Eyebrow, GoldButton, Progress, Screen, Wood } from '@/components/ui';
import { useLibrary, type Piece } from '@/data/libraryStore';
import { takeScore, useTakes, type Take } from '@/data/takesStore';
import { useSettings } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

export function pieceSubtitle(piece: Piece): string {
  const source = piece.source === 'sample' ? 'Starter piece' : piece.source === 'photo' ? 'from a photo' : 'from a file';
  return [piece.composer || null, `${piece.measureCount} bars`, piece.composer ? null : source].filter(Boolean).join(' · ');
}

export function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function roman(n: number): string {
  const table: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [value, glyph] of table) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out;
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
    const line = delta === null ? `${mine.length} take${mine.length === 1 ? '' : 's'}` : delta > 0 ? `up ${delta} since last take` : delta < 0 ? `down ${-delta} since last take` : 'steady';
    return { score: latest, line, up: delta !== null && delta > 0 };
  };
}

// A thin drawn plus, for "add music".
export function Plus({ color = colors.champagne, size = 18 }: { color?: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: 1.2, backgroundColor: color }} />
      <View style={{ position: 'absolute', width: 1.2, height: size, backgroundColor: color }} />
    </View>
  );
}

const HERO = 486;

export function LibraryPhone() {
  const { pieces, current } = useLibrary();
  const status = usePieceStatus();
  const others = pieces.filter((p) => p.id !== current?.id);
  const currentStatus = current ? status(current.id) : null;
  return (
    <Screen layout="phone" edges={[]} glow={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: HERO }} />
        <View style={{ height: HERO }}>
          <View style={styles.top}>
            <Eyebrow tone="cream">{greeting()}</Eyebrow>
            <Link href="/add-music" asChild>
              <Pressable accessibilityRole="button" accessibilityLabel="Add music" style={styles.add}>
                <Plus />
              </Pressable>
            </Link>
          </View>
          <View style={styles.hero}>
            {current ? (
              <>
                <Eyebrow tone="bright">{current.openedAt ? 'Continue' : 'Start here'} · {current.measureCount} bars</Eyebrow>
                <Link href={{ pathname: '/piece/[id]', params: { id: current.id } }} asChild>
                  <Pressable accessibilityRole="link" style={{ gap: 6 }}>
                    <Display size={current.title.length > 14 ? 50 : 66} numberOfLines={2} style={styles.heroTitle}>{current.title}</Display>
                    <Text style={styles.heroSub} numberOfLines={1}>{pieceSubtitle(current)}</Text>
                  </Pressable>
                </Link>
                <Progress value={currentStatus?.score !== null && currentStatus?.score !== undefined ? currentStatus.score / 100 : 0} style={{ marginTop: 6 }} />
                <View style={styles.heroFoot}>
                  <Text style={styles.heroNote}>
                    {currentStatus?.score !== null && currentStatus?.score !== undefined ? `${currentStatus.score}% in tune last take` : 'Not played yet'}
                  </Text>
                  <GoldButton label={current.openedAt ? 'Resume' : 'Begin'} href={{ pathname: '/practice', params: { id: current.id } }} />
                </View>
              </>
            ) : (
              <>
                <Display size={52} style={styles.heroTitle}>Your library is empty</Display>
                <GoldButton label="Add music" href="/add-music" style={{ alignSelf: 'flex-start', marginTop: 8 }} />
              </>
            )}
          </View>
        </View>

        {others.length ? (
          <View style={styles.list}>
            <View style={styles.listHead}>
              <Eyebrow tone="muted">Your pieces</Eyebrow>
              <Text style={styles.count}>{pieces.length}</Text>
            </View>
            {others.map((piece, i) => {
              const s = status(piece.id);
              return (
                <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
                  <Pressable accessibilityRole="link" style={styles.row}>
                    <Text style={styles.numeral}>{roman(i + (current ? 2 : 1))}</Text>
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={styles.title} numberOfLines={1}>{piece.title}</Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {s.score === null && piece.measureIssues.length ? `${pieceSubtitle(piece)} · ${piece.measureIssues.length} bars to check` : pieceSubtitle(piece)}
                      </Text>
                    </View>
                    <Text style={[styles.score, { color: s.score === null ? colors.faint : s.up ? colors.goldBright : colors.cream }]}>
                      {s.score === null ? '—' : `${s.score}%`}
                    </Text>
                  </Pressable>
                </Link>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
      <NavBar current="library" layout="phone" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 28, paddingRight: 16, paddingTop: 50 },
  add: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  hero: { position: 'absolute', left: 28, right: 28, bottom: 34, gap: 14 },
  heroTitle: { color: colors.bright, textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 24 },
  heroSub: { fontFamily: fonts.serif, fontSize: 15, color: colors.cream },
  heroFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  heroNote: { flex: 1, fontFamily: fonts.sansLight, fontSize: 13, color: '#CDBB9C' },
  list: { paddingHorizontal: 28, marginTop: 8 },
  listHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 },
  count: { fontFamily: fonts.display, fontSize: 13, color: colors.muted },
  row: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 16, borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  numeral: { width: 24, fontFamily: fonts.serif, fontSize: 12, color: colors.goldDeep },
  title: { fontFamily: fonts.serif, fontSize: 19, color: colors.ivory },
  meta: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.muted },
  score: { fontFamily: fonts.display, fontSize: 22 },
});
