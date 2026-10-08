import { LibraryPhone } from '@/screens/library/LibraryPhone';
import { LibraryTablet } from '@/screens/library/LibraryTablet';
import { useLayoutMode } from '@/theme/settings';

export default function LibraryRoute() {
  return useLayoutMode() === 'tablet' ? <LibraryTablet /> : <LibraryPhone />;
}
