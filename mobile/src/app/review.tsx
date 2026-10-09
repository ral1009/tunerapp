import { useLocalSearchParams } from 'expo-router';

import { ReviewScreen } from '@/screens/review/ReviewScreen';
import { useLayoutMode } from '@/theme/settings';

export default function ReviewRoute() {
  const { takeId } = useLocalSearchParams<{ takeId: string }>();
  return <ReviewScreen layout={useLayoutMode()} takeId={takeId} />;
}
