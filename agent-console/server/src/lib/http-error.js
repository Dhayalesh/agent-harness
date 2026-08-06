/** An error that carries the status code it should be reported with. */
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new HttpError(400, message, details);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);
export const badGateway = (message, details) =>
  new HttpError(502, message, details);

/** Wraps an async handler so a rejection reaches the error middleware. */
export const asyncHandler = (handler) => (request, response, next) =>
  Promise.resolve(handler(request, response, next)).catch(next);
