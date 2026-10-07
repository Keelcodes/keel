/**
 * The caller invoked the CLI incorrectly — a missing or malformed option, or an
 * unknown command. Maps to exit code 2, which keeps "you used it wrong" distinct
 * from "the thing you asked about failed" (exit 1).
 */
export class UsageError extends Error {
  /** The process exit code this error maps to. */
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
