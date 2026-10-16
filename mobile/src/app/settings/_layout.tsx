import { Stack } from 'expo-router';

import { stackOptions } from '@/navigation/stackOptions';

// The branch's first screen always sits under the others, so back from any of them lands on it.
export const unstable_settings = { initialRouteName: 'index' };

export default function BranchLayout() {
  return <Stack screenOptions={stackOptions} />;
}
