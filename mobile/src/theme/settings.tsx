import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';

import type { WoodKey } from './woods';

// Player settings, saved on the device. The grading options mirror practice/reviewSummary.ts in
// the web app (reference, strictness); layout and score theme are new for the native app.
export type LayoutPreference = 'auto' | 'phone' | 'tablet';
export type ScoreTheme = 'paper' | 'ebony' | 'auto';
export type GradeReference = 'a440' | 'own';
export type Strictness = 'relaxed' | 'standard' | 'strict';

export interface Settings {
  layout: LayoutPreference;
  scoreTheme: ScoreTheme;
  reference: GradeReference;
  strictness: Strictness;
  referencePitchHz: 440 | 442 | 443;
  wood: WoodKey;
}

export const DEFAULT_SETTINGS: Settings = {
  layout: 'auto',
  scoreTheme: 'paper',
  reference: 'a440',
  strictness: 'standard',
  referencePitchHz: 440,
  wood: 'maple',
};

const STORAGE_KEY = 'tunerapp.settings.v1';

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  loaded: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
      })
      .catch(() => {
        // A missing or corrupt entry just means defaults.
      })
      .finally(() => setLoaded(true));
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      loaded,
      update: (patch) =>
        setSettings((previous) => {
          const next = { ...previous, ...patch };
          AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
          return next;
        }),
    }),
    [settings, loaded],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside SettingsProvider');
  return value;
}

// Which set of screens to show. "Auto" picks by the device's shorter side, so an iPad in either
// orientation gets the iPad screens and a phone gets the phone screens; the setting lets either
// device use the other's screens.
export type LayoutMode = 'phone' | 'tablet';

export function useLayoutMode(): LayoutMode {
  const { settings } = useSettings();
  const { width, height } = useWindowDimensions();
  if (settings.layout !== 'auto') return settings.layout;
  return Math.min(width, height) >= 600 ? 'tablet' : 'phone';
}

// The score's look right now. "Auto" will follow the room's light once that's wired; until then
// it uses paper, the look most players read best.
export function useScoreTheme(): 'paper' | 'ebony' {
  const { settings } = useSettings();
  return settings.scoreTheme === 'ebony' ? 'ebony' : 'paper';
}
