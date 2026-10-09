import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { frequencyOf, IN_TUNE_CENTS, nearestNote, tuningAdvice } from '@/audio/notes';
import { currentStringCents, useTuner } from '@/audio/useTuner';
import { NavBar } from '@/components/nav';
import { Display, IntonationScale, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

export function TunerScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const { settings } = useSettings();
  const a4 = settings.referencePitchHz;
  const tuner = useTuner(a4);
  const { reading, heldHz, micStatus, micError, restart, strings, currentString: current } = tuner;
  const currentCents = currentStringCents(tuner, a4);

  // Show the open string when one is being tuned; otherwise whatever note is sounding.
  const note = heldHz ? nearestNote(heldHz, a4) : null;
  const shownCents = currentCents !== null && Math.abs(currentCents) <= 50 ? currentCents : note ? note.cents : null;
  const letter = current !== null && currentCents !== null && Math.abs(currentCents) <= 50 ? strings[current].name : note ? note.name : '—';
  const status =
    micStatus === 'denied'
      ? 'Microphone access is off'
      : micStatus === 'error'
        ? micError ?? 'The microphone could not start'
        : micStatus !== 'running'
          ? 'Starting the microphone…'
          : reading.status === 'calibrating'
            ? 'Listening to the room…'
            : heldHz === null
              ? 'Play an open string'
              : shownCents === null
                ? ''
                : tuningAdvice(shownCents);
  const tuned = strings.filter((s) => s.cents !== null && Math.abs(s.cents) <= IN_TUNE_CENTS).map((s) => s.name);
  const summary = tuned.length === 0 ? 'Tune each string in turn' : tuned.length === 4 ? 'All four strings are in tune' : `${listNames(tuned)} ${tuned.length === 1 ? 'is' : 'are'} in tune`;

  const stringLabel = current !== null && currentCents !== null && Math.abs(currentCents) <= 50 ? ['Fourth string', 'Third string', 'Second string', 'First string'][current] : note ? `${note.name}${note.octave}` : 'Open strings';
  const target = current !== null && currentCents !== null && Math.abs(currentCents) <= 50 ? strings[current] : null;
  const hzLine = heldHz ? `${heldHz.toFixed(1)} Hz${target ? ` · aiming for ${frequencyOf(target.midi, a4).toFixed(1)}` : ''}` : ' ';

  const stringsRow = (
    <View accessibilityRole="radiogroup" accessibilityLabel="Strings" style={[styles.strings, tablet && { width: 560, alignSelf: 'center' }]}>
      {strings.map((s, i) => {
        const on = i === current && heldHz !== null;
        const ok = s.cents !== null && Math.abs(s.cents) <= IN_TUNE_CENTS;
        return (
          <View key={s.name} style={[styles.string, { borderTopColor: on ? colors.goldBright : 'transparent' }]} accessibilityState={{ selected: on }}>
            <Text style={[styles.stringName, { color: on ? colors.bright : ok ? colors.cream : colors.muted }]}>{s.name}</Text>
            <Text style={[styles.stringState, ok && { color: colors.gold }]}>{s.cents === null ? '—' : ok ? 'tuned' : `${s.cents > 0 ? '+' : '−'}${Math.abs(Math.round(s.cents))}¢`}</Text>
          </View>
        );
      })}
    </View>
  );

  return (
    <Screen layout={layout} edges={tablet ? ['top', 'bottom'] : ['top']} glow={false}>
      <Wood variant="dim" style={StyleSheet.absoluteFill} />
      <View style={{ flex: 1, paddingHorizontal: g }}>
        <View style={[styles.header, tablet && styles.headerTablet]}>
          {tablet ? <Display size={64}>Tuner</Display> : <Text style={styles.eyebrow}>Tuner</Text>}
          {tablet ? <NavBar current="tuner" layout="tablet" /> : <Text style={styles.ref}>A = {a4} Hz</Text>}
        </View>

        <View style={styles.centre}>
          <Text style={styles.stringLabel}>{stringLabel}</Text>
          <Display size={tablet ? 260 : 220} style={{ lineHeight: tablet ? 250 : 210, textShadowColor: 'rgba(0,0,0,0.55)', textShadowRadius: 40 }}>{letter}</Display>
          <Text style={styles.hz}>{hzLine}</Text>
          <Text style={styles.cents}>
            {shownCents === null ? ' ' : `${shownCents > 0 ? '+' : shownCents < 0 ? '−' : ''}${Math.abs(Math.round(shownCents))}¢`}
            <Text style={styles.advice}>{shownCents === null ? status : `  ${status}`}</Text>
          </Text>
          <View style={{ width: tablet ? 520 : '100%', marginTop: 22 }}>
            <IntonationScale cents={shownCents} />
          </View>
          {micStatus === 'denied' && Platform.OS !== 'web' ? <TextButton label="Open settings" tone="gold" onPress={() => Linking.openSettings()} /> : null}
          {micStatus === 'error' ? <TextButton label="Try again" tone="gold" onPress={restart} /> : null}
        </View>

        <View style={{ paddingBottom: tablet ? 40 : 10 }}>
          {stringsRow}
          <Text style={styles.summary}>{summary}</Text>
        </View>
      </View>
      {tablet ? null : <NavBar current="tuner" layout="phone" />}
    </Screen>
  );
}

// "G", "G and A", "G, A and E".
function listNames(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 24 },
  headerTablet: { flexWrap: 'wrap', alignItems: 'flex-end', gap: 24, paddingTop: 40, paddingBottom: 26 },
  eyebrow: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 4.5, textTransform: 'uppercase', color: '#E9D5AE' },
  ref: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.soft },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stringLabel: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 4, textTransform: 'uppercase', color: colors.goldBright },
  hz: { fontFamily: fonts.sansLight, fontSize: 13, color: colors.cream },
  cents: { fontFamily: fonts.display, fontSize: 26, color: colors.goldBright, marginTop: 18, textAlign: 'center' },
  advice: { fontFamily: fonts.display, fontSize: 15, color: colors.cream },
  strings: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  string: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 12, minHeight: 64, borderTopWidth: 1, marginTop: -1 },
  stringName: { fontFamily: fonts.display, fontSize: 24 },
  stringState: { fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: colors.muted },
  summary: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.muted, textAlign: 'center', marginTop: 6 },
});
