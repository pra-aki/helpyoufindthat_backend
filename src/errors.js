export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export class PerplexityError extends HttpError {
  constructor(message, { status = 502, details, cause } = {}) {
    super(status, message, details);
    this.name = 'PerplexityError';
    if (cause) this.cause = cause;
  }
}
