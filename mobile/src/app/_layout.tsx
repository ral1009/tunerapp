import {
  BodoniModa_400Regular,
  BodoniModa_400Regular_Italic,
  BodoniModa_500Medium,
  BodoniModa_500Medium_Italic,
} from '@expo-google-fonts/bodoni-moda';
import { HankenGrotesk_300Light, HankenGrotesk_400Regular, HankenGrotesk_500Medium } from '@expo-google-fonts/hanken-grotesk';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { LibraryProvider, useLibrary } from '@/data/libraryStore';
import { TakesProvider } from '@/data/takesStore';
import { SettingsProvider, useSettings } from '@/theme/settings';
import { colors } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync();

const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: colors.ebony, card: colors.ebony, primary: colors.gold, text: colors.ink } };

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    BodoniModa_400Regular,
    BodoniModa_400Regular_Italic,
    BodoniModa_500Medium,
    BodoniModa_500Medium_Italic,
    HankenGrotesk_300Light,
    HankenGrotesk_400Regular,
    HankenGrotesk_500Medium,
  });

  return (
    <SettingsProvider>
      <LibraryProvider>
        <TakesProvider>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            <Gate ready={fontsLoaded || !!fontError} />
          </ThemeProvider>
        </TakesProvider>
      </LibraryProvider>
    </SettingsProvider>
  );
}

// Holds the splash screen until fonts and saved settings are in, so the first frame is already
// in the right layout and typeface.
function Gate({ ready }: { ready: boolean }) {
  const { loaded } = useSettings();
  const library = useLibrary();
  const show = ready && loaded && library.loaded;
  useEffect(() => {
    if (show) SplashScreen.hideAsync();
  }, [show]);
  if (!show) return null;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ebony }, animation: 'fade' }} />;
}
