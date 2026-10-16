import { MicCheckScreen } from '@/screens/micCheck/MicCheckScreen';
import { useLayoutMode } from '@/theme/settings';

export default function MicCheckRoute() {
  return <MicCheckScreen layout={useLayoutMode()} />;
}
