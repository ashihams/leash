export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
