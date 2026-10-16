import { useLocalSearchParams } from 'expo-router';

import { ScoreScreen } from '@/screens/score/ScoreScreen';
import { useLayoutMode } from '@/theme/settings';

export default function ScoreRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ScoreScreen layout={useLayoutMode()} id={id} />;
}
