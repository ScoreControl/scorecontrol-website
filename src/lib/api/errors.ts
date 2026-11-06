import "server-only";
import { API_ERRORS, type ApiErrorCode, type StaleParentDetails } from "./contract";
import { AuthHttpError } from "@/lib/auth/errors";

/**
 * Project API errors. They are AuthHttpErrors so the existing errorResponse() formats them;
 * the HTTP status always comes from the contract's API_ERRORS table.
 */
export function apiError(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
  return new AuthHttpError(API_ERRORS[code], code, message, undefined, undefined, details);
}

export const tokenExpired = () => apiError("TOKEN_EXPIRED", "Your session has expired. Refresh your token.");
/** Also used for non-members, so the API never confirms that a private project exists. */
export const notFound = (what = "Project") => apiError("NOT_FOUND", `${what} not found.`);
export const forbidden = (message = "Your role on this project doesn't allow this.") => apiError("FORBIDDEN", message);
export const staleParent = (details: StaleParentDetails) =>
  apiError("STALE_PARENT", `Branch ${details.branch} has moved.`, details);
