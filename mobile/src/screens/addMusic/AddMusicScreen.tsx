import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/Text';

import { Arrow, BackLink, Body, Display, Eyebrow, Purfling, Screen, Serif, useGutter, Wood } from '@/components/ui';
import { ServerStatusLine } from '@/components/ServerStatus';
import { useLibrary } from '@/data/libraryStore';
import { setPendingUpload, uploadKindOf } from '@/data/pendingUpload';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';
import { go, goChild, goUp } from '@/navigation/go';
import { Tappable } from '@/components/Tappable';

// Add a piece: a new score (name it, then photograph or add each page -- see New score), or open a
// file (MusicXML is used as-is; a PDF or photo is read like a new score's pages).
export function AddMusicScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  // The photo card and the other ways in sit side by side on an iPad on its side, one above the
  // other when it's upright.
  const window = useWindowDimensions();
  const sideBySide = tablet && window.width > window.height;
  const g = useGutter(layout);
  const [message, setMessage] = useState<string | null>(null);
  const library = useLibrary();

  const chooseFile = async () => {
    setMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const name = asset.name.toLowerCase();
    const isXml = name.endsWith('.musicxml') || name.endsWith('.xml') || (asset.mimeType ?? '').includes('xml');
    const kind = uploadKindOf(asset.name, asset.mimeType ?? '');
    if (!isXml && kind) {
      // A PDF or photo opened here becomes a new score named after the file.
      setPendingUpload({ kind: 'pages', title: asset.name.replace(/\.[^.]+$/, '') || 'New score', files: [{ kind, uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? '', file: asset.file }] });
      goChild({ kind: 'add-music', screen: 'reading' });
      return;
    }
    if (!isXml) {
      setMessage('That file type isn’t supported. Choose a MusicXML file, a PDF or a photo.');
      return;
    }
    setPendingUpload({ kind: 'musicxml', uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? '', file: asset.file });
    goChild({ kind: 'add-music', screen: 'reading' });
  };

  const starters = library.pieces.filter((p) => p.source === 'sample');

  const photoPanel = (
    <Tappable onPress={() => goChild({ kind: 'add-music', screen: 'new-score' })} haptic accessibilityRole="button" accessibilityLabel="New score: name it, then photograph each page" style={[styles.photo, tablet && { height: 420 }]}>
      <Wood variant="hero" style={StyleSheet.absoluteFill} />
      <Purfling />
      <View style={styles.camera} accessibilityElementsHidden>
        <View style={styles.cameraBody} />
        <View style={styles.cameraLens} />
        <View style={styles.cameraHump} />
      </View>
      <View style={styles.photoText}>
        <Eyebrow tone="bright">New score</Eyebrow>
        <Display size={tablet ? 34 : 26}>The part on your music stand</Display>
        <Text style={styles.photoBody}>Name it, then photograph each page. We read the notes and put the pages together into one score, about half a minute a page. Anything we misread, you can fix.</Text>
      </View>
    </Tappable>
  );

  const others = (
    <View style={{ gap: 0 }}>
      <Tappable onPress={chooseFile} accessibilityRole="button" style={styles.option}>
        <View style={{ flex: 1, gap: 6 }}>
          <Serif size={20}>Open a file</Serif>
          <Text style={styles.hint}>MusicXML from MuseScore, Finale or Sibelius, or a PDF from IMSLP.</Text>
        </View>
        <Arrow />
      </Tappable>
      {message ? <Body style={{ color: colors.close, marginTop: 16 }}>{message}</Body> : null}
      {starters.length ? (
        <View style={{ marginTop: 34 }}>
          <Eyebrow tone="muted">Or start with</Eyebrow>
          <View style={{ marginTop: 10 }}>
            {starters.map((p) => (
              <Tappable key={p.id} accessibilityRole="link" onPress={() => go({ kind: 'piece', id: p.id })} style={styles.starter}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Serif size={18}>{p.title}</Serif>
                  <Text style={styles.hint}>{p.measureCount} bars · {p.composer}</Text>
                </View>
                <Text style={styles.open}>Open</Text>
              </Tappable>
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
          <BackLink label="Library" onPress={() => goUp({ kind: 'library' })} />
        </View>
        <Display size={tablet ? 64 : 44} style={{ paddingHorizontal: g, marginTop: 18 }}>Add music</Display>
        <ServerStatusLine quietWhenOnline style={{ paddingHorizontal: g, marginTop: 12 }} />
        <View style={[{ paddingHorizontal: tablet ? g : 16, marginTop: 26 }, sideBySide && styles.bodyTablet]}>
          <View style={sideBySide ? { flex: 1.1 } : null}>{photoPanel}</View>
          <View style={[sideBySide ? { flex: 1 } : { paddingHorizontal: tablet ? 0 : 12, marginTop: tablet ? 36 : 10 }]}>{others}</View>
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
