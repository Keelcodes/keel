/** Raised when a PIM cannot be built from the provided inputs (e.g. a bad address). */
export class PimBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PimBuildError';
  }
}
