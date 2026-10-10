import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useServerStatus, type ServerStatus as Status } from '@/config/useServerStatus';
import { colors, fonts } from '@/theme/tokens';

// A small dot and a line saying whether the laptop server answers. While checking, the dot breathes.
export function ServerStatusLine({ style, quietWhenOnline = false }: { style?: StyleProp<ViewStyle>; quietWhenOnline?: boolean }) {
  const { status, address } = useServerStatus();
  if (quietWhenOnline && status === 'online') return null;
  return <StatusView status={status} address={address} style={style} />;
}

function StatusView({ status, address, style }: { status: Status; address: string; style?: StyleProp<ViewStyle> }) {
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (status !== 'checking') {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, pulse]);
  const host = address.replace(/^https?:\/\//, '');
  const text =
    status === 'online'
      ? `Connected to the server at ${host}`
      : status === 'checking'
        ? `Looking for the server at ${host}…`
        : `Can’t reach the server at ${host}. Is it running with --host 0.0.0.0, and is this device on the same Wi-Fi?`;
  return (
    <View style={[styles.row, style]} accessibilityRole="text" accessibilityLiveRegion="polite">
      <Animated.View style={[styles.dot, { opacity: pulse, backgroundColor: status === 'offline' ? colors.outSoft : status === 'online' ? colors.goldBright : colors.muted }]} />
      <Text style={[styles.text, status === 'offline' && { color: colors.outSoft }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 6 },
  text: { flex: 1, fontFamily: fonts.sansLight, fontSize: 12, lineHeight: 19, color: colors.soft },
});
