import { Image } from 'expo-image';
import { Link } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { NavBar } from '@/components/nav';
import { ServerStatusLine } from '@/components/ServerStatus';
import { Choice, Display, Screen, useGutter, Wood } from '@/components/ui';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';
import { woodFor } from '@/theme/woods';
import { Tappable } from '@/components/Tappable';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={{ flexShrink: 1, gap: 3 }}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Chevron() {
  return <View style={styles.chevron} />;
}

export function SettingsScreen({ layout }: { layout: LayoutMode }) {
  const { settings, update } = useSettings();
  const g = useGutter(layout);
  const tablet = layout === 'tablet';
  const wood = woodFor(settings.wood);

  const groups: { title: string; rows: ReactNode }[] = [
    {
      title: 'Look',
      rows: (
        <>
          <Row label="Screens" hint={tablet ? 'Auto picks phone or iPad screens by device.' : undefined}>
            <Choice label="Screens" gap={16} value={settings.layout} onChange={(value) => update({ layout: value })}
              options={[{ value: 'phone', label: 'Phone' }, { value: 'tablet', label: 'iPad' }, { value: 'auto', label: 'Auto' }]} />
          </Row>
          <Row label="Score page">
            <Choice label="Score page" gap={16} value={settings.scoreTheme === 'ebony' ? 'ebony' : 'paper'} onChange={(value) => update({ scoreTheme: value })}
              options={[{ value: 'paper', label: 'Paper' }, { value: 'ebony', label: 'Ebony' }]} />
          </Row>
          <Link href="/wood" asChild>
            <Tappable accessibilityRole="link" style={styles.row}>
              <Text style={styles.label}>Wood</Text>
              <View style={styles.linkValue}>
                <View style={styles.swatchFrame}>
                  <Image source={wood.source} style={{ width: 34, height: 22 }} contentFit="cover" contentPosition={{ left: `${wood.focus.x * 100}%`, top: `${wood.focus.y * 100}%` }} />
                </View>
                <Text style={styles.value}>{wood.name}</Text>
                <Chevron />
              </View>
            </Tappable>
          </Link>
        </>
      ),
    },
    {
      title: 'Grading',
      rows: (
        <>
          <Row label="Grade against">
            <Choice label="Grade against" gap={16} value={settings.reference} onChange={(value) => update({ reference: value })}
              options={[{ value: 'a440', label: `A${settings.referencePitchHz}` }, { value: 'own', label: 'My tuning' }]} />
          </Row>
          <Row label="Strictness" hint={tablet ? 'In tune within 25, 15 or 8 cents.' : undefined}>
            <Choice label="Strictness" gap={14} value={settings.strictness} onChange={(value) => update({ strictness: value })}
              options={[{ value: 'relaxed', label: 'Relaxed' }, { value: 'standard', label: 'Standard' }, { value: 'strict', label: 'Strict' }]} />
          </Row>
          <Row label="Reference pitch">
            <View style={styles.stepper}>
              {([440, 442, 443] as const).map((hz) => {
                const on = hz === settings.referencePitchHz;
                return (
                  <Tappable key={hz} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => update({ referencePitchHz: hz })} hitSlop={6}
                    style={[styles.hz, { borderBottomColor: on ? colors.goldBright : 'transparent' }]}>
                    <Text style={[styles.hzText, { color: on ? colors.bright : colors.faintText }]}>{hz}</Text>
                  </Tappable>
                );
              })}
              <Text style={styles.hzUnit}>Hz</Text>
            </View>
          </Row>
        </>
      ),
    },
    {
      title: 'Microphone',
      rows: (
        <Link href="/mic-check" asChild>
          <Tappable accessibilityRole="link" style={styles.row}>
            <Text style={styles.label}>Check microphone</Text>
            <View style={styles.linkValue}>
              <Text style={styles.value}>Room noise and your strings</Text>
              <Chevron />
            </View>
          </Tappable>
        </Link>
      ),
    },
    {
      title: 'Server',
      rows: (
        <View style={[styles.row, { paddingVertical: 14 }]}>
          <ServerStatusLine />
        </View>
      ),
    },
  ];

  return (
    <Screen layout={layout} edges={tablet ? ['bottom'] : []} glow={false}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: tablet ? 260 : 200 }} />
        <View style={[styles.header, { paddingHorizontal: g }, tablet && styles.headerTablet]}>
          <Display size={tablet ? 64 : 44}>Settings</Display>
          {tablet ? <NavBar current="settings" layout="tablet" /> : null}
        </View>
        <View style={[{ paddingHorizontal: g }, tablet && styles.columns]}>
          {groups.map((group) => (
            <View key={group.title} style={[styles.group, tablet && { width: 520 }]}>
              <Text style={styles.groupTitle}>{group.title}</Text>
              {group.rows}
            </View>
          ))}
        </View>
      </ScrollView>
      {tablet ? null : <NavBar current="settings" layout="phone" />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: 96, paddingBottom: 6 },
  headerTablet: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingTop: 120, paddingBottom: 20 },
  columns: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 64 },
  group: { paddingTop: 18 },
  groupTitle: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3.5, textTransform: 'uppercase', color: colors.muted },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  label: { fontFamily: fonts.serif, fontSize: 17, color: colors.ivory },
  hint: { fontFamily: fonts.sansLight, fontSize: 11, color: colors.muted },
  linkValue: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  value: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.cream },
  swatchFrame: { padding: 2, borderWidth: 1, borderColor: 'rgba(201,164,106,0.35)' },
  chevron: { width: 7, height: 7, borderRightWidth: 1.2, borderTopWidth: 1.2, borderColor: colors.gold, transform: [{ rotate: '45deg' }], marginRight: 3 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  hz: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 1 },
  hzText: { fontFamily: fonts.display, fontSize: 18 },
  hzUnit: { fontFamily: fonts.sans, fontSize: 11, color: colors.muted },
});
