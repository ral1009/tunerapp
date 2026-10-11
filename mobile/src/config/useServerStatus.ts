import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { serverUrl } from './server';

export type ServerStatus = 'checking' | 'online' | 'offline';

const CHECK_EVERY_MS = 4000;
// Generous: a phone's Wi-Fi radio sleeps between requests and can take a second or two to answer
// after waking, especially right after the app comes back to the front.
const CHECK_TIMEOUT_MS = 6000;
// One missed check is a Wi-Fi hiccup, not a missing server: "offline" only after this many in a
// row. At 2.5 s and one strike the line flickered to "Can't reach the server" on phones.
const MISSES_BEFORE_OFFLINE = 2;

// Whether the laptop server answers, checked every few seconds while the screen using it is open
// (and the app is in the foreground). Screens show it before the player depends on the server, so
// a missing server is a clear message straight away rather than a spinner that never ends.
export function useServerStatus(): { status: ServerStatus; address: string } {
  const [status, setStatus] = useState<ServerStatus>('checking');
  const address = serverUrl();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let misses = 0;
    const missed = () => {
      misses += 1;
      if (!stopped && misses >= MISSES_BEFORE_OFFLINE) setStatus('offline');
    };
    const check = async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(`${address}/api/health`, { signal: controller.signal });
        if (response.ok) {
          misses = 0;
          if (!stopped) setStatus('online');
        } else missed();
      } catch {
        missed();
      } finally {
        clearTimeout(abort);
      }
      // After a miss, look again sooner, so a real outage shows within a few seconds.
      if (!stopped) timer = setTimeout(check, misses ? 1500 : CHECK_EVERY_MS);
    };
    void check();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !stopped) {
        if (timer) clearTimeout(timer);
        void check();
      }
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [address]);
  return { status, address };
}
