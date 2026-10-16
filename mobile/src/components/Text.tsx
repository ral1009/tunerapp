import { forwardRef } from 'react';
import { Text as NativeText, type TextProps } from 'react-native';

// Every piece of text in the app. Follows the player's system text size, but only up to 1.3x:
// beyond that the rows of tracked capitals and the large italic numerals no longer fit their
// screens and get cut off. A screen can still pass its own maxFontSizeMultiplier.
export const MAX_TEXT_SCALE = 1.3;

export const Text = forwardRef<NativeText, TextProps>(function Text(props, ref) {
  return <NativeText ref={ref} maxFontSizeMultiplier={MAX_TEXT_SCALE} {...props} />;
});
