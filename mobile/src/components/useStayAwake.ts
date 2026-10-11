import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect } from 'react';
import { Platform } from 'react-native';

// Keeps the screen on while this screen is open. A player doesn't touch the phone while playing,
// so it auto-locked within a minute; iOS then suspends the app, which stops the microphone and
// drops the connection to the server -- "it keeps disconnecting on my phone and iPad, never on
// the laptop". Devices only: the web build's wake lock needs a secure page.
export function useStayAwake(tag: string): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    activateKeepAwakeAsync(tag).catch(() => undefined);
    return () => {
      void Promise.resolve(deactivateKeepAwake(tag)).catch(() => undefined);
    };
  }, [tag]);
}
