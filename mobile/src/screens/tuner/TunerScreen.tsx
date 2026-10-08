import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { IN_TUNE_CENTS, nearestNote, tuningAdvice } from '@/audio/notes';
import { currentStringCents, useTuner } from '@/audio/useTuner';
import { NavBar } from '@/components/nav';
import { TunerGauge } from '@/components/TunerGauge';
import { Display, Eyebrow, Maple, Rule, Screen, TextButton, useGutter } from '@/components/ui';
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

  const gaugeSize = tablet ? 440 : 300;

  const stringsRow = (
    <View accessibilityRole="radiogroup" accessibilityLabel="Strings" style={[styles.strings, tablet && { width: 520 }]}>
      {strings.map((s, i) => {
        const on = i === current && heldHz !== null;
        const ok = s.cents !== null && Math.abs(s.cents) <= IN_TUNE_CENTS;
        return (
          <View key={s.name} style={styles.string} accessibilityState={{ selected: on }}>
            <View style={{ width: 22, height: 1, backgroundColor: on ? colors.goldBright : ok ? 'rgba(201,164,106,0.45)' : 'transparent' }} />
            <Text style={[styles.stringName, { color: on ? colors.bright : ok ? colors.cream : colors.muted }]}>{s.name}</Text>
            <Text style={styles.stringState}>{s.cents === null ? '—' : ok ? 'tuned' : `${s.cents > 0 ? '+' : '−'} ${Math.abs(Math.round(s.cents))}¢`}</Text>
          </View>
        );
      })}
    </View>
  );

  return (
    <Screen layout={layout} edges={tablet ? ['top', 'bottom'] : ['top']}>
      <Maple wash="even" style={StyleSheet.absoluteFill} />
      <View style={{ flex: 1, paddingHorizontal: g }}>
        <View style={[styles.header, tablet && styles.headerTablet]}>
          {tablet ? <Display size={64}>Tuner</Display> : <Eyebrow tone="bright">Tuner</Eyebrow>}
          {tablet ? <NavBar current="tuner" layout="tablet" /> : <Eyebrow tone="muted">A {a4}</Eyebrow>}
        </View>
        {tablet ? <Rule /> : null}

        <View style={styles.centre}>
          <TunerGauge size={gaugeSize} cents={shownCents} active={heldHz !== null} />
          <Display size={tablet ? 190 : 150} style={{ color: colors.bright, marginTop: tablet ? 18 : 10, lineHeight: tablet ? 190 : 150 }}>{letter}</Display>
          <Text style={styles.cents}>{shownCents === null ? ' ' : `${shownCents > 0 ? '+' : shownCents < 0 ? '−' : ''} ${Math.abs(Math.round(shownCents))} cents`}</Text>
          <Text style={[styles.advice, tablet && { fontSize: 20 }]}>{status}</Text>
          {micStatus === 'denied' && Platform.OS !== 'web' ? <TextButton label="Open settings" tone="gold" onPress={() => Linking.openSettings()} /> : null}
          {micStatus === 'error' ? <TextButton label="Try again" tone="gold" onPress={restart} /> : null}
        </View>

        <View style={{ alignItems: tablet ? 'center' : 'stretch', paddingBottom: tablet ? 40 : 14 }}>
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
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 28 },
  headerTablet: { flexWrap: 'wrap', alignItems: 'flex-end', gap: 24, paddingTop: 40, paddingBottom: 26 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cents: { fontFamily: fonts.sans, fontSize: 15, letterSpacing: 2, color: colors.gold, marginTop: 4 },
  advice: { fontFamily: fonts.display, fontSize: 17, color: colors.soft, marginTop: 10, textAlign: 'center' },
  strings: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(201,164,106,0.25)' },
  string: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 14, minHeight: 72 },
  stringName: { fontFamily: fonts.display, fontSize: 26 },
  stringState: { fontFamily: fonts.sans, fontSize: 9.5, letterSpacing: 2.2, textTransform: 'uppercase', color: colors.muted },
  summary: { fontFamily: fonts.sans, fontSize: 13, color: colors.muted, textAlign: 'center', marginTop: 8 },
});
