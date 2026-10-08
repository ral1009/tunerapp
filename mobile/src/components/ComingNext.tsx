import { router } from 'expo-router';
import { View } from 'react-native';

import { Body, Display, Eyebrow, Screen, TextButton, useGutter } from '@/components/ui';
import { useLayoutMode } from '@/theme/settings';

// Stand-in for a screen from the design canvas that isn't built yet, so navigation works end to end.
export function ComingNext({ title, note }: { title: string; note: string }) {
  const layout = useLayoutMode();
  const g = useGutter(layout);
  return (
    <Screen layout={layout}>
      <View style={{ flex: 1, paddingHorizontal: g, paddingTop: 32, gap: 16 }}>
        <TextButton label="← Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Eyebrow>Coming next</Eyebrow>
        <Display size={layout === 'tablet' ? 56 : 38}>{title}</Display>
        <Body style={{ maxWidth: 520 }}>{note}</Body>
      </View>
    </Screen>
  );
}
