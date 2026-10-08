import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EngineEvent } from '@core/score/engine/protocol';

import { Body, Display, Eyebrow, GoldButton, Screen, Serif, TextButton, useGutter } from '@/components/ui';
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

async function readPhoto(upload: PendingUpload): Promise<string> {
  const form = new FormData();
  if (upload.file) form.append('file', upload.file, upload.name);
  // React Native's FormData takes a { uri, name, type } descriptor for a local file.
  else form.append('file', { uri: upload.uri, name: upload.name, type: upload.mimeType } as unknown as Blob);
  let response: Response;
  try {
    response = await fetch(`${serverUrl()}/api/parse-sheet`, { method: 'POST', body: form });
  } catch {
    throw new Error(`Couldn't reach the music reader at ${serverUrl()}. Is the server running and on the same Wi-Fi?`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.xmlData) throw new Error(body.error ?? `The music reader returned an error (${response.status}).`);
  return body.xmlData as string;
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
        const text = upload.kind === 'musicxml' ? await readMusicXml(upload) : (setPhase('reading'), await readPhoto(upload));
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
    { label: 'Reading the notes', state: phase === 'reading' ? 'now' : phase === 'sending' ? 'next' : 'done' },
    { label: 'Checking every bar adds up', state: phase === 'checking' ? 'now' : phase === 'done' ? 'done' : 'next' },
  ].filter((s) => upload?.kind !== 'musicxml' || s.label !== 'Reading the notes');

  return (
    <Screen layout={layout}>
      <View style={{ flex: 1, paddingHorizontal: g, paddingTop: tablet ? 48 : 28, alignItems: 'center' }}>
        <Eyebrow style={{ alignSelf: 'flex-start' }}>Reading your music</Eyebrow>
        <View style={[styles.page, tablet ? { width: 260, height: 350 } : { width: 200, height: 270 }]}>
          <View style={styles.pageRule} />
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <View key={i} style={{ gap: 2.6, marginHorizontal: 20, marginTop: i === 0 ? 30 : 14, opacity: i / 8 < fraction ? 0.85 : 0.22 }}>
              {[0, 1, 2, 3, 4].map((k) => (
                <View key={k} style={{ height: 1, backgroundColor: '#14110E' }} />
              ))}
            </View>
          ))}
          {phase !== 'error' && phase !== 'done' ? <View style={[styles.scan, { top: `${8 + fraction * 84}%` }]} /> : null}
        </View>

        <View style={{ alignItems: 'center', gap: 8, marginTop: 28, maxWidth: 520 }}>
          {phase === 'error' ? (
            <>
              <Display size={tablet ? 36 : 28} style={{ textAlign: 'center' }}>That didn&rsquo;t work</Display>
              <Body style={{ textAlign: 'center' }}>{error}</Body>
              <View style={{ flexDirection: 'row', gap: 28, marginTop: 12, alignItems: 'center' }}>
                <TextButton label="← Back" onPress={() => router.back()} />
                <GoldButton label="Try another page" onPress={() => router.replace('/add-music')} />
              </View>
            </>
          ) : (
            <>
              <Display size={tablet ? 36 : 28} style={{ textAlign: 'center' }}>
                {phase === 'reading' ? 'Reading the notes' : phase === 'checking' ? 'Almost done' : 'Opening'}
              </Display>
              <Text style={styles.sub}>{phase === 'reading' ? (left > 0 ? `About ${left} seconds left` : 'Nearly there…') : ' '}</Text>
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${fraction * 100}%` }]} />
              </View>
            </>
          )}
        </View>

        {phase !== 'error' ? (
          <View style={{ alignSelf: 'stretch', marginTop: 32, maxWidth: 560, width: '100%', marginHorizontal: 'auto' }}>
            {steps.map((s) => (
              <View key={s.label} style={styles.step}>
                <Serif size={16} style={{ color: s.state === 'next' ? colors.muted : s.state === 'now' ? colors.ivory : colors.cream }}>{s.label}</Serif>
                <Text style={[styles.state, { color: s.state === 'done' ? colors.good : s.state === 'now' ? colors.goldBright : colors.faint }]}>{s.state}</Text>
              </View>
            ))}
            <Text style={[styles.sub, { textAlign: 'center', marginTop: 24, fontFamily: fonts.display }]}>You can tune up while you wait</Text>
          </View>
        ) : null}
      </View>
      {xml ? <ScoreView xml={xml} theme="paper" render={false} onEvent={onEngine} style={styles.hidden} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { marginTop: 28, backgroundColor: colors.paper, shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 20, shadowOffset: { width: 0, height: 16 }, elevation: 10, overflow: 'hidden' },
  pageRule: { position: 'absolute', left: 10, right: 10, top: 10, bottom: 10, borderWidth: 1, borderColor: 'rgba(166,124,58,0.5)' },
  scan: { position: 'absolute', left: 14, right: 14, height: 1, backgroundColor: '#B07F2E', shadowColor: '#B07F2E', shadowOpacity: 0.8, shadowRadius: 8 },
  sub: { fontFamily: fonts.sans, fontSize: 13, color: colors.soft },
  bar: { width: 240, height: 1, backgroundColor: 'rgba(201,164,106,0.25)', marginTop: 10 },
  barFill: { height: 1, backgroundColor: colors.gold },
  step: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.ruleSoft },
  state: { fontFamily: fonts.sans, fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' },
  hidden: { position: 'absolute', width: 600, height: 400, left: -10000, top: 0, opacity: 0 },
});
