import { useLocalSearchParams } from 'expo-router';

import { ComingNext } from '@/components/ComingNext';
import { PIECES } from '@/data/library';

export default function PieceRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const piece = PIECES.find((p) => p.id === id);
  return <ComingNext title={piece?.title ?? 'Piece'} note="Progress across takes, the bars that need work, and every take." />;
}
