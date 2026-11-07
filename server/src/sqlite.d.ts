declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export class StatementSync {
    run(...params: SqlValue[]): { lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
  }

  type SqlValue = string | number | bigint | null | Uint8Array;
}
