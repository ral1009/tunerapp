import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import type { ScoreTheme } from '@core/score/engine/protocol';

import { colors } from '@/theme/tokens';

const INK = { paper: 'rgba(20,17,14,0.13)', ebony: 'rgba(239,229,209,0.10)' };
const STAVES = 14;

// Faint empty staves in the score's place while the music is drawn, faded out once it's there,
// so a score never shows as a blank or half-drawn box.
export function ScorePlaceholder({ theme, visible }: { theme: ScoreTheme; visible: boolean }) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [gone, setGone] = useState(false);
  // Shown again (a new score loading): back in at once.
  if (visible && gone) setGone(false);
  useEffect(() => {
    if (visible) {
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(({ finished }) => finished && setGone(true));
  }, [visible, opacity]);
  if (gone) return null;
  const ink = INK[theme];
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.wrap, { opacity, backgroundColor: theme === 'paper' ? colors.paper : colors.ebony }]}>
      {Array.from({ length: STAVES }, (_, i) => (
        <View key={i} style={styles.staff}>
          {[0, 1, 2, 3, 4].map((k) => (
            <View key={k} style={[styles.line, { backgroundColor: ink }]} />
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', paddingHorizontal: 18, paddingTop: 28 },
  staff: { gap: 6, marginBottom: 46 },
  line: { height: 1 },
});
