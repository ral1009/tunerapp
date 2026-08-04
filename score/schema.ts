export type SourceType = "musicxml" | "photo";

export interface ScoreNote {
  id: string;
  pitch: string;
  startBeat: number;
  durationBeats: number;
  fingering: number | null;
}

export interface ScoreMeasure {
  index: number;
  notes: ScoreNote[];
}

export interface ScoreAnnotation {
  id: string;
  kind: "text" | "markup";
  payload: Record<string, unknown>;
}

export interface PracticeHistoryEntry {
  id: string;
  startedAtIso: string;
  durationSeconds: number;
  summary: Record<string, unknown>;
}

export interface ScoreDocument {
  title: string;
  composer: string;
  tempoBpm: number;
  keySignature: string;
  timeSignature: string;
  sourceType: SourceType;
  measures: ScoreMeasure[];
  annotations: ScoreAnnotation[];
  practiceHistory: PracticeHistoryEntry[];
}