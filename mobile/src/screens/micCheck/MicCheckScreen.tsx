import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { IN_TUNE_CENTS, nearestNote } from '@/audio/notes';
import { useTuner } from '@/audio/useTuner';
import { Body, Display, Eyebrow, GoldButton, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// A quiet room reads well under this raw RMS on every mic we've measured (the web app's calibration
// floor on the user's laptop sat near 0.0003); above it, noise starts to reach the pitch gate.
const QUIET_ROOM_RMS = 0.004;
// Playing should be clearly above the room: the gate opens at 1.5× the floor, this asks for more.
const CLEAR_SIGNAL_RATIO = 6;

export function MicCheckScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const { settings } = useSettings();
  const a4 = settings.referencePitchHz;
  const { reading, heldHz, micStatus, strings, peakSignalRatio: peakRatio } = useTuner(a4);

  const calibrating = micStatus !== 'running' || reading.status === 'calibrating';
  const quiet = !calibrating && reading.noiseFloorRms < QUIET_ROOM_RMS;
  const clear = peakRatio >= CLEAR_SIGNAL_RATIO;
  const tunedCount = strings.filter((s) => s.cents !== null && Math.abs(s.cents) <= IN_TUNE_CENTS).length;
  const heard = strings.filter((s) => s.cents !== null).length;
  const note = heldHz ? nearestNote(heldHz, a4) : null;

  const checks = [
    { label: 'The room is quiet enough', value: calibrating ? 'listening…' : quiet ? 'good' : 'a little noisy', tone: calibrating ? colors.muted : quiet ? colors.good : colors.close },
    { label: 'I can hear you clearly', value: clear ? 'good' : heard ? 'play a little louder' : 'play an open string', tone: clear ? colors.good : colors.muted },
    { label: 'Your strings', value: heard === 0 ? 'not heard yet' : `${tunedCount} of 4 in tune`, tone: heard === 0 ? colors.muted : tunedCount === 4 ? colors.good : colors.close },
  ];

  const ringSize = tablet ? 280 : 200;
  const rings = (
    <View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}>
      {[0, 0.11, 0.22].map((inset, i) => (
        <View
          key={inset}
          style={{
            position: 'absolute', left: ringSize * inset, top: ringSize * inset, right: ringSize * inset, bottom: ringSize * inset,
            borderRadius: ringSize, borderWidth: 1,
            borderColor: `rgba(201,164,106,${note ? [0.25, 0.4, 0.75][i] : [0.15, 0.2, 0.3][i]})`,
          }}
        />
      ))}
      <Display size={tablet ? 88 : 64} style={{ color: colors.bright, lineHeight: tablet ? 92 : 68 }}>{note ? note.name : '—'}</Display>
      <Text style={styles.readout}>{heldHz ? `${heldHz.toFixed(1)} Hz · ${note && note.cents >= 0 ? '+' : '−'} ${Math.abs(Math.round(note?.cents ?? 0))}¢` : ' '}</Text>
    </View>
  );

  const checklist = (
    <View style={{ width: '100%' }}>
      {checks.map((c, i) => (
        <View key={c.label} style={styles.check}>
          <Text style={[styles.numeral, { color: c.tone }]}>{['i', 'ii', 'iii'][i]}</Text>
          <Serif size={17} style={{ flex: 1 }}>{c.label}</Serif>
          <Text style={[styles.value, { color: c.tone }]}>{c.value}</Text>
        </View>
      ))}
      <View style={styles.stringRow}>
        {strings.map((s) => {
          const ok = s.cents !== null && Math.abs(s.cents) <= IN_TUNE_CENTS;
          return (
            <View key={s.name} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
              <Text style={[styles.stringName, { color: s.cents === null ? colors.muted : colors.cream }]}>{s.name}</Text>
              <Text style={[styles.value, { color: s.cents === null ? colors.faint : ok ? colors.good : colors.close }]}>
                {s.cents === null ? '—' : `${s.cents >= 0 ? '+' : '−'} ${Math.abs(Math.round(s.cents))}¢`}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, paddingHorizontal: g, paddingTop: tablet ? 48 : 28, paddingBottom: 28 }}>
        <View style={{ gap: 12, maxWidth: 620 }}>
          <Eyebrow>Step one of two</Eyebrow>
          <Display size={tablet ? 52 : 34}>Let me hear your violin</Display>
          <Body style={tablet ? { fontSize: 16, lineHeight: 26 } : undefined}>Prop the device on your stand, about a metre away, and play each open string.</Body>
        </View>
        {tablet ? <Rule style={{ marginTop: 32 }} /> : null}

        <View style={[styles.body, tablet && styles.bodyTablet]}>
          <View style={{ alignItems: 'center', paddingVertical: tablet ? 0 : 28 }}>{rings}</View>
          <View style={tablet ? { flex: 1, maxWidth: 520 } : { width: '100%' }}>{checklist}</View>
        </View>

        <View style={[styles.actions, tablet && { justifyContent: 'flex-end', gap: 36 }]}>
          <TextButton label="Back" href="/welcome" />
          <GoldButton label={heard ? 'Continue' : 'Skip for now'} href="/add-music" />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: 'center' },
  bodyTablet: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 64, paddingVertical: 40 },
  readout: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 1.5, color: colors.gold, marginTop: 4 },
  check: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  numeral: { width: 26, fontFamily: fonts.display, fontSize: 16 },
  value: { fontFamily: fonts.sans, fontSize: 12, letterSpacing: 0.6 },
  stringRow: { flexDirection: 'row', marginTop: 18 },
  stringName: { fontFamily: fonts.display, fontSize: 22 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 },
});
