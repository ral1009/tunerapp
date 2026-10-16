import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View } from 'react-native';

import type { EngineCommand, EngineEvent } from '@core/score/engine/protocol';

import { SCORE_ENGINE_HTML } from './engineHtml.generated';
import { ScoreError } from './ScoreError';
import { ScorePlaceholder } from './ScorePlaceholder';
import { useAfterTransition } from '@/navigation/useAfterTransition';
import type { ScoreViewHandle, ScoreViewProps } from './ScoreView';

// Web build: the same score engine page in an iframe (react-native-webview has no web support).
export const ScoreView = forwardRef<ScoreViewHandle, ScoreViewProps>(function ScoreView({ xml, theme, render = true, layout = 'scroll', onEvent, style }, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const queue = useRef<EngineCommand[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  // Drawn yet? Until then a placeholder sits over the page.
  const [drawn, setDrawn] = useState(false);
  const mounted = useAfterTransition();
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const send = useCallback((command: EngineCommand) => {
    const target = frame.current?.contentWindow;
    if (!ready.current || !target) {
      queue.current.push(command);
      return;
    }
    target.postMessage(JSON.stringify(command), '*');
  }, []);
  useImperativeHandle(ref, () => ({ send }), [send]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'string') return;
      let parsed: EngineEvent;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed.type === 'ready') {
        ready.current = true;
        const pending = queue.current;
        queue.current = [];
        const lastLoad = [...pending].reverse().find((c) => c.type === 'load');
        pending.filter((c) => c.type !== 'load' || c === lastLoad).forEach(send);
      }
      if (parsed.type === 'error') {
        setFailure(parsed.message);
        setDrawn(true);
      } else if (parsed.type === 'loaded') {
        setFailure(null);
        setDrawn(true);
      }
      onEventRef.current?.(parsed);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [send]);

  useEffect(() => {
    loadedTheme.current = theme;
    setDrawn(false);
    send({ type: 'load', xml, theme, render, layout });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, render, layout, send]);
  // The load already carries the theme; only a later change is sent (sending it on mount too
  // drew every score twice).
  const loadedTheme = useRef(theme);
  useEffect(() => {
    if (loadedTheme.current === theme) return;
    loadedTheme.current = theme;
    send({ type: 'theme', theme });
  }, [theme, send]);

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      {mounted ? <iframe ref={frame} srcDoc={SCORE_ENGINE_HTML} title="Sheet music" style={{ border: 'none', width: '100%', height: '100%', background: 'transparent' }} /> : null}
      {render ? <ScorePlaceholder theme={theme} visible={!drawn} /> : null}
      {failure && render ? <ScoreError message={failure} /> : null}
    </View>
  );
});
