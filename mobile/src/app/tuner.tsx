import { TunerScreen } from '@/screens/tuner/TunerScreen';
import { useLayoutMode } from '@/theme/settings';

export default function TunerRoute() {
  return <TunerScreen layout={useLayoutMode()} />;
}
