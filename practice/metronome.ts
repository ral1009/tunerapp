export interface MetronomeConfig {
  tempoBpm: number;
  beatsPerMeasure: number;
}

export function msPerBeat(config: MetronomeConfig): number {
  return 60_000 / config.tempoBpm;
}