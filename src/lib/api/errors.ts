import "server-only";
import { AuthHttpError } from "@/lib/auth/errors";

/** API errors share the auth error type so errorResponse renders them the same way. */
export { AuthHttpError as HttpError };

export const notFound = (code = "NOT_FOUND", message = "Not found.") => new AuthHttpError(404, code, message);
export const forbidden = (code = "FORBIDDEN", message = "You don't have permission to do that.") => new AuthHttpError(403, code, message);
export const conflict = (code: string, message: string) => new AuthHttpError(409, code, message);
