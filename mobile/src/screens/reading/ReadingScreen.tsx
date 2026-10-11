import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';

import { BackLink, Body, Display, Eyebrow, GoldButton, Progress, Screen, TextButton, useGutter, Wood } from '@/components/ui';
import { serverUrl } from '@/config/server';
import { useLibrary } from '@/data/libraryStore';
import { takePendingUpload, type PendingUpload, type UploadFile } from '@/data/pendingUpload';
import { ScoreView } from '@/score/ScoreView';
import type { LayoutMode } from '@/theme/settings';
import { colors, fonts } from '@/theme/tokens';

// Photo reading on the server takes ~25-30 s for a full page (CLAUDE.md, HOMR speed pass). The
// server says which page it's on; within a page the progress line is an estimate against this.
const SECONDS_PER_PAGE = 28;

type Phase = 'sending' | 'reading' | 'checking' | 'done' | 'error';

async function readMusicXml(upload: Extract<PendingUpload, { kind: 'musicxml' }>): Promise<string> {
  if (upload.file) return upload.file.text();
  const response = await fetch(upload.uri);
  return response.text();
}

// Phone photos are 12+ megapixels and may be HEIC; HOMR reads a 1300×1700 JPEG perfectly well.
// Shrinking to this long edge and re-encoding as JPEG makes each page a few hundred KB.
const MAX_PHOTO_EDGE = 2200;
// One request carries every page.
const UPLOAD_TIMEOUT_MS = 90000;
const POLL_MS = 1500;
const POLL_FAILURES_ALLOWED = 6;

async function preparePhoto(file: UploadFile, n: number): Promise<{ uri: string; name: string; type: string }> {
  try {
    const first = await ImageManipulator.manipulate(file.uri).renderAsync();
    const longEdge = Math.max(first.width, first.height);
    const image = longEdge > MAX_PHOTO_EDGE
      ? await ImageManipulator.manipulate(file.uri).resize(first.width >= first.height ? { width: MAX_PHOTO_EDGE } : { height: MAX_PHOTO_EDGE }).renderAsync()
      : first;
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    return { uri: saved.uri, name: `page-${n}.jpg`, type: 'image/jpeg' };
  } catch {
    // A format the phone can't decode itself (a RAW DNG on some Android phones): the server
    // converts it instead.
    return { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' };
  }
}

// One form field per file, in page order. React Native's FormData takes a { uri, name, type }
// descriptor for a local file; the web build has the browser's File.
async function buildForm(files: UploadFile[]): Promise<FormData> {
  const form = new FormData();
  for (const [i, f] of files.entries()) {
    if (f.file) form.append('file', f.file, f.name);
    else if (f.kind === 'pdf') {
      const name = f.name.toLowerCase().endsWith('.pdf') ? f.name : `${f.name}.pdf`;
      form.append('file', { uri: f.uri, name, type: 'application/pdf' } as unknown as Blob);
    } else form.append('file', (await preparePhoto(f, i + 1)) as unknown as Blob);
  }
  return form;
}

interface ReadProgress {
  page: number;
  pages: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Reading runs as a job on the server: upload every page, then ask how it's going until it's done.
// One long request used to carry the whole read, and a phone drops a request after about a minute
// -- a big photo can take HOMR longer than that -- losing the read with no explanation.
async function readPages(files: UploadFile[], isCancelled: () => boolean, onProgress: (p: ReadProgress) => void): Promise<string> {
  const form = await buildForm(files);
  const base = serverUrl();
  let jobId: string;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/parse-sheet/jobs`, { method: 'POST', body: form, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.jobId) throw new Error(body.error ?? `The server didn't accept the pages (${response.status}).`);
    jobId = body.jobId;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error(`Sending the pages to ${base} took too long. Is the laptop's Wi-Fi connection slow?`);
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
      if (body.pages) onProgress({ page: body.page, pages: body.pages });
      if (body.status === 'done' && body.xmlData) return body.xmlData as string;
      if (body.status === 'error' || !response.ok) throw new Error(body.error ?? 'The pages couldn’t be read.');
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      failures += 1;
      if (failures > POLL_FAILURES_ALLOWED) throw new Error(`Lost the connection to the server at ${base} while it was reading.`);
    }
  }
}

export function ReadingScreen({ layout }: { layout: LayoutMode }) {
  const tablet = layout === 'tablet';
  const g = useGutter(layout);
  const library = useLibrary();
  const [upload] = useState(() => takePendingUpload());
  const [phase, setPhase] = useState<Phase>(upload ? 'sending' : 'error');
  const [error, setError] = useState<string | null>(upload ? null : 'Nothing to read. Go back and add a page or a file.');
  const [xml, setXml] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  // When (in elapsed seconds) the server started the page it's on.
  const [pageStartedAt, setPageStartedAt] = useState(0);
  const addedRef = useRef(false);
  const isMusicXml = upload?.kind === 'musicxml';
  const fileCount = upload?.kind === 'pages' ? upload.files.length : 1;

  useEffect(() => {
    if (!upload) return;
    let cancelled = false;
    const started = Date.now();
    let lastPage = 0;
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 500);
    const onProgress = (p: ReadProgress) => {
      if (p.page !== lastPage) {
        lastPage = p.page;
        setPageStartedAt((Date.now() - started) / 1000);
      }
      setProgress(p);
    };
    (async () => {
      try {
        let text: string;
        if (upload.kind === 'musicxml') text = await readMusicXml(upload);
        else {
          setPhase('reading');
          text = await readPages(upload.files, () => cancelled, onProgress);
        }
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
    // A new score keeps the name the player gave it; a file keeps its own printed title.
    const printed = event.meta.title && event.meta.title !== 'Untitled' ? event.meta.title : null;
    const title = upload.kind === 'pages' ? upload.title : printed ?? (upload.name.replace(/\.[^.]+$/, '') || 'New piece');
    const id = library.add({
      title,
      composer: event.meta.composer,
      xml,
      source: upload.kind === 'pages' ? 'photo' : 'file',
      measureCount: event.meta.measureCount,
      measureIssues: event.meta.measureIssues,
    });
    setPhase('done');
    // Straight to the music.
    router.replace({ pathname: '/score/[id]', params: { id } });
  };

  // Pages as the server counts them (a PDF can hold several); until it answers, one per file.
  const pages = progress?.pages ?? fileCount;
  const page = progress?.page ?? 1;
  const withinPage = Math.min(0.95, Math.max(0, elapsed - pageStartedAt) / SECONDS_PER_PAGE);
  const fraction = phase === 'reading' ? Math.min(0.97, (page - 1 + withinPage) / pages) : phase === 'sending' ? 0.04 : phase === 'error' ? 0 : 1;
  const left = Math.max(0, Math.round((pages - page + 1 - withinPage) * SECONDS_PER_PAGE));
  const steps = [
    { label: isMusicXml ? 'Opened the file' : fileCount > 1 ? `Sent the ${fileCount} files` : 'Sent the page', state: phase === 'sending' ? 'now' : 'done' },
    { label: pages > 1 ? 'Reading the notes, page by page' : 'Reading the notes, staff by staff', state: phase === 'reading' ? 'now' : phase === 'sending' ? 'next' : 'done' },
    { label: pages > 1 ? 'Joining the pages, checking every bar' : 'Checking every bar adds up', state: phase === 'checking' ? 'now' : phase === 'done' ? 'done' : 'next' },
  ].filter((s) => !isMusicXml || !s.label.startsWith('Reading the notes'));

  const staffWords = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const staff = Math.min(7, Math.floor((pages > 1 ? withinPage : fraction) * 8));
  const headline =
    phase === 'reading'
      ? pages > 1
        ? `Page ${page} of ${pages}`
        : `Staff ${staffWords[staff]} of eight`
      : phase === 'checking'
        ? 'Checking every bar'
        : phase === 'done'
          ? 'Done'
          : 'Opening';
  const timeLeft = left >= 90 ? `About ${Math.round(left / 60)} minutes left` : left > 0 ? `About ${left} seconds left` : 'Still reading — a large page can take a minute or two';
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
          {phase !== 'error' && phase !== 'done' ? <View style={[styles.scan, { top: `${14 + (pages > 1 ? withinPage : fraction) * 80}%` }]} /> : null}
          {pages > 1 ? <Text style={styles.pageNo}>{page}</Text> : null}
        </View>
      </View>

      <View style={{ paddingHorizontal: g, marginTop: 'auto', paddingBottom: 30, gap: 18, maxWidth: 640 }}>
        {phase === 'error' ? (
          <>
            <Display size={tablet ? 40 : 30}>That didn&rsquo;t work</Display>
            <Body>{error}</Body>
            <View style={{ flexDirection: 'row', gap: 28, alignItems: 'center' }}>
              <TextButton label="Back" onPress={() => router.back()} />
              <GoldButton label="Start again" onPress={() => router.replace(isMusicXml ? '/add-music' : '/new-score')} />
            </View>
          </>
        ) : (
          <>
            <View style={{ gap: 8 }}>
              <Eyebrow>{isMusicXml ? 'Opening your file' : upload?.kind === 'pages' ? `Reading ${upload.title}` : 'Reading'}</Eyebrow>
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
            <Text style={styles.left}>{phase === 'reading' ? timeLeft : 'You can tune up while you wait'}</Text>
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
  pageNo: { position: 'absolute', bottom: 10, alignSelf: 'center', fontFamily: fonts.display, fontSize: 14, color: 'rgba(20,17,14,0.6)' },
  step: { flexDirection: 'row', alignItems: 'baseline', gap: 14 },
  mark: { width: 14, fontFamily: fonts.sans, fontSize: 12 },
  stepText: { fontFamily: fonts.sansLight, fontSize: 14 },
  left: { fontFamily: fonts.display, fontSize: 14, color: colors.muted },
  hidden: { position: 'absolute', width: 600, height: 400, left: -10000, top: 0, opacity: 0 },
});
