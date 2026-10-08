import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Body, Display, Eyebrow, GoldButton, Maple } from '@/components/ui';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts, gutters } from '@/theme/tokens';

export function WelcomeScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = gutters[layout];
  return (
    <Maple wash="bottom" style={styles.fill}>
      <SafeAreaView style={[styles.fill, { paddingHorizontal: g }]}>
        <Eyebrow tone="bright" style={{ marginTop: 28 }}>TunerApp</Eyebrow>
        <View style={styles.fill} />
        <View style={[styles.copy, tablet && { maxWidth: 560 }]}>
          <Display size={tablet ? 88 : 54} style={{ color: colors.bright }}>{'Practise\nin tune.'}</Display>
          <Body style={{ color: colors.cream, fontSize: tablet ? 17 : 15, lineHeight: tablet ? 28 : 24 }}>
            Play from your own sheet music. The app follows along as you play, then shows you exactly which notes to fix.
          </Body>
        </View>
        <View style={[styles.actions, tablet && { maxWidth: 420 }]}>
          <GoldButton label="Begin" href="/mic-check" />
          <Text style={styles.note}>{"You'll need your violin and a page of music"}</Text>
        </View>
      </SafeAreaView>
    </Maple>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.ebony },
  copy: { gap: 22, marginBottom: 48 },
  actions: { gap: 16, marginBottom: 32 },
  note: { textAlign: 'center', fontFamily: fonts.display, fontSize: 14, color: colors.muted },
});
