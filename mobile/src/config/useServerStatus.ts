import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { serverUrl } from './server';

export type ServerStatus = 'checking' | 'online' | 'offline';

const CHECK_EVERY_MS = 4000;
const CHECK_TIMEOUT_MS = 2500;

// Whether the laptop server answers, checked every few seconds while the screen using it is open
// (and the app is in the foreground). Screens show it before the player depends on the server, so
// a missing server is a clear message straight away rather than a spinner that never ends.
export function useServerStatus(): { status: ServerStatus; address: string } {
  const [status, setStatus] = useState<ServerStatus>('checking');
  const address = serverUrl();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(`${address}/api/health`, { signal: controller.signal });
        if (!stopped) setStatus(response.ok ? 'online' : 'offline');
      } catch {
        if (!stopped) setStatus('offline');
      } finally {
        clearTimeout(abort);
      }
      if (!stopped) timer = setTimeout(check, CHECK_EVERY_MS);
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
