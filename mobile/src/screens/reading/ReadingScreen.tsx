import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';

import { BackLink, Body, Display, Eyebrow, GoldButton, Progress, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { serverUrl } from '@/config/server';
import { useLibrary } from '@/data/libraryStore';
import { takePendingUpload, type PendingUpload } from '@/data/pendingUpload';
import { ScoreView } from '@/score/ScoreView';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Photo reading on the server takes ~25-30 s for a full page (CLAUDE.md, HOMR speed pass); the
// progress line is an estimate against that, since the server doesn't report progress.
const EXPECTED_SECONDS = 28;

type Phase = 'sending' | 'reading' | 'checking' | 'done' | 'error';

async function readMusicXml(upload: PendingUpload): Promise<string> {
  if (upload.file) return upload.file.text();
  const response = await fetch(upload.uri);
  return response.text();
}

// Phone photos are 12+ megapixels and may be HEIC; HOMR reads a 1300×1700 JPEG perfectly well.
// Shrinking to this long edge and re-encoding as JPEG makes the upload a few hundred KB.
const MAX_PHOTO_EDGE = 2200;
const UPLOAD_TIMEOUT_MS = 45000;
const POLL_MS = 1500;
const POLL_FAILURES_ALLOWED = 6;

async function preparePhoto(upload: PendingUpload): Promise<{ uri: string; name: string; type: string }> {
  const first = await ImageManipulator.manipulate(upload.uri).renderAsync();
  const longEdge = Math.max(first.width, first.height);
  const image = longEdge > MAX_PHOTO_EDGE
    ? await ImageManipulator.manipulate(upload.uri).resize(first.width >= first.height ? { width: MAX_PHOTO_EDGE } : { height: MAX_PHOTO_EDGE }).renderAsync()
    : first;
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: saved.uri, name: 'page.jpg', type: 'image/jpeg' };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Photo reading runs as a job on the server: upload, then ask how it's going until it's done. One
// long request used to carry the whole read, and a phone drops a request after about a minute --
// a big photo can take HOMR longer than that -- losing the read with no explanation.
async function readPhoto(upload: PendingUpload, isCancelled: () => boolean): Promise<string> {
  const form = new FormData();
  if (upload.file) form.append('file', upload.file, upload.name);
  // React Native's FormData takes a { uri, name, type } descriptor for a local file.
  else form.append('file', (await preparePhoto(upload)) as unknown as Blob);
  const base = serverUrl();
  let jobId: string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/parse-sheet/jobs`, { method: 'POST', body: form, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.jobId) throw new Error(body.error ?? `The server didn't accept the photo (${response.status}).`);
    jobId = body.jobId;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`Sending the photo to ${base} took too long. Is the laptop's Wi-Fi connection slow?`);
    if (e instanceof TypeError) throw new Error(`Couldn't reach the server at ${base}. Is it running, and is the phone on the same Wi-Fi?`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let failures = 0;
  for (;;) {
    if (isCancelled()) throw new Error('Cancelled');
    await wait(POLL_MS);
    try {
      const response = await fetch(`${base}/api/parse-sheet/jobs/${jobId}`);
      const body = await response.json();
      failures = 0;
      if (body.status === 'done' && body.xmlData) return body.xmlData as string;
      if (body.status === 'error' || !response.ok) throw new Error(body.error ?? 'The photo couldn’t be read.');
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      failures += 1;
      if (failures > POLL_FAILURES_ALLOWED) throw new Error(`Lost the connection to the server at ${base} while it was reading the photo.`);
    }
  }
}

export function ReadingScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const [upload] = useState(() => takePendingUpload());
  const [phase, setPhase] = useState<Phase>(upload ? 'sending' : 'error');
  const [error, setError] = useState<string | null>(upload ? null : 'Nothing to read. Go back and choose a page or a file.');
  const [xml, setXml] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const addedRef = useRef(false);

  useEffect(() => {
    if (!upload) return;
    let cancelled = false;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 500);
    (async () => {
      try {
        const text = upload.kind === 'musicxml' ? await readMusicXml(upload) : (setPhase('reading'), await readPhoto(upload, () => cancelled));
        if (cancelled) return;
        setXml(text);
        setPhase('checking');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      } finally {
        clearInterval(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [upload]);

  // The score engine reads the MusicXML (title, bars, misread bars) without drawing it.
  const onEngine = (event: EngineEvent) => {
    if (event.type === 'error') {
      setError(`The music couldn't be read: ${event.message}`);
      setPhase('error');
    }
    if (event.type !== 'loaded' || addedRef.current || !xml || !upload) return;
    addedRef.current = true;
    const title = event.meta.title && event.meta.title !== 'Untitled' ? event.meta.title : upload.name.replace(/\.[^.]+$/, '') || 'New piece';
    const id = library.add({
      title,
      composer: event.meta.composer,
      xml,
      source: upload.kind === 'image' ? 'photo' : 'file',
      measureCount: event.meta.measureCount,
      measureIssues: event.meta.measureIssues,
    });
    setPhase('done');
    router.replace({ pathname: '/piece/[id]', params: { id } });
  };

  const fraction = phase === 'reading' ? Math.min(0.95, elapsed / EXPECTED_SECONDS) : phase === 'sending' ? 0.04 : phase === 'error' ? 0 : 1;
  const left = Math.max(0, Math.round(EXPECTED_SECONDS - elapsed));
  const steps = [
    { label: upload?.kind === 'musicxml' ? 'Opened the file' : 'Sent the page', state: phase === 'sending' ? 'now' : 'done' },
    { label: 'Reading the notes, staff by staff', state: phase === 'reading' ? 'now' : phase === 'sending' ? 'next' : 'done' },
    { label: 'Checking every bar adds up', state: phase === 'checking' ? 'now' : phase === 'done' ? 'done' : 'next' },
  ].filter((s) => upload?.kind !== 'musicxml' || !s.label.startsWith('Reading the notes'));

  const staffWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const staff = Math.min(7, Math.floor(fraction * 8));
  const headline =
    phase === 'reading' ? `Staff ${staffWords[staff]} of eight` : phase === 'checking' ? 'Checking every bar' : phase === 'done' ? 'Done' : 'Opening';
  const pageW = tablet ? 300 : 246;
  const pageH = tablet ? 410 : 340;

  return (
    <Screen layout={layout} edges={['bottom']} glow={false}>
      <Wood variant="hero" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: tablet ? 640 : 540 }} />
      <View style={{ paddingLeft: g - 10, paddingTop: 52 }}>
        <BackLink label="Cancel" tone="light" onPress={() => router.back()} />
      </View>
      <View style={{ alignItems: 'center', marginTop: tablet ? 30 : 12 }}>
        <View style={[styles.page, { width: pageW, height: pageH }]}>
          <View style={{ alignItems: 'center', gap: 3, marginTop: 16 }}>
            <View style={{ width: 70, height: 6, backgroundColor: 'rgba(20,17,14,0.55)' }} />
            <View style={{ width: 44, height: 3, backgroundColor: 'rgba(20,17,14,0.35)' }} />
          </View>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <View key={i} style={{ marginHorizontal: 18, marginTop: i === 0 ? 18 : (pageH - 90) / 8 - 13, backgroundColor: i < staff || phase === 'checking' ? 'rgba(201,164,106,0.16)' : 'transparent' }}>
              {[0, 1, 2, 3, 4].map((k) => (
                <View key={k} style={{ height: 1, marginBottom: k < 4 ? 3 : 0, backgroundColor: 'rgba(20,17,14,0.62)' }} />
              ))}
            </View>
          ))}
          {phase !== 'error' && phase !== 'done' ? <View style={[styles.scan, { top: `${14 + fraction * 80}%` }]} /> : null}
        </View>
      </View>

      <View style={{ paddingHorizontal: g, marginTop: 'auto', paddingBottom: 30, gap: 18, maxWidth: 640 }}>
        {phase === 'error' ? (
          <>
            <Display size={tablet ? 40 : 30}>That didn&rsquo;t work</Display>
            <Body>{error}</Body>
            <View style={{ flexDirection: 'row', gap: 28, alignItems: 'center' }}>
              <TextButton label="Back" onPress={() => router.back()} />
              <GoldButton label="Try another page" onPress={() => router.replace('/add-music')} />
            </View>
          </>
        ) : (
          <>
            <View style={{ gap: 8 }}>
              <Eyebrow>{upload?.kind === 'musicxml' ? 'Opening your file' : 'Reading your page'}</Eyebrow>
              <Display size={tablet ? 40 : 30}>{headline}</Display>
            </View>
            <Progress value={fraction} />
            <View style={{ gap: 14 }}>
              {steps.map((st) => (
                <View key={st.label} style={styles.step}>
                  <Text style={[styles.mark, { color: st.state === 'done' ? colors.gold : colors.goldBright }]}>{st.state === 'done' ? '✓' : st.state === 'now' ? '—' : ''}</Text>
                  <Text style={[styles.stepText, { color: st.state === 'next' ? colors.faint : st.state === 'now' ? colors.ivory : colors.soft }]}>{st.label}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.left}>{phase === 'reading' ? (left > 0 ? `About ${left} seconds left` : 'Still reading — a large page can take a minute or two') : 'You can tune up while you wait'}</Text>
          </>
        )}
      </View>
      {xml ? <ScoreView xml={xml} theme="paper" render={false} onEvent={onEngine} style={styles.hidden} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#F3EEE2', transform: [{ rotate: '-1.6deg' }], shadowColor: '#000', shadowOpacity: 0.65, shadowRadius: 26, shadowOffset: { width: 0, height: 26 }, elevation: 12, overflow: 'hidden' },
  scan: { position: 'absolute', left: 10, right: 10, height: 2, backgroundColor: colors.goldBright, shadowColor: colors.goldBright, shadowOpacity: 0.8, shadowRadius: 10 },
  step: { flexDirection: 'row', alignItems: 'baseline', gap: 14 },
  mark: { width: 14, fontFamily: fonts.sans, fontSize: 12 },
  stepText: { fontFamily: fonts.sansLight, fontSize: 14 },
  left: { fontFamily: fonts.display, fontSize: 14, color: colors.muted },
  hidden: { position: 'absolute', width: 600, height: 400, left: -10000, top: 0, opacity: 0 },
});
