export interface StreakState {
  currentDays: number;
  longestDays: number;
}

export function updateStreak(state: StreakState, practicedToday: boolean): StreakState {
  if (!practicedToday) {
    return { ...state, currentDays: 0 };
  }

  const currentDays = state.currentDays + 1;
  return {
    currentDays,
    longestDays: Math.max(state.longestDays, currentDays)
  };
}