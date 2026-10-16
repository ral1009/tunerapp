import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLibrary } from '@/data/libraryStore';
import { go, type Place } from '@/navigation/go';
import { colors, fonts } from '@/theme/tokens';
import { Tappable } from '@/components/Tappable';

type Section = 'library' | 'practise' | 'tuner' | 'settings' | 'piece';

// Phone: four words along the bottom, a gold hairline over the current one. iPad: the same four
// as tracked caps in the header, underlined.
// `onWood`: the iPad header sitting on a lit wood surface, where the usual faint grey can't be read.
export function NavBar({ current, layout, onWood }: { current: Section; layout: 'phone' | 'tablet'; onWood?: boolean }) {
  const insets = useSafeAreaInsets();
  const library = useLibrary();
  const items: { key: Section; label: string; to: Place }[] = [
    { key: 'library', label: 'Library', to: { kind: 'library' } },
    // "Practise" picks up the piece you were last in; with an empty library it adds music.
    { key: 'practise', label: 'Practise', to: library.current ? { kind: 'piece', id: library.current.id, screen: 'practice' } : { kind: 'add-music' } },
    { key: 'tuner', label: 'Tuner', to: { kind: 'tuner' } },
    { key: 'settings', label: 'Settings', to: { kind: 'settings' } },
  ];
  if (layout === 'tablet') {
    return (
      <View style={styles.tabletRow}>
        {items.map((item) => {
          const on = item.key === current;
          return (
            <Tappable key={item.key} haptic onPress={() => go(item.to)} accessibilityRole="link" accessibilityState={{ selected: on }} style={StyleSheet.flatten([styles.tabletItem, { borderBottomColor: on ? colors.goldBright : 'transparent' }])}>
              <Text numberOfLines={1} style={[styles.itemText, { color: on ? colors.ivory : onWood ? colors.cream : colors.faintText }, onWood && styles.onWood]}>{item.label}</Text>
            </Tappable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={[styles.phoneBar, { paddingBottom: Math.max(insets.bottom, 18) }]}>
      {items.map((item) => {
        const on = item.key === current;
        return (
          <Tappable key={item.key} haptic onPress={() => go(item.to)} accessibilityRole="link" accessibilityState={{ selected: on }} style={styles.phoneItem}>
            <View style={[styles.mark, { backgroundColor: on ? colors.goldBright : 'transparent' }]} />
            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.itemText, { color: on ? colors.ivory : colors.faintText }]}>{item.label}</Text>
          </Tappable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  phoneBar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.ruleSoft, backgroundColor: colors.ebony },
  phoneItem: { flex: 1, alignItems: 'center', minHeight: 56, paddingTop: 20 },
  mark: { position: 'absolute', top: -1, width: 22, height: 1 },
  tabletRow: { flexDirection: 'row', alignItems: 'center', gap: 36 },
  tabletItem: { minHeight: 44, justifyContent: 'center', borderBottomWidth: 1 },
  onWood: { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 8 },
  itemText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase' },
});
