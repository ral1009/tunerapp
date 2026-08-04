import type { ScoreDocument } from "../schema";

export interface RenderedScoreHandle {
  unmount(): void;
}

export function renderScore(_score: ScoreDocument): RenderedScoreHandle {
  throw new Error("Not implemented. Wire OSMD or VexFlow in Phase 1.");
}