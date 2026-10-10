import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, type Href } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSettings } from '@/theme/settings';
import { colors, fonts, gutters } from '@/theme/tokens';
import { woodFor } from '@/theme/woods';
import { Tappable } from '@/components/Tappable';

// "Atelier": ebony black, one lit wood surface per screen, ivory Bodoni, gold hairlines.
// See the "Violin App — Wood & Luxury" canvas for every screen this kit builds.

// ---- Screen frame -------------------------------------------------------------------------------

// The ebony ground every screen sits on. Settings › Screens lets either device use the other's
// screens: a phone-layout screen on an iPad is centred in a phone-width column, and an iPad-layout
// screen on a phone is laid out at iPad width and scaled down to fit -- a miniature iPad screen
// rather than a squeezed one.
export function Screen({ children, layout, edges = ['top', 'bottom'], glow = true }: {
  children: ReactNode;
  layout: 'phone' | 'tablet';
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  glow?: boolean;
}) {
  const device = useDeviceClass();
  const { width, height } = useWindowDimensions();
  if (layout === 'tablet' && device === 'phone') {
    const scale = width / TABLET_DESIGN_WIDTH;
    return (
      <View style={[styles.ground, { overflow: 'hidden' }]}>
        <View style={{ width: TABLET_DESIGN_WIDTH, height: height / scale, transform: [{ scale }], transformOrigin: 'top left' }}>
          <ScreenBody layout={layout} edges={edges} device="tablet" glow={glow}>{children}</ScreenBody>
        </View>
      </View>
    );
  }
  return <ScreenBody layout={layout} edges={edges} device={device} glow={glow}>{children}</ScreenBody>;
}

const TABLET_DESIGN_WIDTH = 1180;

// What the hardware is, ignoring the Screens setting.
function useDeviceClass(): 'phone' | 'tablet' {
  const { width, height } = useWindowDimensions();
  return Math.min(width, height) >= 600 ? 'tablet' : 'phone';
}

function ScreenBody({ children, layout, edges, device, glow }: {
  children: ReactNode;
  layout: 'phone' | 'tablet';
  edges: ('top' | 'bottom' | 'left' | 'right')[];
  device: 'phone' | 'tablet';
  glow: boolean;
}) {
  return (
    <View style={styles.ground}>
      {glow ? (
        <LinearGradient
          colors={['rgba(120,70,30,0.26)', 'rgba(11,8,6,0)']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.4 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      <SafeAreaView edges={edges} style={[styles.flex, layout === 'phone' && device === 'tablet' ? styles.phoneColumn : null]}>
        {children}
      </SafeAreaView>
    </View>
  );
}

export function useGutter(layout: 'phone' | 'tablet'): number {
  return gutters[layout];
}

// ---- Wood ---------------------------------------------------------------------------------------

// The player's chosen wood (Settings › Wood), lit from the upper left and washed into the ebony
// ground. Each screen gets one of these, never more:
//   hero  -- a top section that fades into the ground (Library, Piece, Review)
//   band  -- a footer band whose top edge melts out of the ground (Practising, Fix a bar)
//   full  -- the whole screen, darkest at the bottom where the copy sits (Welcome)
//   dim   -- the whole screen, evenly dark with a lit centre (Tuner)
//   side  -- a left column fading out to the right (iPad Library and Review)
export type WoodVariant = 'hero' | 'band' | 'full' | 'dim' | 'side' | 'swatch';

const WASHES: Record<Exclude<WoodVariant, 'side' | 'swatch'>, { colors: [string, string, ...string[]]; locations: [number, number, ...number[]] }> = {
  hero: { colors: ['rgba(11,8,6,0.55)', 'rgba(11,8,6,0)', 'rgba(11,8,6,0.1)', colors.ebony], locations: [0, 0.22, 0.48, 1] },
  band: { colors: [colors.ebony, 'rgba(11,8,6,0.72)', 'rgba(11,8,6,0.58)', 'rgba(11,8,6,0.84)'], locations: [0, 0.3, 0.7, 1] },
  full: { colors: ['rgba(11,8,6,0.35)', 'rgba(11,8,6,0.15)', 'rgba(11,8,6,0.7)', colors.ebony], locations: [0, 0.3, 0.58, 0.85] },
  dim: { colors: ['rgba(11,8,6,0.82)', 'rgba(11,8,6,0.45)', 'rgba(11,8,6,0.55)', 'rgba(11,8,6,0.96)'], locations: [0, 0.3, 0.55, 1] },
};

export function Wood({ variant, style, children }: { variant: WoodVariant; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const { settings } = useSettings();
  const wood = woodFor(settings.wood);
  return (
    <View style={[{ overflow: 'hidden' }, style]} pointerEvents="box-none">
      <Image
        source={wood.source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        contentPosition={{ left: `${wood.focus.x * 100}%`, top: `${wood.focus.y * 100}%` }}
        transition={200}
      />
      {variant === 'swatch' ? null : (
        <LinearGradient
          colors={['rgba(255,226,172,0.20)', 'rgba(255,226,172,0)']}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.7, y: 0.6 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {variant === 'side' ? (
        <>
          <LinearGradient colors={['rgba(11,8,6,0)', 'rgba(11,8,6,0.1)', colors.ebony]} locations={[0, 0.55, 1]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <LinearGradient colors={['rgba(11,8,6,0.5)', 'rgba(11,8,6,0.05)', 'rgba(11,8,6,0.35)', 'rgba(11,8,6,0.92)']} locations={[0, 0.25, 0.6, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        </>
      ) : variant === 'swatch' ? null : (
        <LinearGradient colors={WASHES[variant].colors} locations={WASHES[variant].locations} style={StyleSheet.absoluteFill} pointerEvents="none" />
      )}
      {children}
    </View>
  );
}

// The black-white-black inlay that runs round a violin's edge.
export function Purfling({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.purfling, style]} />;
}

// ---- Type ----------------------------------------------------------------------------------------

type TextProps = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number };

// Small tracked capitals for labels ("CONTINUE", "YOUR PIECES").
export function Eyebrow({ children, style, tone = 'gold' }: TextProps & { tone?: 'gold' | 'muted' | 'bright' | 'cream' }) {
  const color = tone === 'gold' ? colors.gold : tone === 'bright' ? colors.goldBright : tone === 'cream' ? colors.champagne : colors.muted;
  return <Text style={[styles.eyebrow, { color }, style]}>{children}</Text>;
}

// Large italic Bodoni: titles, bar numbers, scores.
export function Display({ children, size = 40, style, numberOfLines }: TextProps & { size?: number }) {
  return (
    <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.display, fontSize: size, lineHeight: size * 1.04, color: colors.bright }, style]}>
      {children}
    </Text>
  );
}

// Roman Bodoni for item titles.
export function Serif({ children, size = 18, style, numberOfLines }: TextProps & { size?: number }) {
  return (
    <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.serif, fontSize: size, color: colors.ivory }, style]}>
      {children}
    </Text>
  );
}

export function Body({ children, style, numberOfLines }: TextProps) {
  return (
    <Text numberOfLines={numberOfLines} style={[styles.body, style]}>
      {children}
    </Text>
  );
}

// ---- Rules and controls ---------------------------------------------------------------------------

export function Rule({ style, soft }: { style?: StyleProp<ViewStyle>; soft?: boolean }) {
  return <View style={[{ height: 1, backgroundColor: soft ? colors.ruleSoft : colors.rule }, style]} />;
}

// A thin progress line: a hairline with a gold run along it.
export function Progress({ value, style }: { value: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.progressTrack, style]}>
      <View style={[styles.progressRun, { width: `${Math.max(0, Math.min(1, value)) * 100}%` }]} />
    </View>
  );
}

type ButtonProps = { label: string; href?: Href; onPress?: () => void; style?: StyleProp<ViewStyle>; disabled?: boolean };

// The one gold-outlined button a screen gets. Plain style objects, not a pressed-state function:
// expo-router's <Link asChild> drops function styles (the outline vanished on the web build).
export function GoldButton({ label, href, onPress, style, disabled }: ButtonProps) {
  const inner = (
    <Tappable haptic onPress={onPress} disabled={disabled} accessibilityRole="button" style={StyleSheet.flatten([styles.goldButton, disabled && { opacity: 0.45 }, style])}>
      <Text style={styles.goldButtonText}>{label}</Text>
    </Tappable>
  );
  return href ? <Link href={href} asChild>{inner}</Link> : inner;
}

// Plain tracked-caps text action, optionally with a fine arrow.
export function TextButton({ label, href, onPress, style, tone = 'cream', arrow }: ButtonProps & { tone?: 'cream' | 'gold' | 'muted'; arrow?: boolean }) {
  const color = tone === 'gold' ? colors.champagne : tone === 'muted' ? colors.soft : colors.cream;
  const inner = (
    <Tappable onPress={onPress} accessibilityRole="button" hitSlop={8} style={StyleSheet.flatten([styles.textButton, style])}>
      <Text style={[styles.textButtonText, { color }]}>{label}</Text>
      {arrow ? <Arrow color={color} /> : null}
    </Tappable>
  );
  return href ? <Link href={href} asChild>{inner}</Link> : inner;
}

// "‹ AUTUMN" at the top of a screen.
export function BackLink({ label, onPress, href, tone = 'gold' }: { label: string; onPress?: () => void; href?: Href; tone?: 'gold' | 'light' }) {
  const color = tone === 'gold' ? colors.gold : colors.champagne;
  const inner = (
    <Tappable onPress={onPress} accessibilityRole="link" accessibilityLabel={`Back to ${label}`} hitSlop={8} style={styles.back}>
      <View style={[styles.chevron, { borderColor: color }]} />
      <Text style={[styles.backText, { color }]}>{label}</Text>
    </Tappable>
  );
  return href ? <Link href={href} asChild>{inner}</Link> : inner;
}

// A fine right arrow, drawn: a hairline shaft and a chevron head.
export function Arrow({ color = colors.gold, width = 16 }: { color?: string; width?: number }) {
  return (
    <View style={{ width, height: 10, justifyContent: 'center' }}>
      <View style={{ height: 1, backgroundColor: color, width: width - 1 }} />
      <View style={{ position: 'absolute', right: 1, width: 7, height: 7, borderTopWidth: 1, borderRightWidth: 1, borderColor: color, transform: [{ rotate: '45deg' }] }} />
    </View>
  );
}

// Underlined choice row ("RELAXED  STANDARD  STRICT").
export function Choice<T extends string | number>({ options, value, onChange, label, gap = 22 }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  gap?: number;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.choiceRow, { columnGap: gap }]}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Tappable
            key={String(option.value)}
            haptic
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(option.value)}
            hitSlop={6}
            style={[styles.choice, { borderBottomColor: on ? colors.goldBright : 'transparent' }]}
          >
            <Text style={[styles.choiceText, { color: on ? colors.ivory : colors.faintText }]}>{option.label}</Text>
          </Tappable>
        );
      })}
    </View>
  );
}

// Intonation: a fine engraved scale of ±50 cents with one gold marker. Fills its parent's width.
// The marker glides between readings (they arrive ~8 a second) instead of jumping: each new
// reading eases it over a little longer than the gap between readings, on the native driver, so
// it moves continuously and costs the JavaScript thread nothing. No note: it fades out in place.
const MARKER_GLIDE_MS = 150;

export function IntonationScale({ cents, style }: { cents: number | null; style?: StyleProp<ViewStyle> }) {
  const ticks = [];
  for (let c = -50; c <= 50; c += 10) ticks.push(c);
  const clamped = cents === null ? null : Math.max(-50, Math.min(50, cents));
  const [width, setWidth] = useState(0);
  const [position] = useState(() => new Animated.Value(0.5));
  const [shown] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (clamped === null) {
      Animated.timing(shown, { toValue: 0, duration: 260, useNativeDriver: true }).start();
      return;
    }
    Animated.parallel([
      Animated.timing(position, { toValue: (50 + clamped) / 100, duration: MARKER_GLIDE_MS, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(shown, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  }, [clamped, position, shown]);
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[{ height: 40 }, style]}
      accessible
      accessibilityLabel={cents === null ? 'No note' : `${Math.abs(Math.round(cents))} cents ${cents >= 0 ? 'sharp' : 'flat'}`}
    >
      <View style={{ position: 'absolute', left: 0, right: 0, top: 14, height: 1, backgroundColor: 'rgba(237,227,207,0.28)' }} />
      {ticks.map((c) => {
        const centre = c === 0;
        const near = Math.abs(c) === 10;
        return (
          <View
            key={c}
            style={{
              position: 'absolute',
              left: `${50 + c}%`,
              top: centre ? 4 : 10,
              width: 1,
              height: centre ? 20 : 8,
              backgroundColor: centre ? colors.ivory : near ? 'rgba(201,164,106,0.8)' : 'rgba(237,227,207,0.3)',
            }}
          />
        );
      })}
      <Animated.View
        style={[styles.marker, { opacity: shown, transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, width] }) }] }]}
      />
      <Text style={[styles.scaleLabel, { left: 0 }]}>Flat</Text>
      <Text style={[styles.scaleLabel, { right: 0 }]}>Sharp</Text>
    </View>
  );
}

// A small white printed page: the library's picture of a piece.
export function PageThumb({ caps, style }: { caps: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.page, style]}>
      <View style={styles.pageRule} />
      <Text style={styles.pageCaps}>{caps}</Text>
      <View style={{ position: 'absolute', left: 18, right: 18, top: 46, gap: 18 }}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <View key={i} style={{ gap: 2.4 }}>
            {[0, 1, 2, 3, 4].map((k) => (
              <View key={k} style={{ height: 1, backgroundColor: 'rgba(20,17,14,0.55)' }} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// The ivory sheet the score sits on.
export const paperSheet: ViewStyle = {
  backgroundColor: colors.paper,
  shadowColor: '#000',
  shadowOpacity: 0.7,
  shadowRadius: 30,
  shadowOffset: { width: 0, height: 22 },
  elevation: 12,
};

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ebony },
  flex: { flex: 1 },
  phoneColumn: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  purfling: { height: 5, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(10,6,3,0.9)', backgroundColor: 'rgba(234,211,162,0.55)' },
  eyebrow: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 4, textTransform: 'uppercase' },
  body: { fontFamily: fonts.sansLight, fontSize: 14, lineHeight: 22, color: colors.soft },
  progressTrack: { height: 1, backgroundColor: 'rgba(237,227,207,0.16)' },
  progressRun: { height: 1, backgroundColor: colors.goldBright },
  goldButton: { minHeight: 48, paddingHorizontal: 30, borderWidth: 1, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  goldButtonText: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 3.5, textTransform: 'uppercase', color: colors.champagne },
  textButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  textButtonText: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 3.5, textTransform: 'uppercase' },
  back: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start' },
  chevron: { width: 8, height: 8, borderLeftWidth: 1.2, borderBottomWidth: 1.2, transform: [{ rotate: '45deg' }], marginLeft: 3 },
  backText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 4, textTransform: 'uppercase' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap' },
  choice: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 1 },
  choiceText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase' },
  marker: { position: 'absolute', left: 0, top: 0, width: 2, height: 28, marginLeft: -1, backgroundColor: colors.markerGold, shadowColor: colors.markerGold, shadowOpacity: 0.7, shadowRadius: 8 },
  scaleLabel: { position: 'absolute', top: 28, fontFamily: fonts.sans, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: colors.muted },
  page: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
  pageRule: { position: 'absolute', left: 8, right: 8, top: 8, bottom: 8, borderWidth: 1, borderColor: 'rgba(166,124,58,0.5)' },
  pageCaps: { marginTop: 22, textAlign: 'center', fontFamily: fonts.serif, fontSize: 11, letterSpacing: 1.5, color: '#2A211B' },
});
