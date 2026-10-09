import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo } from '@core/score/renderer/scoreCursor';

import { BackLink, Display, Eyebrow, GoldButton, paperSheet, Purfling, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { ScoreView, type ScoreViewHandle } from '@/score/ScoreView';
import { useScoreTheme, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Spot practice, step one: tap the first bar, then the last; a third tap starts over. The engine
// reports bar taps and draws the selection (score/engine).
export function ChooseBarsScreen({ layout, id }: { layout: LayoutMode; id: string }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const piece = useLibrary().get(id);
  const theme = useScoreTheme();
  const score = useRef<ScoreViewHandle>(null);
  const [notes, setNotes] = useState<CursorNoteInfo[]>([]);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null); // 0-based bars
  const [awaitingEnd, setAwaitingEnd] = useState(false);

  useEffect(() => {
    score.current?.send({ type: 'selectBars', from: range?.from ?? null, to: range?.to ?? null });
  }, [range]);

  if (!piece) {
    return (
      <Screen layout={layout}>
        <View style={{ padding: g, gap: 16 }}>
          <BackLink label="Library" onPress={() => router.replace('/')} />
          <Display size={36}>This piece isn&rsquo;t in your library</Display>
        </View>
      </Screen>
    );
  }

  const onEngine = (event: EngineEvent) => {
    if (event.type === 'loaded' && event.rendered) setNotes(event.notes);
    if (event.type !== 'barTap') return;
    const bar = event.measureIndex;
    if (awaitingEnd && range) {
      setRange({ from: Math.min(range.from, bar), to: Math.max(range.from, bar) });
      setAwaitingEnd(false);
    } else {
      setRange({ from: bar, to: bar });
      setAwaitingEnd(true);
    }
  };

  const noteCount = range ? notes.filter((n) => n.measureIndex >= range.from && n.measureIndex <= range.to).length : 0;
  const label = range ? (range.from === range.to ? `Bar ${range.from + 1}` : `Bars ${range.from + 1} – ${range.to + 1}`) : 'No bars yet';

  const start = () => range && router.replace({ pathname: '/practice', params: { id: piece.id, from: String(range.from + 1), to: String(range.to + 1) } });

  return (
    <Screen layout={layout} edges={['top']}>
      <View style={{ flex: 1 }}>
        <View style={{ paddingLeft: g - 10, paddingTop: 6 }}>
          <BackLink label={piece.title} onPress={() => router.back()} />
        </View>
        <View style={[styles.title, { paddingHorizontal: g }]}>
          <Display size={tablet ? 52 : 34}>Loop a passage</Display>
          <Text style={styles.hint}>
            {awaitingEnd ? 'Now tap the last bar — or start to loop just this one.' : 'Tap the first bar, then the last.'}
          </Text>
        </View>
        <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, { marginHorizontal: tablet ? 48 : 12 }, theme === 'paper' && paperSheet]} />
        <Wood variant="band">
          <Purfling style={{ marginTop: 30 }} />
          <View style={[styles.bandInner, { paddingHorizontal: g }, tablet && styles.bandTablet]}>
            <View style={{ gap: 6, flex: tablet ? 1 : undefined }}>
              <Eyebrow tone="bright">Loop</Eyebrow>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                <Display size={tablet ? 44 : 38} style={{ color: range ? colors.bright : colors.muted }}>{label}</Display>
                {range ? <Text style={styles.count}>{noteCount} notes</Text> : null}
              </View>
            </View>
            <View style={styles.controls}>
              <TextButton label="Clear" onPress={() => { setRange(null); setAwaitingEnd(false); }} />
              <GoldButton label="Start looping" onPress={start} disabled={!range} />
            </View>
          </View>
        </Wood>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { gap: 6, paddingTop: 10, paddingBottom: 16 },
  hint: { fontFamily: fonts.sansLight, fontSize: 13, color: colors.soft },
  score: { flex: 1, marginBottom: 18 },
  bandInner: { paddingTop: 22, paddingBottom: 28, gap: 18 },
  bandTablet: { flexDirection: 'row', alignItems: 'center', gap: 40, paddingTop: 30, paddingBottom: 36 },
  count: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.cream },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 32 },
});
