/** Ledger errors carry a code and ids only — never amounts, names or comments. */
export class LedgerError extends Error {
  readonly code: string;
  readonly context: Readonly<Record<string, string | number | null>>;
  constructor(code: string, context: Record<string, string | number | null> = {}) {
    super(code);
    this.name = "LedgerError";
    this.code = code;
    this.context = context;
  }
}
