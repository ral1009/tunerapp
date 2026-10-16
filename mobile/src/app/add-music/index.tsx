import { AddMusicScreen } from '@/screens/addMusic/AddMusicScreen';
import { useLayoutMode } from '@/theme/settings';

export default function AddMusicRoute() {
  return <AddMusicScreen layout={useLayoutMode()} />;
}
