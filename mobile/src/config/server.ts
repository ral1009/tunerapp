import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Where the Python server (photo reading, score following) is. During development it runs on the
// same computer as the Expo dev server, so its address is Metro's host with port 8000: the phone
// or iPad on the same Wi-Fi reaches it the way it reaches Metro. EXPO_PUBLIC_SERVER_URL overrides
// (e.g. a hosted server later). The server must listen on the network for a device to reach it:
// `uvicorn main:app --host 0.0.0.0 --port 8000`.
export function serverUrl(): string {
  const override = process.env.EXPO_PUBLIC_SERVER_URL;
  if (override) return override.replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') return `http://${window.location.hostname}:8000`;
  const hostUri = Constants.expoConfig?.hostUri; // "192.168.1.82:8081"
  const host = hostUri ? hostUri.split(':')[0] : 'localhost';
  return `http://${host}:8000`;
}
