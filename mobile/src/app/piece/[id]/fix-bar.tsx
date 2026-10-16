import { useLocalSearchParams } from 'expo-router';

import { FixBarScreen } from '@/screens/fixBar/FixBarScreen';
import { useLayoutMode } from '@/theme/settings';

export default function FixBarRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <FixBarScreen layout={useLayoutMode()} id={id} />;
}
