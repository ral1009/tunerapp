import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Body, Display, Eyebrow, Rule, Screen, Serif, TextButton, useGutter } from '@/components/ui';
import { setPendingUpload } from '@/data/pendingUpload';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Add a piece: photograph a page, choose a photo, or choose a MusicXML file. A photo goes to the
// server's photo reading; MusicXML is used as-is. Either way the next stop is Reading.
export function AddMusicScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const [message, setMessage] = useState<string | null>(null);

  const sendPhoto = (asset: ImagePicker.ImagePickerAsset) => {
    setPendingUpload({
      kind: 'image',
      uri: asset.uri,
      name: asset.fileName ?? 'page.jpg',
      mimeType: asset.mimeType ?? 'image/jpeg',
      file: (asset as { file?: File }).file,
    });
    router.push('/reading');
  };

  const takePhoto = async () => {
    setMessage(null);
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setMessage('Camera access is off. You can choose a photo instead, or allow the camera in Settings.');
        return;
      }
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (!result.canceled && result.assets[0]) sendPhoto(result.assets[0]);
  };

  const choosePhoto = async () => {
    setMessage(null);
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (!result.canceled && result.assets[0]) sendPhoto(result.assets[0]);
  };

  const chooseFile = async () => {
    setMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const name = asset.name.toLowerCase();
    const isXml = name.endsWith('.musicxml') || name.endsWith('.xml') || (asset.mimeType ?? '').includes('xml');
    const isImage = (asset.mimeType ?? '').startsWith('image/') || /\.(jpe?g|png|heic|webp)$/.test(name);
    if (!isXml && !isImage) {
      setMessage('That file type isn’t supported yet. Choose a photo of the page or a MusicXML file.');
      return;
    }
    setPendingUpload({ kind: isXml ? 'musicxml' : 'image', uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? '', file: asset.file });
    router.push('/reading');
  };

  const options = [
    { title: 'Take a photo', hint: 'Lay the page flat in good light and fit the whole page in the frame.', onPress: takePhoto },
    { title: 'Choose a photo', hint: 'A picture of the page you already have.', onPress: choosePhoto },
    { title: 'Choose a file', hint: 'A MusicXML file exported from notation software or a digital part.', onPress: chooseFile },
  ];

  const illustration = (
    <View style={[styles.frame, tablet ? { width: 300, height: 400 } : { width: 220, height: 290 }]} accessibilityElementsHidden>
      <View style={[styles.page, { transform: [{ rotate: '-2.5deg' }] }]}>
        <Text style={styles.pageCaps}>A PAGE OF MUSIC</Text>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <View key={i} style={{ gap: 3, marginHorizontal: 16, marginTop: i === 0 ? 14 : 14 }}>
            {[0, 1, 2, 3, 4].map((k) => (
              <View key={k} style={{ height: 1, backgroundColor: 'rgba(20,17,14,0.55)' }} />
            ))}
          </View>
        ))}
      </View>
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <View key={c} style={[styles.corner, c.includes('t') ? { top: 0, borderTopWidth: 2 } : { bottom: 0, borderBottomWidth: 2 }, c.includes('l') ? { left: 0, borderLeftWidth: 2 } : { right: 0, borderRightWidth: 2 }]} />
      ))}
    </View>
  );

  const list = (
    <View style={{ flex: 1, minWidth: 280 }}>
      {options.map((o) => (
        <Pressable key={o.title} onPress={o.onPress} accessibilityRole="button" style={styles.option}>
          <View style={{ flex: 1, gap: 4 }}>
            <Serif size={20}>{o.title}</Serif>
            <Text style={styles.hint}>{o.hint}</Text>
          </View>
          <Text style={styles.arrow}>→</Text>
        </Pressable>
      ))}
      {message ? <Body style={{ color: colors.close, marginTop: 16 }}>{message}</Body> : null}
      <Text style={[styles.hint, { marginTop: 20 }]}>Reading a photo takes about half a minute. Printed parts read best; handwriting doesn&rsquo;t read yet.</Text>
    </View>
  );

  return (
    <Screen layout={layout}>
      <View style={{ flex: 1, paddingHorizontal: g, paddingTop: tablet ? 40 : 24 }}>
        <TextButton label="← Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Eyebrow style={{ marginTop: 8 }}>Add music</Eyebrow>
        <Display size={tablet ? 56 : 36} style={{ marginTop: 10 }}>A new piece</Display>
        {tablet ? <Rule style={{ marginTop: 28 }} /> : null}
        <View style={[styles.body, tablet && styles.bodyTablet]}>
          <View style={{ alignItems: 'center', paddingVertical: tablet ? 0 : 24 }}>{illustration}</View>
          {list}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  bodyTablet: { flexDirection: 'row', alignItems: 'center', gap: 80, paddingBottom: 40 },
  frame: { alignItems: 'center', justifyContent: 'center' },
  page: { width: '82%', height: '86%', backgroundColor: '#F3EEE3', shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 16, shadowOffset: { width: 0, height: 12 }, elevation: 8 },
  pageCaps: { marginTop: 12, textAlign: 'center', fontFamily: fonts.serif, fontSize: 10, letterSpacing: 1, color: '#2A211B' },
  corner: { position: 'absolute', width: 26, height: 26, borderColor: colors.goldBright },
  option: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft, minHeight: 64 },
  hint: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, color: colors.muted },
  arrow: { fontFamily: fonts.sans, fontSize: 18, color: colors.gold },
});
