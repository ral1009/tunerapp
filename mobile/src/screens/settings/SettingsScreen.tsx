import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { Choice, Display, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// One screen for both layouts: on iPad the rows sit in two columns under a large title.
export function SettingsScreen({ layout }: { layout: LayoutMode }) {
  const { settings, update } = useSettings();
  const g = useGutter(layout);
  const tablet = layout === 'tablet';

  const rows = [
    {
      title: 'Screens',
      hint: 'Auto uses the iPad screens on an iPad and the phone screens on a phone. Pick either to use it on any device.',
      control: (
        <Choice label="Screens" value={settings.layout} onChange={(layout) => update({ layout })}
          options={[{ value: 'auto', label: 'Auto' }, { value: 'phone', label: 'Phone' }, { value: 'tablet', label: 'iPad' }]} />
      ),
    },
    {
      title: 'Score',
      hint: 'How the music looks on the stand. Auto turns to ebony in a dark room.',
      control: (
        <Choice label="Score" value={settings.scoreTheme} onChange={(scoreTheme) => update({ scoreTheme })}
          options={[{ value: 'paper', label: 'Paper' }, { value: 'ebony', label: 'Ebony' }, { value: 'auto', label: 'Auto' }]} />
      ),
    },
    {
      title: 'Grade against',
      hint: 'Concert pitch, or the pitch your open strings are tuned to.',
      control: (
        <Choice label="Grade against" value={settings.reference} onChange={(reference) => update({ reference })}
          options={[{ value: 'a440', label: `A ${settings.referencePitchHz}` }, { value: 'own', label: 'My tuning' }]} />
      ),
    },
    {
      title: 'How strict',
      hint: 'In tune within 25, 15 or 8 cents.',
      control: (
        <Choice label="How strict" value={settings.strictness} onChange={(strictness) => update({ strictness })}
          options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'standard', label: 'Standard' }, { value: 'strict', label: 'Strict' }]} />
      ),
    },
    {
      title: 'Reference pitch',
      hint: 'For the tuner and for grading against A.',
      control: (
        <Choice label="Reference pitch" value={settings.referencePitchHz} onChange={(referencePitchHz) => update({ referencePitchHz })}
          options={[{ value: 440, label: '440' }, { value: 442, label: '442' }, { value: 443, label: '443' }]} />
      ),
    },
  ];

  return (
    <Screen layout={layout} edges={tablet ? ['top', 'bottom'] : ['top']}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: g, paddingBottom: 40 }}>
        <View style={[styles.header, tablet && styles.headerTablet]}>
          <Display size={tablet ? 64 : 36}>Settings</Display>
          {tablet ? <NavBar current="settings" layout="tablet" /> : null}
        </View>
        {tablet ? <Rule /> : null}
        <View style={tablet ? styles.columns : null}>
          {rows.map((row) => (
            <View key={row.title} style={[styles.row, tablet && styles.rowTablet]}>
              <Serif size={19}>{row.title}</Serif>
              <Text style={styles.hint}>{row.hint}</Text>
              {row.control}
            </View>
          ))}
          <View style={[styles.row, tablet && styles.rowTablet, styles.micRow]}>
            <View style={{ flex: 1, gap: 4 }}>
              <Serif size={19}>Microphone</Serif>
              <Text style={styles.hint}>Not checked yet on this device</Text>
            </View>
            <TextButton label="Check" tone="gold" href="/mic-check" />
          </View>
        </View>
      </ScrollView>
      {tablet ? null : <NavBar current="settings" layout="phone" />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 24, paddingBottom: 10 },
  headerTablet: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, paddingTop: 40, paddingBottom: 26 },
  columns: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 64 },
  row: { gap: 8, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  rowTablet: { width: 520, maxWidth: '100%' },
  micRow: { flexDirection: 'row', alignItems: 'center' },
  hint: { fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 19, color: colors.muted },
});
