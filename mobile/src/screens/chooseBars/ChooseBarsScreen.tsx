import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';
import type { CursorNoteInfo } from '@core/score/renderer/scoreCursor';

import { Display, Eyebrow, GoldButton, Rule, Screen, TextButton, useGutter } from '@/components/ui';
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
          <TextButton label="← Library" onPress={() => router.replace('/')} />
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

  return (
    <Screen layout={layout}>
      <View style={{ flex: 1 }}>
        <View style={[styles.header, { paddingHorizontal: g }, tablet && { paddingTop: 30 }]}>
          <View style={{ gap: 8, flex: 1 }}>
            <TextButton label={`← ${piece.title}`} onPress={() => router.back()} />
            <Display size={tablet ? 52 : 34}>Which bars?</Display>
          </View>
          <Text style={[styles.hint, tablet && { maxWidth: 380, textAlign: 'right' }]}>
            {awaitingEnd ? 'Now tap the last bar — or start to loop just this one.' : 'Tap the first bar, then the last. Tap again to start over.'}
          </Text>
        </View>
        <Rule style={{ marginHorizontal: g, marginBottom: 14 }} />
        <ScoreView ref={score} xml={piece.xml} theme={theme} onEvent={onEngine} style={[styles.score, { marginHorizontal: tablet ? g - 28 : 10 }, theme === 'paper' && styles.paper]} />
        <View style={[styles.footer, { paddingHorizontal: g }, !tablet && { flexDirection: 'column', alignItems: 'stretch' }]}>
          <View style={{ gap: 6 }}>
            <Eyebrow>Loop</Eyebrow>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
              <Display size={tablet ? 38 : 30} style={{ color: range ? colors.bright : colors.muted }}>{label}</Display>
              {range ? <Text style={styles.hint}>{noteCount} notes</Text> : null}
            </View>
          </View>
          <GoldButton
            label="Start looping"
            onPress={() => range && router.replace({ pathname: '/practice', params: { id: piece.id, from: String(range.from + 1), to: String(range.to + 1) } })}
            style={!range ? { opacity: 0.4 } : undefined}
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, paddingTop: 14, paddingBottom: 14 },
  hint: { fontFamily: fonts.display, fontSize: 16, lineHeight: 23, color: colors.soft },
  score: { flex: 1, marginBottom: 14 },
  paper: { backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 24, shadowOffset: { width: 0, height: 14 }, elevation: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20, paddingVertical: 20, borderTopWidth: 1, borderTopColor: 'rgba(201,164,106,0.3)' },
});
