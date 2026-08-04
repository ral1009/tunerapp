export interface SqlStatement {
  sql: string;
  args?: Array<string | number | null>;
}

// This file defines the contract used by the app. The actual expo-sqlite implementation
// will be added when the React Native app shell is initialized.
export interface DatabaseAdapter {
  execute(statement: SqlStatement): Promise<void>;
  query<T>(statement: SqlStatement): Promise<T[]>;
}

export const createDatabaseAdapter = (): DatabaseAdapter => {
  throw new Error("Not implemented. Wire expo-sqlite in Phase 1/2 app shell.");
};