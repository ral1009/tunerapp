import { useLocalSearchParams } from 'expo-router';

import { PieceScreen } from '@/screens/piece/PieceScreen';
import { useLayoutMode } from '@/theme/settings';

export default function PieceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PieceScreen layout={useLayoutMode()} id={id} />;
}
