import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts } from '@/theme/tokens';

type Section = 'library' | 'tuner' | 'settings';
const ITEMS: { key: Section; label: string; href: Href }[] = [
  { key: 'library', label: 'Library', href: '/' },
  { key: 'tuner', label: 'Tuner', href: '/tuner' },
  { key: 'settings', label: 'Settings', href: '/settings' },
];

// Phone: a bar along the bottom. iPad: the same three as tracked caps in the header.
export function NavBar({ current, layout }: { current: Section; layout: 'phone' | 'tablet' }) {
  const insets = useSafeAreaInsets();
  if (layout === 'tablet') {
    return (
      <View style={styles.tabletRow}>
        {ITEMS.map((item) => (
          <NavItem key={item.key} item={item} on={item.key === current} underline />
        ))}
        <Link href="/add-music" asChild>
          <Pressable accessibilityRole="button" style={styles.addButton}>
            <Text style={styles.addText}>+ Add music</Text>
          </Pressable>
        </Link>
      </View>
    );
  }
  return (
    <View style={[styles.phoneBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {ITEMS.map((item) => (
        <NavItem key={item.key} item={item} on={item.key === current} />
      ))}
    </View>
  );
}

function NavItem({ item, on, underline }: { item: (typeof ITEMS)[number]; on: boolean; underline?: boolean }) {
  return (
    <Link href={item.href} asChild replace>
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ selected: on }}
        style={StyleSheet.flatten([styles.item, underline && { borderBottomWidth: 1, borderBottomColor: on ? colors.gold : 'transparent' }])}
      >
        <Text style={[styles.itemText, { color: on ? colors.goldBright : colors.muted, fontFamily: on ? fonts.sansMedium : fonts.sans }]}>
          {item.label}
        </Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  phoneBar: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(201,164,106,0.18)', backgroundColor: colors.ebony },
  tabletRow: { flexDirection: 'row', alignItems: 'center', gap: 36 },
  item: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: 10.5, letterSpacing: 3, textTransform: 'uppercase' },
  addButton: { minHeight: 44, paddingHorizontal: 22, borderWidth: 1, borderColor: colors.gold, justifyContent: 'center' },
  addText: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 3, textTransform: 'uppercase', color: colors.goldBright },
});
