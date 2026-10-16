import { SettingsScreen } from '@/screens/settings/SettingsScreen';
import { useLayoutMode } from '@/theme/settings';

export default function SettingsRoute() {
  return <SettingsScreen layout={useLayoutMode()} />;
}
