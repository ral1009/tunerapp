import { Platform } from 'react-native';

import { colors } from '@/theme/tokens';

// Every stack: no header, the ebony ground behind each screen (so nothing flashes white while a
// screen draws or the device turns), and the platform's own push: iOS slides in from the right
// with a swipe-back that follows the finger; Android gets the same slide rather than its default
// rise-and-fade, so both read the same way.
export const stackOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.ebony },
  animation: Platform.OS === 'android' ? ('slide_from_right' as const) : ('default' as const),
  gestureEnabled: true,
  fullScreenGestureEnabled: true,
};

// Top-level tabs (Tuner, Settings) crossfade instead: switching tabs isn't going deeper.
export const tabOptions = { animation: 'fade' as const, animationDuration: 180 };
