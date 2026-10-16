import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { goChild, goUp } from '@/navigation/go';
import { useState } from 'react';
import { Image, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Text } from '@/components/Text';

import { BackLink, Body, Display, Eyebrow, GoldButton, Purfling, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { ServerStatusLine } from '@/components/ServerStatus';
import { Tappable } from '@/components/Tappable';
import { setPendingUpload, uploadKindOf, type UploadFile } from '@/data/pendingUpload';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// A new score in two steps: name it, then add its pages -- photograph each one in turn, choose
// photos, or add a PDF. Reading puts every page together into one score.
export function NewScoreScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const [title, setTitle] = useState('');
  const [named, setNamed] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [gridWidth, setGridWidth] = useState(0);

  const add = (added: UploadFile[]) => {
    if (added.length) setFiles((current) => [...current, ...added]);
  };

  const fromAsset = (asset: ImagePicker.ImagePickerAsset, n: number): UploadFile => ({
    kind: 'image',
    uri: asset.uri,
    name: asset.fileName ?? `page-${n}.jpg`,
    mimeType: asset.mimeType ?? 'image/jpeg',
    width: asset.width,
    height: asset.height,
    file: (asset as { file?: File }).file,
  });

  const photograph = async () => {
    setMessage(null);
    if (Platform.OS !== 'web') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setMessage('Camera access is off. Choose photos instead, or allow the camera in Settings.');
        return;
      }
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9 });
    if (!result.canceled && result.assets[0]) add([fromAsset(result.assets[0], files.length + 1)]);
  };

  const choosePhotos = async () => {
    setMessage(null);
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, allowsMultipleSelection: true, orderedSelection: true, selectionLimit: 0 });
    if (!result.canceled) add(result.assets.map((a, i) => fromAsset(a, files.length + i + 1)));
  };

  const chooseFiles = async () => {
    setMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf', 'image/*'], multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    const picked: UploadFile[] = [];
    let skipped = 0;
    for (const asset of result.assets) {
      const kind = uploadKindOf(asset.name, asset.mimeType ?? '');
      if (!kind) {
        skipped += 1;
        continue;
      }
      picked.push({ kind, uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? (kind === 'pdf' ? 'application/pdf' : 'image/jpeg'), file: asset.file });
    }
    if (skipped) setMessage(`${skipped === 1 ? 'One file was' : `${skipped} files were`} skipped: only photos and PDFs can be read.`);
    add(picked);
  };

  const remove = (index: number) => setFiles((current) => current.filter((_, i) => i !== index));
  const moveEarlier = (index: number) =>
    setFiles((current) => {
      if (index <= 0) return current;
      const next = [...current];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });

  const read = () => {
    setPendingUpload({ kind: 'pages', title: title.trim() || 'New score', files });
    goChild({ kind: 'add-music', screen: 'reading' });
  };

  const back = () => (named ? setNamed(false) : goUp({ kind: 'add-music' }));

  if (!named) {
    const next = () => title.trim() && setNamed(true);
    return (
      <Screen layout={layout}>
        <View style={{ paddingLeft: g - 10, paddingTop: 6 }}>
          <BackLink label="Add music" onPress={back} />
        </View>
        <View style={{ paddingHorizontal: g, marginTop: tablet ? 90 : 48, gap: 26, maxWidth: 760 }}>
          <View style={{ gap: 10 }}>
            <Eyebrow>New score · step one of two</Eyebrow>
            <Display size={tablet ? 56 : 40}>What are you playing?</Display>
          </View>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title of the piece"
            placeholderTextColor={colors.faint}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={next}
            autoCapitalize="words"
            accessibilityLabel="Title of the piece"
            style={[styles.nameInput, { fontSize: tablet ? 40 : 30 }]}
          />
          <Body>Next you&rsquo;ll photograph each page, in order. You can also add photos you already have, or a PDF.</Body>
          <View style={{ flexDirection: 'row' }}>
            <GoldButton label="Next — add pages" onPress={next} disabled={!title.trim()} />
          </View>
        </View>
      </Screen>
    );
  }

  const columns = tablet ? 4 : 3;
  const gap = tablet ? 22 : 14;
  const pageCount = files.length;
  const cell = gridWidth ? Math.floor((gridWidth - gap * (columns - 1)) / columns) : 0;

  return (
    <Screen layout={layout}>
      <ScrollView contentContainerStyle={{ paddingBottom: 140 }} keyboardShouldPersistTaps="handled">
        <View style={{ paddingLeft: g - 10, paddingTop: 6 }}>
          <BackLink label="Name" onPress={back} />
        </View>
        <View style={{ paddingHorizontal: g, marginTop: 18, gap: 8 }}>
          <Eyebrow>New score · step two of two</Eyebrow>
          <Tappable onPress={() => setNamed(false)} accessibilityRole="button" accessibilityLabel={`Rename ${title}`}>
            <Display size={tablet ? 56 : 38} numberOfLines={2}>{title}</Display>
          </Tappable>
          <Text style={styles.count}>{pageCount === 0 ? 'No pages yet' : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · read in this order`}</Text>
        </View>

        <View style={{ paddingHorizontal: g, marginTop: 26 }}>
        <View style={[styles.grid, { gap }]} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
          {files.map((f, i) => (
            <View key={`${f.uri}-${i}`} style={{ width: cell, gap: 8 }}>
              <View style={styles.thumb}>
                {f.kind === 'pdf' ? (
                  <View style={styles.pdf}>
                    <Text style={styles.pdfMark}>PDF</Text>
                    <Text style={styles.pdfName} numberOfLines={3}>{f.name}</Text>
                  </View>
                ) : (
                  <Image source={{ uri: f.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityLabel={`Page ${i + 1}`} />
                )}
                <Text style={styles.pageNumber}>{i + 1}</Text>
              </View>
              <View style={styles.thumbActions}>
                {i > 0 ? (
                  <Tappable onPress={() => moveEarlier(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Move page ${i + 1} earlier`}>
                    <Text style={styles.thumbAction}>‹ Earlier</Text>
                  </Tappable>
                ) : <View />}
                <Tappable onPress={() => remove(i)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove page ${i + 1}`}>
                  <Text style={styles.thumbAction}>Remove</Text>
                </Tappable>
              </View>
            </View>
          ))}
          <Tappable onPress={photograph} haptic accessibilityRole="button" accessibilityLabel={pageCount ? 'Photograph the next page' : 'Photograph the first page'} style={[styles.addCard, { width: cell }]}>
            <Wood variant="dim" style={StyleSheet.absoluteFill} />
            <Purfling />
            <View style={styles.addInner}>
              <Text style={styles.plus}>+</Text>
              <Text style={styles.addText}>{pageCount ? `Photograph page ${pageCount + 1}` : 'Photograph page 1'}</Text>
            </View>
          </Tappable>
        </View>
        </View>

        <View style={{ paddingHorizontal: g, marginTop: 30, gap: 4, maxWidth: 640 }}>
          <TextButton label="Choose photos" arrow onPress={choosePhotos} style={styles.option} />
          <TextButton label="Add a PDF or image file" arrow onPress={chooseFiles} style={styles.option} />
          <Text style={styles.hint}>iPhone (HEIC), Pixel and other phone photos, RAW (DNG) and PDFs all work. A PDF adds every page in it.</Text>
          {message ? <Body style={{ color: colors.close, marginTop: 10 }}>{message}</Body> : null}
          <ServerStatusLine quietWhenOnline style={{ marginTop: 14 }} />
        </View>
      </ScrollView>
      <View style={[styles.footer, { paddingHorizontal: g }]}>
        <Text style={styles.footerText}>{pageCount ? `About ${Math.max(1, Math.round((pageCount * 30) / 60))} min to read` : 'Add at least one page'}</Text>
        <GoldButton label={pageCount > 1 ? `Read all ${pageCount} pages` : 'Read the page'} onPress={read} disabled={pageCount === 0} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // outlineWidth: the web build's focus ring; the gold rule is the field's edge.
  nameInput: { fontFamily: fonts.display, color: colors.bright, borderBottomWidth: 1, borderBottomColor: colors.gold, paddingVertical: 10, outlineWidth: 0 },
  count: { fontFamily: fonts.sansLight, fontSize: 13, color: colors.cream },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  thumb: { aspectRatio: 0.77, backgroundColor: colors.paper, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 16, shadowOffset: { width: 0, height: 10 } },
  pdf: { flex: 1, padding: 14, justifyContent: 'center', gap: 8 },
  pdfMark: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 4, color: colors.paperGold },
  pdfName: { fontFamily: fonts.serif, fontSize: 13, color: colors.paperInk },
  pageNumber: { position: 'absolute', left: 0, bottom: 0, minWidth: 30, paddingVertical: 4, paddingHorizontal: 8, backgroundColor: 'rgba(11,8,6,0.82)', color: colors.goldBright, fontFamily: fonts.display, fontSize: 16, textAlign: 'center' },
  thumbActions: { flexDirection: 'row', justifyContent: 'space-between' },
  thumbAction: { fontFamily: fonts.sansMedium, fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: colors.soft, paddingVertical: 4 },
  addCard: { aspectRatio: 0.77, overflow: 'hidden', borderWidth: 1, borderColor: colors.rule },
  addInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 12 },
  plus: { fontFamily: fonts.serif, fontSize: 40, lineHeight: 46, color: colors.goldBright },
  addText: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 2.5, textTransform: 'uppercase', color: colors.champagne, textAlign: 'center' },
  option: { minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft, justifyContent: 'space-between' },
  hint: { fontFamily: fonts.sansLight, fontSize: 12, lineHeight: 18, color: colors.muted, marginTop: 12 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 16, paddingBottom: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, backgroundColor: 'rgba(11,8,6,0.94)', borderTopWidth: 1, borderTopColor: colors.ruleSoft },
  footerText: { flex: 1, fontFamily: fonts.sansLight, fontSize: 12, color: colors.soft },
});
