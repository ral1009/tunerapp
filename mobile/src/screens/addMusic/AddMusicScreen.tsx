import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Arrow, BackLink, Body, Display, Eyebrow, Purfling, Screen, Serif, useGutter, Wood } from '@/components/ui';
import { useLibrary } from '@/data/libraryStore';
import { setPendingUpload } from '@/data/pendingUpload';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Add a piece: photograph a page, choose a photo, or choose a MusicXML file. A photo goes to the
// server's photo reading; MusicXML is used as-is. Either way the next stop is Reading.
export function AddMusicScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const [message, setMessage] = useState<string | null>(null);
  const library = useLibrary();

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

  const starters = library.pieces.filter((p) => p.source === 'sample');

  const photoPanel = (
    <Pressable onPress={takePhoto} accessibilityRole="button" accessibilityLabel="Photograph a page" style={[styles.photo, tablet && { height: 420 }]}>
      <Wood variant="hero" style={StyleSheet.absoluteFill} />
      <Purfling />
      <View style={styles.camera} accessibilityElementsHidden>
        <View style={styles.cameraBody} />
        <View style={styles.cameraLens} />
        <View style={styles.cameraHump} />
      </View>
      <View style={styles.photoText}>
        <Eyebrow tone="bright">Photograph a page</Eyebrow>
        <Display size={tablet ? 34 : 26} style={{ lineHeight: tablet ? 38 : 30 }}>The part on your music stand</Display>
        <Text style={styles.photoBody}>We read the notes from the photo in about half a minute. Anything we misread, you can fix.</Text>
      </View>
    </Pressable>
  );

  const others = (
    <View style={{ gap: 0 }}>
      <Pressable onPress={choosePhoto} accessibilityRole="button" style={styles.option}>
        <View style={{ flex: 1, gap: 6 }}>
          <Serif size={20}>Choose a photo</Serif>
          <Text style={styles.hint}>A picture of the page you already have.</Text>
        </View>
        <Arrow />
      </Pressable>
      <Pressable onPress={chooseFile} accessibilityRole="button" style={styles.option}>
        <View style={{ flex: 1, gap: 6 }}>
          <Serif size={20}>Choose a MusicXML file</Serif>
          <Text style={styles.hint}>Exported from MuseScore, Finale or Sibelius, or downloaded from IMSLP.</Text>
        </View>
        <Arrow />
      </Pressable>
      {message ? <Body style={{ color: colors.close, marginTop: 16 }}>{message}</Body> : null}
      {starters.length ? (
        <View style={{ marginTop: 34 }}>
          <Eyebrow tone="muted">Or start with</Eyebrow>
          <View style={{ marginTop: 10 }}>
            {starters.map((p) => (
              <Pressable key={p.id} accessibilityRole="link" onPress={() => router.push({ pathname: '/piece/[id]', params: { id: p.id } })} style={styles.starter}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Serif size={18}>{p.title}</Serif>
                  <Text style={styles.hint}>{p.measureCount} bars · {p.composer}</Text>
                </View>
                <Text style={styles.open}>Open</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={{ paddingLeft: g - 10, paddingTop: 6 }}>
          <BackLink label="Library" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        </View>
        <Display size={tablet ? 64 : 44} style={{ paddingHorizontal: g, marginTop: 18 }}>Add music</Display>
        <View style={[{ paddingHorizontal: tablet ? g : 16, marginTop: 26 }, tablet && styles.bodyTablet]}>
          <View style={tablet ? { flex: 1.1 } : null}>{photoPanel}</View>
          <View style={[tablet ? { flex: 1 } : { paddingHorizontal: 12, marginTop: 10 }]}>{others}</View>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bodyTablet: { flexDirection: 'row', gap: 64, alignItems: 'flex-start' },
  photo: { height: 270, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30, shadowOffset: { width: 0, height: 20 } },
  photoText: { position: 'absolute', left: 22, right: 22, bottom: 22, gap: 8 },
  photoBody: { fontFamily: fonts.sansLight, fontSize: 13, lineHeight: 20, color: colors.cream },
  camera: { position: 'absolute', left: 22, top: 30, width: 34, height: 26 },
  cameraBody: { position: 'absolute', left: 0, right: 0, top: 5, bottom: 0, borderWidth: 1.2, borderColor: colors.bright },
  cameraLens: { position: 'absolute', left: 11, top: 9, width: 12, height: 12, borderRadius: 6, borderWidth: 1.2, borderColor: colors.bright },
  cameraHump: { position: 'absolute', left: 10, top: 0, width: 14, height: 5, borderWidth: 1.2, borderBottomWidth: 0, borderColor: colors.bright },
  option: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 20, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft, minHeight: 64 },
  starter: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  hint: { fontFamily: fonts.sansLight, fontSize: 12, lineHeight: 18, color: colors.muted },
  open: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 3, textTransform: 'uppercase', color: colors.gold },
});
