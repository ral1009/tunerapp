import { ReadingScreen } from '@/screens/reading/ReadingScreen';
import { useLayoutMode } from '@/theme/settings';

export default function ReadingRoute() {
  return <ReadingScreen layout={useLayoutMode()} />;
}
