import { Link } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Display, Eyebrow, GoldButton, Progress, Screen, TextButton, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { takeScore, useTakes } from '@/data/takesStore';
import { useSettings } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

import { greeting, pieceSubtitle, Plus, roman, usePieceStatus } from './LibraryPhone';

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function LibraryTablet() {
  const { pieces, current } = useLibrary();
  const status = usePieceStatus();
  const takes = useTakes();
  const { settings } = useSettings();
  const currentStatus = current ? status(current.id) : null;

  // This week, across every piece: how many takes, and how the in-tune share moved.
  const [since] = useState(() => Date.now() - WEEK_MS);
  const week = pieces.flatMap((p) => takes.forPiece(p.id)).filter((t) => t.at >= since);
  const scores = week.map((t) => takeScore(t, settings.reference, settings.strictness)).filter((v): v is number => v !== null);
  const best = scores.length ? Math.max(...scores) : null;

  return (
    <Screen layout="tablet" edges={[]} glow={false}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <Wood variant="side" style={{ width: '58%' }}>
          <View style={{ flex: 1, paddingHorizontal: 72, paddingTop: 64, paddingBottom: 80 }}>
            <Eyebrow tone="cream" style={{ fontSize: 11, letterSpacing: 5 }}>{greeting()}</Eyebrow>
            <View style={{ flex: 1 }} />
            {current ? (
              <View style={{ gap: 18, maxWidth: 600 }}>
                <Eyebrow tone="bright" style={{ fontSize: 11 }}>{current.openedAt ? 'Continue' : 'Start here'} · {current.measureCount} bars</Eyebrow>
                <Link href={{ pathname: '/piece/[id]', params: { id: current.id } }} asChild>
                  <Pressable accessibilityRole="link" style={{ gap: 10 }}>
                    <Display size={current.title.length > 14 ? 84 : 120} numberOfLines={2} style={styles.heroTitle}>{current.title}</Display>
                    <Text style={styles.heroSub} numberOfLines={1}>{pieceSubtitle(current)}</Text>
                  </Pressable>
                </Link>
                <Progress value={currentStatus?.score != null ? currentStatus.score / 100 : 0} style={{ marginTop: 8 }} />
                <View style={styles.heroFoot}>
                  <Text style={styles.heroNote}>
                    {currentStatus?.score != null ? `${currentStatus.score}% in tune last take · ${currentStatus.line}` : 'Not played yet'}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 36 }}>
                    <TextButton label="Loop a passage" href={{ pathname: '/choose-bars', params: { id: current.id } }} />
                    <GoldButton label={current.openedAt ? 'Resume' : 'Begin'} href={{ pathname: '/practice', params: { id: current.id } }} />
                  </View>
                </View>
              </View>
            ) : (
              <View style={{ gap: 18 }}>
                <Display size={84} style={styles.heroTitle}>Your library is empty</Display>
                <GoldButton label="Add music" href="/add-music" style={{ alignSelf: 'flex-start' }} />
              </View>
            )}
          </View>
        </Wood>

        <View style={{ flex: 1, paddingRight: 72, paddingLeft: 56, paddingTop: 50 }}>
          <View style={{ alignItems: 'flex-end' }}>
            <NavBar current="library" layout="tablet" />
          </View>
          <ScrollView contentContainerStyle={{ paddingTop: 60, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
            <View style={styles.listHead}>
              <Display size={40}>Library</Display>
              <Link href="/add-music" asChild>
                <Pressable accessibilityRole="button" style={styles.addLink}>
                  <Plus color={colors.gold} size={12} />
                  <Text style={styles.addText}>Add music</Text>
                </Pressable>
              </Link>
            </View>
            <View style={{ marginTop: 26 }}>
              {pieces.map((piece, i) => {
                const s = status(piece.id);
                const isCurrent = piece.id === current?.id;
                return (
                  <Link key={piece.id} href={{ pathname: '/piece/[id]', params: { id: piece.id } }} asChild>
                    <Pressable accessibilityRole="link" style={styles.row}>
                      <Text style={styles.numeral}>{roman(i + 1)}</Text>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={[styles.title, isCurrent && { color: colors.bright }]} numberOfLines={1}>{piece.title}</Text>
                        <Text style={styles.meta} numberOfLines={1}>
                          {piece.measureIssues.length && s.score === null ? `${pieceSubtitle(piece)} · ${piece.measureIssues.length} bars to check` : pieceSubtitle(piece)}
                        </Text>
                      </View>
                      <Text style={[styles.score, { color: s.score === null ? colors.faint : s.up || isCurrent ? colors.goldBright : colors.cream }]}>
                        {s.score === null ? '—' : `${s.score}%`}
                      </Text>
                    </Pressable>
                  </Link>
                );
              })}
            </View>
            <View style={styles.week}>
              {[
                ['This week', `${week.length} take${week.length === 1 ? '' : 's'}`],
                ['Pieces', String(pieces.length)],
                ['Best take', best === null ? '—' : `${best}%`],
              ].map(([label, value]) => (
                <View key={label} style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.weekLabel}>{label}</Text>
                  <Text style={styles.weekValue}>{value}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroTitle: { color: colors.bright, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 30 },
  heroSub: { fontFamily: fonts.serif, fontSize: 20, color: colors.cream },
  heroFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' },
  heroNote: { fontFamily: fonts.sansLight, fontSize: 15, color: '#CDBB9C' },
  listHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  addLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  addText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.gold },
  row: { minHeight: 84, flexDirection: 'row', alignItems: 'center', gap: 22, borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  numeral: { width: 30, fontFamily: fonts.serif, fontSize: 14, color: colors.goldDeep },
  title: { fontFamily: fonts.serif, fontSize: 22, color: colors.ivory },
  meta: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.muted },
  score: { fontFamily: fonts.display, fontSize: 26 },
  week: { flexDirection: 'row', gap: 16, marginTop: 56, paddingTop: 22, borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  weekLabel: { fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 3, textTransform: 'uppercase', color: colors.faint },
  weekValue: { fontFamily: fonts.display, fontSize: 30, color: colors.ivory },
});
