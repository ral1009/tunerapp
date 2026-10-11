import { NewScoreScreen } from '@/screens/newScore/NewScoreScreen';
import { useLayoutMode } from '@/theme/settings';

export default function NewScoreRoute() {
  return <NewScoreScreen layout={useLayoutMode()} />;
}
