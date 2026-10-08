import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { EngineCommand, EngineEvent, ScoreTheme } from '@core/score/engine/protocol';

import { SCORE_ENGINE_HTML } from './engineHtml.generated';

export interface ScoreViewHandle {
  send: (command: EngineCommand) => void;
}

export interface ScoreViewProps {
  xml: string;
  theme: ScoreTheme;
  // false: read the score (title, bars, misread bars) without drawing it.
  render?: boolean;
  onEvent?: (event: EngineEvent) => void;
  style?: StyleProp<ViewStyle>;
}

// Sheet music via the score engine (score/engine) in a WebView. Commands sent before the page
// says it's ready are queued; the score loads whenever `xml` changes and re-themes on `theme`.
export const ScoreView = forwardRef<ScoreViewHandle, ScoreViewProps>(function ScoreView({ xml, theme, render = true, onEvent, style }, ref) {
  const webview = useRef<WebView>(null);
  const ready = useRef(false);
  const queue = useRef<EngineCommand[]>([]);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const send = useCallback((command: EngineCommand) => {
    if (!ready.current || !webview.current) {
      queue.current.push(command);
      return;
    }
    webview.current.injectJavaScript(`window.__scoreEngine && window.__scoreEngine.receive(${JSON.stringify(command)}); true;`);
  }, []);
  useImperativeHandle(ref, () => ({ send }), [send]);

  useEffect(() => {
    send({ type: 'load', xml, theme, render });
    // Theme changes after load go through the effect below without reloading the score.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, render, send]);
  useEffect(() => {
    send({ type: 'theme', theme });
  }, [theme, send]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let parsed: EngineEvent;
      try {
        parsed = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (parsed.type === 'ready') {
        ready.current = true;
        // Only the newest load matters; keep the rest in order.
        const pending = queue.current;
        queue.current = [];
        const lastLoad = [...pending].reverse().find((c) => c.type === 'load');
        pending.filter((c) => c.type !== 'load' || c === lastLoad).forEach(send);
      }
      onEventRef.current?.(parsed);
    },
    [send],
  );

  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <WebView
        ref={webview}
        source={{ html: SCORE_ENGINE_HTML }}
        originWhitelist={['*']}
        onMessage={onMessage}
        style={{ backgroundColor: 'transparent' }}
        scrollEnabled={render}
        bounces={false}
        javaScriptEnabled
      />
    </View>
  );
});
