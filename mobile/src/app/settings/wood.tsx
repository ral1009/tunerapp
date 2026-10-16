import { WoodScreen } from '@/screens/wood/WoodScreen';
import { useLayoutMode } from '@/theme/settings';

export default function WoodRoute() {
  return <WoodScreen layout={useLayoutMode()} />;
}
