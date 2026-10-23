export type ErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }

  toJSON(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export function toErrorBody(err: unknown): ErrorBody {
  if (err instanceof AppError) return err.toJSON();
  if (err instanceof Error) {
    return { error: { code: "INTERNAL_ERROR", message: err.message } };
  }
  return { error: { code: "INTERNAL_ERROR", message: "Unknown error" } };
}
