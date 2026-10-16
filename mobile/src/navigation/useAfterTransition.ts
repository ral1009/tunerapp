import { useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

// False until the screen has finished sliding in. Heavy views (the score's WebView) wait for it,
// so the slide itself runs smoothly instead of stuttering while they're built. A screen that
// didn't slide in (the first one, a reset) never gets the event, so a short timeout stands in.
const FALLBACK_MS = 450;

export function useAfterTransition(): boolean {
  const navigation = useNavigation();
  const [done, setDone] = useState(Platform.OS === 'web');
  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => setDone(true), FALLBACK_MS);
    const unsubscribe = (navigation as unknown as { addListener: (event: string, cb: () => void) => () => void }).addListener('transitionEnd', () => setDone(true));
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [navigation, done]);
  return done;
}
