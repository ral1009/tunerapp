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
  // Present only when the time/key signature or tempo changes at this measure (or it's the first measure).
  timeSignature?: string;
  keySignature?: string;
  // null means no tempo was ever specified in the source, as opposed to a real authored value.
  tempoBpm?: number | null;
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
  // null means no tempo was ever specified in the source, as opposed to a real authored value.
  tempoBpm: number | null;
  keySignature: string;
  timeSignature: string;
  sourceType: SourceType;
  measures: ScoreMeasure[];
  annotations: ScoreAnnotation[];
  practiceHistory: PracticeHistoryEntry[];
}