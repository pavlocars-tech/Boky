export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = "Nicht angemeldet.") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "Keine Berechtigung.") => new AppError(403, "forbidden", message);
export const notFound = (message = "Nicht gefunden.") => new AppError(404, "not_found", message);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
