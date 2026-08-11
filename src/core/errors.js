export class AxiError extends Error {
  constructor(code, message, { exitCode = 1, retryable = false, details = {} } = {}) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
    this.details = details;
  }
}

export function invalid(code, message, details = {}) {
  return new AxiError(code, message, { exitCode: 2, details });
}
