import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BackLink, Display, Eyebrow, Purfling, Screen, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { useSettings, type LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';
import { WOODS, woodFor } from '@/theme/woods';

// Settings › Wood: the wood behind your music, with a large preview of the choice.
export function WoodScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const { settings, update } = useSettings();
  const { current } = useLibrary();
  const chosen = woodFor(settings.wood);
  const columns = tablet ? 3 : 2;

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingLeft: g - 10, paddingTop: 6 }}>
          <BackLink label="Settings" onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} />
        </View>
        <View style={{ paddingHorizontal: g, paddingTop: 18, gap: 8, maxWidth: 640 }}>
          <Display size={tablet ? 64 : 44}>Wood</Display>
          <Text style={styles.lede}>What sits behind your music, from the woods a violin and its bow are made of.</Text>
        </View>

        <Wood variant="hero" style={[styles.preview, { marginHorizontal: tablet ? g : 16, height: tablet ? 360 : 226 }]}>
          <Purfling />
          <View style={styles.previewText}>
            <Eyebrow tone="bright">{chosen.name}</Eyebrow>
            <Display size={tablet ? 56 : 38} style={{ textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 18 }}>{current?.title ?? 'Autumn'}</Display>
            <Text style={styles.previewLine}>{chosen.line}</Text>
          </View>
        </Wood>

        <View accessibilityRole="radiogroup" accessibilityLabel="Wood" style={[styles.grid, { paddingHorizontal: tablet ? g : 16 }]}>
          {WOODS.map((wood) => {
            const on = wood.key === settings.wood;
            return (
              <Pressable
                key={wood.key}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={wood.name}
                onPress={() => update({ wood: wood.key })}
                style={{ width: `${100 / columns}%`, padding: 7 }}
              >
                <View style={[styles.swatchFrame, { borderColor: on ? colors.goldBright : colors.ruleSoft }]}>
                  <Image source={wood.source} style={{ height: tablet ? 96 : 56 }} contentFit="cover" contentPosition={{ left: `${wood.focus.x * 100}%`, top: `${wood.focus.y * 100}%` }} />
                </View>
                <View style={{ gap: 2, paddingTop: 9, paddingLeft: 2 }}>
                  <Text style={[styles.name, { color: on ? colors.bright : colors.soft }]}>{wood.name}</Text>
                  <Text style={styles.part}>{wood.part}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.sansLight, fontSize: 13, lineHeight: 20, color: colors.soft },
  preview: { marginTop: 24, shadowColor: '#000', shadowOpacity: 0.7, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } },
  previewText: { position: 'absolute', left: 22, right: 22, bottom: 20, gap: 4 },
  previewLine: { fontFamily: fonts.sansLight, fontSize: 12, color: colors.cream },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 22 },
  swatchFrame: { padding: 3, borderWidth: 1 },
  name: { fontFamily: fonts.serif, fontSize: 16 },
  part: { fontFamily: fonts.sansLight, fontSize: 11, color: colors.faintText },
});
