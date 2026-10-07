/** Raised when an authored policy is malformed. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/** Raised when a session lifecycle operation is invalid (unknown / duplicate / already revoked). */
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Raised when an ERC-8312 envelope lifecycle or attenuation operation is invalid. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}
