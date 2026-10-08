import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme/tokens';

// The tuner's fine gold arc: an engraved scale of ticks and a needle, ±50 cents across ±72°.
// Built from rotated views (no SVG needed); every element pivots on the arc's centre.
const SPAN_DEGREES = 72;
const MAX_CENTS = 50;

export function TunerGauge({ size, cents, active }: { size: number; cents: number | null; active: boolean }) {
  const radius = size / 2;
  const ticks = [];
  for (let k = -12; k <= 12; k += 1) {
    const major = k % 4 === 0;
    ticks.push({
      angle: k * 6,
      length: k === 0 ? size * 0.085 : major ? size * 0.05 : size * 0.026,
      color: k === 0 ? colors.bright : Math.abs(k) <= 2 ? colors.gold : major ? 'rgba(233,223,203,0.55)' : 'rgba(233,223,203,0.25)',
    });
  }
  const clamped = cents === null ? 0 : Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents));
  const needleAngle = (clamped / MAX_CENTS) * SPAN_DEGREES;
  const needleLength = radius * 0.86;
  return (
    <View style={{ width: size, height: radius + 14, overflow: 'hidden' }} accessible accessibilityLabel={cents === null ? 'No note' : `${Math.round(cents)} cents`}>
      <View style={[styles.arc, { width: size, height: size, borderRadius: radius }]} />
      {ticks.map((tick) => (
        <View
          key={tick.angle}
          style={{ position: 'absolute', left: radius - 0.5, top: 0, width: 1, height: radius, transform: [{ rotate: `${tick.angle}deg` }], transformOrigin: [0.5, radius, 0] }}
        >
          <View style={{ width: 1, height: tick.length, backgroundColor: tick.color }} />
        </View>
      ))}
      <View
        style={{
          position: 'absolute',
          left: radius - 1,
          top: radius - needleLength,
          width: 2,
          height: needleLength,
          backgroundColor: active ? colors.bright : 'rgba(246,236,218,0.25)',
          transform: [{ rotate: `${needleAngle}deg` }],
          transformOrigin: [1, needleLength, 0],
          shadowColor: colors.goldBright,
          shadowOpacity: active ? 0.6 : 0,
          shadowRadius: 8,
        }}
      />
      <View style={[styles.hub, { left: radius - 5, top: radius - 5 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  arc: { position: 'absolute', left: 0, top: 0, borderWidth: 1, borderColor: 'rgba(201,164,106,0.45)' },
  hub: { position: 'absolute', width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold },
});
