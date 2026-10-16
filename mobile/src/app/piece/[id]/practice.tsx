import { useLocalSearchParams } from 'expo-router';

import { PracticeScreen } from '@/screens/practice/PracticeScreen';
import { useLayoutMode } from '@/theme/settings';

export default function PracticeRoute() {
  const { id, from, to } = useLocalSearchParams<{ id: string; from?: string; to?: string }>();
  const layout = useLayoutMode();
  return (
    <PracticeScreen
      key={`${id}-${from ?? ''}-${to ?? ''}`}
      layout={layout}
      id={id}
      fromBar={from ? Number(from) : undefined}
      toBar={to ? Number(to) : undefined}
    />
  );
}
