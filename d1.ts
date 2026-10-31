
// Cloudflare D1 implementation of the Database contract.

import type { Database, SqlStatement, SqlValue } from "../../lib/db.js";

export function createD1Database(d1: D1Database): Database {
  const prepare = (
    sql: string,
    params: readonly SqlValue[] = []
  ): D1PreparedStatement => d1.prepare(sql).bind(...params);

  return {
    first<T>(sql: string, params?: readonly SqlValue[]) {
      return prepare(sql, params).first<T>();
    },

    async all<T>(sql: string, params?: readonly SqlValue[]) {
      const result = await prepare(sql, params).all<T>();
      return result.results ?? [];
    },

    async run(sql: string, params?: readonly SqlValue[]) {
      await prepare(sql, params).run();
    },

    // D1's batch() runs all statements in a single transaction.
    async batch(statements: readonly SqlStatement[]) {
      if (statements.length === 0) return;

      await d1.batch(
        statements.map(statement =>
          prepare(statement.sql, statement.params)
        )
      );
    }
  };
}
