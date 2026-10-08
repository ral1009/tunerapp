import { WelcomeScreen } from '@/screens/welcome/WelcomeScreen';
import { useLayoutMode } from '@/theme/settings';

export default function WelcomeRoute() {
  return <WelcomeScreen layout={useLayoutMode()} />;
}
