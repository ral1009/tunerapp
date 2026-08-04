export interface CursorState {
  noteIndex: number;
  measureIndex: number;
}

export function advanceCursor(state: CursorState): CursorState {
  return {
    ...state,
    noteIndex: state.noteIndex + 1
  };
}