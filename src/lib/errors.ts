/**
 * The error vocabulary the frontend switches on.
 *
 * `src/api/client.ts` in the app maps HTTP status to these codes and back, so
 * the set here must stay identical to the table in
 * backend-guide/CONVENTIONS.md §3. Adding a code the client does not know
 * degrades to SERVER_ERROR on its side, which loses the specific message.
 */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'INVALID_CREDENTIALS'
  | 'TWO_FACTOR_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'EMAIL_TAKEN'
  | 'USERNAME_TAKEN'
  | 'OUT_OF_STOCK'
  | 'PAYMENT_FAILED'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR';

const STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  TWO_FACTOR_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  USERNAME_TAKEN: 409,
  OUT_OF_STOCK: 409,
  PAYMENT_FAILED: 402,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Per-field messages; only meaningful for VALIDATION_ERROR. */
  readonly fields?: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.fields = fields;
  }
}

/* Shorthands. These are thrown often enough that the constructor call is noise. */

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new ApiError('VALIDATION_ERROR', message, fields);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError('UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError('FORBIDDEN', message);

export const notFound = (what = 'Resource') => new ApiError('NOT_FOUND', `${what} not found`);

export const conflict = (message: string) => new ApiError('CONFLICT', message);

export const outOfStock = (message = 'Not enough stock available') =>
  new ApiError('OUT_OF_STOCK', message);
