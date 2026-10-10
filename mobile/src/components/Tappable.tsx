import * as Haptics from 'expo-haptics';
import { forwardRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, type GestureResponderEvent, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  // A light tick on touch (main buttons, choices, navigation), not on every list row.
  haptic?: boolean;
};

// Every tap answers at once: the element dims the moment a finger lands and comes back on release,
// on the native driver so it responds even while the JavaScript thread is busy. Styles are
// flattened to one object, which also keeps expo-router's <Link asChild> happy (it rejects arrays).
export const Tappable = forwardRef<View, Props>(function Tappable({ style, haptic, onPressIn, onPressOut, disabled, ...rest }, ref) {
  const [opacity] = useState(() => new Animated.Value(1));
  const pressIn = (e: GestureResponderEvent) => {
    Animated.timing(opacity, { toValue: 0.45, duration: 60, useNativeDriver: true }).start();
    if (haptic && Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => undefined);
    onPressIn?.(e);
  };
  const pressOut = (e: GestureResponderEvent) => {
    Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    onPressOut?.(e);
  };
  return (
    <AnimatedPressable
      ref={ref}
      {...rest}
      disabled={disabled}
      onPressIn={pressIn}
      onPressOut={pressOut}
      style={{ ...StyleSheet.flatten(style), opacity: Animated.multiply(opacity, disabled ? 0.45 : 1) }}
    />
  );
});
