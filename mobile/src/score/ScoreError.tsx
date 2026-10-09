import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/theme/tokens';

// Shown over the score when the engine reports it couldn't read or draw the music, so a failure
// says so instead of leaving the screen on "Opening the score…".
export function ScoreError({ message }: { message: string }) {
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Text style={styles.title}>The music couldn&rsquo;t be opened</Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8, backgroundColor: colors.paper },
  title: { fontFamily: fonts.display, fontSize: 22, color: colors.paperInk, textAlign: 'center' },
  message: { fontFamily: fonts.sansLight, fontSize: 13, lineHeight: 20, color: '#6B5D4C', textAlign: 'center' },
});
