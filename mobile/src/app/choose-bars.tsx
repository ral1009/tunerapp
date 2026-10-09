import { useLocalSearchParams } from 'expo-router';

import { ChooseBarsScreen } from '@/screens/chooseBars/ChooseBarsScreen';
import { useLayoutMode } from '@/theme/settings';

export default function ChooseBarsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChooseBarsScreen layout={useLayoutMode()} id={id} />;
}
