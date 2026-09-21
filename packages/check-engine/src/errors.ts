export class InvalidHttpMethodError extends Error {
  constructor(method: unknown) {
    super(`Unsupported HTTP method: ${String(method)}`);
    this.name = 'InvalidHttpMethodError';
  }
}
