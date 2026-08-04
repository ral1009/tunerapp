export interface SpotPracticeRange {
  startMeasureIndex: number;
  endMeasureIndex: number;
}

export function normalizeSpotPracticeRange(range: SpotPracticeRange): SpotPracticeRange {
  if (range.startMeasureIndex <= range.endMeasureIndex) {
    return range;
  }

  return {
    startMeasureIndex: range.endMeasureIndex,
    endMeasureIndex: range.startMeasureIndex
  };
}