export type MigrationErrorCode =
  | 'unknown-module-version'
  | 'duplicate-module-version'
  | 'no-default-version'
  | 'invalid-transition'
  | 'probe-failed';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}
