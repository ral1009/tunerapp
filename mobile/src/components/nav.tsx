import { Link, type Href } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useLibrary } from '@/data/libraryStore';
import { colors, fonts } from '@/theme/tokens';
import { Tappable } from '@/components/Tappable';

type Section = 'library' | 'practise' | 'tuner' | 'settings';

// Phone: four words along the bottom, a gold hairline over the current one. iPad: the same four
// as tracked caps in the header, underlined.
export function NavBar({ current, layout }: { current: Section; layout: 'phone' | 'tablet' }) {
  const insets = useSafeAreaInsets();
  const library = useLibrary();
  const items: { key: Section; label: string; href: Href }[] = [
    { key: 'library', label: 'Library', href: '/' },
    // "Practise" picks up the piece you were last in; with an empty library it adds music.
    { key: 'practise', label: 'Practise', href: library.current ? { pathname: '/practice', params: { id: library.current.id } } : '/add-music' },
    { key: 'tuner', label: 'Tuner', href: '/tuner' },
    { key: 'settings', label: 'Settings', href: '/settings' },
  ];
  if (layout === 'tablet') {
    return (
      <View style={styles.tabletRow}>
        {items.map((item) => {
          const on = item.key === current;
          return (
            <Link key={item.key} href={item.href} asChild replace={item.key !== 'practise'}>
              <Tappable haptic accessibilityRole="link" accessibilityState={{ selected: on }} style={StyleSheet.flatten([styles.tabletItem, { borderBottomColor: on ? colors.goldBright : 'transparent' }])}>
                <Text style={[styles.itemText, { color: on ? colors.ivory : colors.faintText }]}>{item.label}</Text>
              </Tappable>
            </Link>
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
          <Link key={item.key} href={item.href} asChild replace={item.key !== 'practise'}>
            <Tappable haptic accessibilityRole="link" accessibilityState={{ selected: on }} style={styles.phoneItem}>
              <View style={[styles.mark, { backgroundColor: on ? colors.goldBright : 'transparent' }]} />
              <Text style={[styles.itemText, { color: on ? colors.ivory : colors.faintText }]}>{item.label}</Text>
            </Tappable>
          </Link>
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
  itemText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase' },
});
