import { Link } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from '@/components/Text';

import { NavBar } from '@/components/nav';
import { Display, Eyebrow, fitTitleSize, GoldButton, Progress, Screen, TextButton, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { takeScore, useTakes } from '@/data/takesStore';
import { useSettings } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

import { greeting, pieceSubtitle, Plus, roman, usePieceStatus } from './LibraryPhone';
import { Tappable } from '@/components/Tappable';
import { go, hrefFor } from '@/navigation/go';

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

  // Sideways: the lit wood on the left, the list on the right. Upright the right column would be
  // too narrow for the list (titles cut to "D maj...", "0 takes" wrapping a letter a line), so the
  // wood runs across the top with the list beneath it.
  const window = useWindowDimensions();
  const upright = window.height > window.width;
  const heroWidth = (upright ? window.width : window.width * 0.58) - 144;
  const heroSize = current ? fitTitleSize(current.title, Math.min(heroWidth, 600), current.title.length > 14 ? 84 : 120) : 84;

  const heroContent = (
    <View style={{ flex: 1, paddingHorizontal: 72, paddingTop: upright ? 48 : 64, paddingBottom: upright ? 48 : 80 }}>
      <View style={styles.heroTop}>
        <Eyebrow tone="cream" style={{ fontSize: 11, letterSpacing: 5 }}>{greeting()}</Eyebrow>
        {upright ? <NavBar current="library" layout="tablet" onWood /> : null}
      </View>
      <View style={{ flex: 1, minHeight: 24 }} />
      {current ? (
        <View style={{ gap: 18, maxWidth: 600 }}>
          <Eyebrow tone="bright" style={{ fontSize: 11 }}>{current.openedAt ? 'Continue' : 'Start here'} · {current.measureCount} bars</Eyebrow>
          <Link href={hrefFor({ kind: 'piece', id: current.id })} asChild>
            <Tappable accessibilityRole="link" style={{ gap: 10 }}>
              <Display size={heroSize} numberOfLines={2} style={styles.heroTitle}>{current.title}</Display>
              <Text style={styles.heroSub} numberOfLines={1}>{pieceSubtitle(current)}</Text>
            </Tappable>
          </Link>
          <Progress value={currentStatus?.score != null ? currentStatus.score / 100 : 0} style={{ marginTop: 8 }} />
          <View style={styles.heroFoot}>
            <Text style={styles.heroNote}>
              {currentStatus?.score != null ? `${currentStatus.score}% in tune last take · ${currentStatus.line}` : 'Not played yet'}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 36 }}>
              <TextButton label="Loop a passage" onPress={() => go({ kind: 'piece', id: current.id, screen: 'choose-bars' })} />
              <GoldButton label={current.openedAt ? 'Resume' : 'Begin'} onPress={() => go({ kind: 'piece', id: current.id, screen: 'practice' })} />
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
  );

  const list = (
    <ScrollView contentContainerStyle={{ paddingTop: upright ? 36 : 60, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
      <View style={styles.listHead}>
        <Display size={40}>Library</Display>
        <Link href="/add-music" asChild>
          <Tappable accessibilityRole="button" style={styles.addLink}>
            <Plus color={colors.gold} size={12} />
            <Text style={styles.addText}>Add music</Text>
          </Tappable>
        </Link>
      </View>
      <View style={{ marginTop: 26 }}>
        {pieces.map((piece, i) => {
          const s = status(piece.id);
          const isCurrent = piece.id === current?.id;
          return (
            <Link key={piece.id} href={hrefFor({ kind: 'piece', id: piece.id })} asChild>
              <Tappable accessibilityRole="link" style={styles.row}>
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
              </Tappable>
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
            <Text style={styles.weekValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{value}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );

  if (upright) {
    return (
      <Screen layout="tablet" edges={[]} glow={false}>
        <Wood variant="hero" style={{ height: Math.round(window.height * 0.5) }}>
          {heroContent}
        </Wood>
        <View style={{ flex: 1, paddingHorizontal: 72 }}>{list}</View>
      </Screen>
    );
  }

  return (
    <Screen layout="tablet" edges={[]} glow={false}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <Wood variant="side" style={{ width: '58%' }}>
          {heroContent}
        </Wood>
        <View style={{ flex: 1, paddingRight: 72, paddingLeft: 56, paddingTop: 50 }}>
          <View style={{ alignItems: 'flex-end' }}>
            <NavBar current="library" layout="tablet" />
          </View>
          {list}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' },
  heroTitle: { color: colors.bright, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 30 },
  heroSub: { fontFamily: fonts.serif, fontSize: 20, color: colors.cream },
  heroFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' },
  heroNote: { fontFamily: fonts.sansLight, fontSize: 15, color: '#CDBB9C' },
  listHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 16 },
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
