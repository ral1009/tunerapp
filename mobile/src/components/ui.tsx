import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, gutters } from '@/theme/tokens';

// ---- Screen frame -------------------------------------------------------------------------------

// The ebony ground every screen sits on. Settings › Screens lets either device use the other's
// screens: a phone-layout screen on an iPad is centred in a phone-width column, and an iPad-layout
// screen on a phone is laid out at iPad width and scaled down to fit -- a miniature iPad screen
// rather than a squeezed one.
export function Screen({ children, layout, edges = ['top', 'bottom'] }: {
  children: ReactNode;
  layout: 'phone' | 'tablet';
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
}) {
  const device = useDeviceClass();
  const { width, height } = useWindowDimensions();
  if (layout === 'tablet' && device === 'phone') {
    const scale = width / TABLET_DESIGN_WIDTH;
    return (
      <View style={[styles.ground, { overflow: 'hidden' }]}>
        <View style={{ width: TABLET_DESIGN_WIDTH, height: height / scale, transform: [{ scale }], transformOrigin: 'top left' }}>
          <ScreenBody layout={layout} edges={edges} device="tablet">{children}</ScreenBody>
        </View>
      </View>
    );
  }
  return <ScreenBody layout={layout} edges={edges} device={device}>{children}</ScreenBody>;
}

const TABLET_DESIGN_WIDTH = 1180;

// What the hardware is, ignoring the Screens setting.
function useDeviceClass(): 'phone' | 'tablet' {
  const { width, height } = useWindowDimensions();
  return Math.min(width, height) >= 600 ? 'tablet' : 'phone';
}

function ScreenBody({ children, layout, edges, device }: {
  children: ReactNode;
  layout: 'phone' | 'tablet';
  edges: ('top' | 'bottom' | 'left' | 'right')[];
  device: 'phone' | 'tablet';
}) {
  return (
    <View style={styles.ground}>
      <LinearGradient
        colors={['rgba(70,44,26,0.34)', 'rgba(12,9,7,0)']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.7 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <SafeAreaView edges={edges} style={[styles.flex, layout === 'phone' && device === 'tablet' ? styles.phoneColumn : null]}>
        {children}
      </SafeAreaView>
    </View>
  );
}

export function useGutter(layout: 'phone' | 'tablet'): number {
  return gutters[layout];
}

// A panel of flamed maple under a dark wash, like the edge of an instrument.
export function Maple({ children, style, direction = 'vertical', wash = 'left' }: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  direction?: 'vertical' | 'horizontal';
  wash?: 'left' | 'bottom' | 'even';
}) {
  const washColors: [string, string] =
    wash === 'left' ? ['rgba(12,9,7,0.88)', 'rgba(12,9,7,0.22)'] : wash === 'bottom' ? ['rgba(12,9,7,0.3)', '#0C0907'] : ['rgba(12,9,7,0.55)', 'rgba(12,9,7,0.55)'];
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <Image
        source={direction === 'vertical' ? require('@/assets/images/maple.jpg') : require('@/assets/images/maple-h.jpg')}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
      />
      <LinearGradient
        colors={washColors}
        start={wash === 'left' ? { x: 0.25, y: 0.5 } : { x: 0.5, y: 0 }}
        end={wash === 'left' ? { x: 1, y: 0.5 } : { x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

// ---- Type ----------------------------------------------------------------------------------------

type TextProps = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number };

// Small tracked capitals for labels ("CONTINUE", "YOUR PIECES").
export function Eyebrow({ children, style, tone = 'gold' }: TextProps & { tone?: 'gold' | 'muted' | 'bright' }) {
  const color = tone === 'gold' ? colors.goldDeep : tone === 'bright' ? colors.goldBright : colors.muted;
  return <Text style={[styles.eyebrow, { color }, style]}>{children}</Text>;
}

// Large italic Bodoni: titles, bar numbers, scores.
export function Display({ children, size = 40, style, numberOfLines }: TextProps & { size?: number }) {
  return (
    <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.display, fontSize: size, lineHeight: size * 1.08, color: colors.ivory }, style]}>
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
  return <View style={[{ height: StyleSheet.hairlineWidth * 2, backgroundColor: soft ? colors.ruleSoft : colors.rule }, style]} />;
}

type ButtonProps = { label: string; href?: Href; onPress?: () => void; style?: StyleProp<ViewStyle> };

// The one outlined gold button a screen gets. Plain style objects, not a pressed-state function:
// expo-router's <Link asChild> drops function styles (the outline vanished on the web build).
export function GoldButton({ label, href, onPress, style }: ButtonProps) {
  const inner = (
    <Pressable onPress={onPress} accessibilityRole="button" style={StyleSheet.flatten([styles.goldButton, style])}>
      <Text style={styles.goldButtonText}>{label}</Text>
    </Pressable>
  );
  return href ? <Link href={href} asChild>{inner}</Link> : inner;
}

// Plain tracked-caps text action.
export function TextButton({ label, href, onPress, style, tone = 'cream' }: ButtonProps & { tone?: 'cream' | 'gold' }) {
  const inner = (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8} style={StyleSheet.flatten([styles.textButton, style])}>
      <Text style={[styles.textButtonText, { color: tone === 'gold' ? colors.goldBright : colors.cream }]}>{label}</Text>
    </Pressable>
  );
  return href ? <Link href={href} asChild>{inner}</Link> : inner;
}

// Underlined choice row ("PAPER | EBONY | AUTO").
export function Choice<T extends string | number>({ options, value, onChange, label }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choiceRow}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(option.value)}
            hitSlop={6}
            style={[styles.choice, { borderBottomColor: on ? colors.gold : 'transparent' }]}
          >
            <Text style={[styles.choiceText, { color: on ? colors.goldBright : colors.muted, fontFamily: on ? fonts.sansMedium : fonts.sans }]}>{option.label}</Text>
          </Pressable>
        );
      })}
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

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ebony },
  flex: { flex: 1 },
  phoneColumn: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  eyebrow: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3.6, textTransform: 'uppercase' },
  body: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 22, color: colors.soft },
  goldButton: { minHeight: 52, paddingHorizontal: 26, borderWidth: 1, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  goldButtonText: { fontFamily: fonts.sansMedium, fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', color: colors.goldBright },
  textButton: { minHeight: 44, justifyContent: 'center' },
  textButtonText: { fontFamily: fonts.sans, fontSize: 11, letterSpacing: 2.8, textTransform: 'uppercase' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24 },
  choice: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 1 },
  choiceText: { fontSize: 11, letterSpacing: 2.5, textTransform: 'uppercase' },
  page: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
  pageRule: { position: 'absolute', left: 8, right: 8, top: 8, bottom: 8, borderWidth: 1, borderColor: 'rgba(166,124,58,0.5)' },
  pageCaps: { marginTop: 22, textAlign: 'center', fontFamily: fonts.serif, fontSize: 11, letterSpacing: 1.5, color: '#2A211B' },
});
