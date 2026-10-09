import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Display, GoldButton, TextButton, Wood } from '@/components/ui';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts, gutters } from '@/theme/tokens';

export function WelcomeScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = gutters[layout];
  return (
    <Wood variant="full" style={styles.fill}>
      <SafeAreaView style={[styles.fill, { paddingHorizontal: g }]}>
        <View style={styles.eyebrowRow}>
          <View style={styles.eyebrowLine} />
          <Text style={styles.eyebrow}>Intonation, bar by bar</Text>
        </View>
        <View style={styles.fill} />
        <View style={[styles.copy, tablet && { maxWidth: 560 }]}>
          <Display size={tablet ? 96 : 58} style={{ lineHeight: tablet ? 96 : 58 }}>Play it in tune.</Display>
          <Text style={[styles.body, tablet && { fontSize: 18, lineHeight: 30 }]}>
            Bring your music and play it through. Afterwards you&rsquo;ll see exactly which notes drifted — and you can loop the bars that need you.
          </Text>
        </View>
        <View style={[styles.actions, tablet && { maxWidth: 420 }]}>
          <GoldButton label="Begin" href="/add-music" style={{ minHeight: 52 }} />
          <TextButton label="Check my microphone first" tone="muted" href="/mic-check" style={{ alignSelf: 'center' }} />
        </View>
      </SafeAreaView>
    </Wood>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.ebony },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 26 },
  eyebrowLine: { width: 28, height: 1, backgroundColor: colors.goldBright },
  eyebrow: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 4.5, textTransform: 'uppercase', color: colors.champagne },
  copy: { gap: 22, marginBottom: 30 },
  body: { fontFamily: fonts.sansLight, fontSize: 15, lineHeight: 24, color: colors.cream },
  actions: { gap: 6, marginBottom: 40 },
});
