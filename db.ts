
// Database contract.
//
// The application talks to its database only through this interface.
// It knows nothing about D1, Postgres, SQLite files, or any driver.
//
// SQL dialect: statements are written in SQLite-flavoured SQL with `?`
// positional placeholders (including `ON CONFLICT ... DO UPDATE`).
// An adapter for another engine may need to translate placeholders
// (for example `?` -> `$1`), but the application SQL does not change.

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: readonly SqlValue[];
}

export interface Database {
  /** Returns the first matching row, or null when there is none. */
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;

  /** Returns every matching row (an empty array when there are none). */
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;

  /** Executes a statement and discards the result. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;

  /**
   * Executes the statements in order as a single atomic unit:
   * either all of them are applied or none are.
   */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}
