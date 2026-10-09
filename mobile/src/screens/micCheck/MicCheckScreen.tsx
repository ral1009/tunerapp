import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { IN_TUNE_CENTS, nearestNote } from '@/audio/notes';
import { useTuner } from '@/audio/useTuner';
import { BackLink, Display, Eyebrow, GoldButton, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// A quiet room reads well under this raw RMS on every mic we've measured (the web app's calibration
// floor on the user's laptop sat near 0.0003); above it, noise starts to reach the pitch gate.
const QUIET_ROOM_RMS = 0.004;
// Playing should be clearly above the room: the gate opens at 1.5× the floor, this asks for more.
const CLEAR_SIGNAL_RATIO = 6;

// Level meter scale: raw RMS on a log axis from 0.00003 (silence) to 0.1 (loud playing).
function meterFraction(rms: number): number {
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (Math.log10(rms) + 4.5) / 3.5));
}

export function MicCheckScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const { settings } = useSettings();
  const a4 = settings.referencePitchHz;
  const { reading, heldHz, micStatus, strings, peakSignalRatio: peakRatio, levels } = useTuner(a4);

  const calibrating = micStatus !== 'running' || reading.status === 'calibrating';
  const quiet = !calibrating && reading.noiseFloorRms < QUIET_ROOM_RMS;
  const clear = peakRatio >= CLEAR_SIGNAL_RATIO;
  const tunedCount = strings.filter((st) => st.cents !== null && Math.abs(st.cents) <= IN_TUNE_CENTS).length;
  const heard = strings.filter((st) => st.cents !== null);
  const note = heldHz ? nearestNote(heldHz, a4) : null;
  const gate = reading.noiseFloorRms * 1.5;
  const meterHeight = tablet ? 84 : 64;

  const steps = [
    {
      title: 'The room is quiet enough',
      note: calibrating ? 'Listening to the room for a moment…' : quiet ? 'Background noise is low — good for hearing small differences.' : 'There’s some background noise. A quieter spot will grade more reliably.',
      done: !calibrating,
      warn: !calibrating && !quiet,
    },
    {
      title: 'Play an open string',
      note: note ? `Heard ${note.name}, ${Math.abs(Math.round(note.cents))} cents ${note.cents >= 0 ? 'sharp' : 'flat'}.${clear ? ' Your microphone hears the violin clearly.' : ' A little louder, or closer.'}` : 'Any open string, a long bow.',
      done: clear,
      warn: false,
    },
    {
      title: 'Your four strings',
      note: heard.length === 0 ? 'Play each open string in turn — G, D, A, E.' : `${heard.map((st) => `${st.name} ${st.cents! >= 0 ? '+' : '−'}${Math.abs(Math.round(st.cents!))}¢`).join(' · ')} — ${tunedCount} of 4 in tune.`,
      done: heard.length === 4,
      warn: false,
    },
  ];
  const active = steps.findIndex((st) => !st.done);

  return (
    <Screen layout={layout} edges={['bottom']} glow={false}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: 28 }}>
        <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: tablet ? 460 : 380 }} />
        <View style={{ paddingLeft: g - 10, paddingTop: 52 }}>
          <BackLink label="Back" tone="light" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        </View>
        <View style={{ paddingHorizontal: g, marginTop: tablet ? 90 : 64, gap: 10, maxWidth: 640 }}>
          <Eyebrow tone="bright">Microphone</Eyebrow>
          <Display size={tablet ? 60 : 44} style={{ lineHeight: tablet ? 62 : 46 }}>Let&rsquo;s hear your violin</Display>
        </View>

        <View style={{ paddingHorizontal: g, marginTop: 30 }}>
          <View style={{ height: meterHeight, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }} accessible accessibilityLabel={note ? 'Hearing your violin' : 'Microphone level'}>
            {Array.from({ length: 48 }, (_, i) => {
              const rms = levels[levels.length - 48 + i] ?? 0;
              const loud = rms > gate && gate > 0;
              return <View key={i} style={{ flex: 1, height: Math.max(2, meterFraction(rms) * meterHeight), backgroundColor: loud ? 'rgba(227,197,143,0.85)' : 'rgba(237,227,207,0.25)' }} />;
            })}
            {gate > 0 ? <View style={[styles.floor, { bottom: meterFraction(gate) * meterHeight }]} /> : null}
          </View>
          <Text style={styles.floorLabel}>Room noise</Text>
        </View>

        <View style={{ paddingHorizontal: g, marginTop: 16, maxWidth: 720 }}>
          {steps.map((st, i) => {
            const now = i === active;
            return (
              <View key={st.title} style={styles.step}>
                <Text style={[styles.stepN, { color: now ? colors.goldBright : st.done ? colors.muted : colors.faint }]}>{i + 1}</Text>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={[styles.stepTitle, { color: now ? colors.ivory : st.done ? colors.soft : colors.muted }]}>{st.title}</Text>
                  <Text style={[styles.stepNote, { color: st.warn ? colors.close : now ? colors.soft : colors.faint }]}>{st.note}</Text>
                </View>
                <Text style={styles.tick}>{st.done && !st.warn ? '✓' : ''}</Text>
              </View>
            );
          })}
        </View>

        <View style={[styles.actions, { paddingHorizontal: g }, tablet && { justifyContent: 'flex-end', gap: 36 }]}>
          <TextButton label="Skip" href="/add-music" />
          <GoldButton label={heard.length ? 'Sounds good' : 'Skip for now'} href="/add-music" />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  floor: { position: 'absolute', left: 0, right: 0, height: 0, borderTopWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(237,227,207,0.35)' },
  floorLabel: { alignSelf: 'flex-end', marginTop: 6, fontFamily: fonts.sans, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: colors.muted },
  step: { flexDirection: 'row', gap: 18, paddingVertical: 18, borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  stepN: { width: 18, fontFamily: fonts.display, fontSize: 18 },
  stepTitle: { fontFamily: fonts.serif, fontSize: 18 },
  stepNote: { fontFamily: fonts.sansLight, fontSize: 12, lineHeight: 18 },
  tick: { fontFamily: fonts.sans, fontSize: 13, color: colors.gold, width: 14 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 24 },
});
