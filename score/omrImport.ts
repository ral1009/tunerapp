import type { ScoreDocument } from "./schema";

export interface OmrImportResult {
  score: ScoreDocument;
  transientBoundingBoxes: Array<{ noteId: string; x: number; y: number; width: number; height: number }>;
}

export async function importPhotoToScore(_imageBytes: Uint8Array): Promise<OmrImportResult> {
  throw new Error("Not implemented. Benchmark VLM/OMR models before building this pipeline.");
}