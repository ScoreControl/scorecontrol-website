import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getAppOrigin } from "./config";
import { AuthHttpError } from "./errors";

export const MAX_BODY_BYTES = 8192;
const tooLarge = () => new AuthHttpError(413, "REQUEST_TOO_LARGE", "The request body is too large.");

export function noStore<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

export function authJson(data: unknown, status = 200) {
  return noStore(NextResponse.json({ data }, { status }));
}

/** Log server-side failures with a correlation ID. Returns the ID, or undefined for client errors. */
export function logAuthFailure(error: unknown): string | undefined {
  const known = error instanceof AuthHttpError;
  if (known && error.status < 500) return undefined;
  const requestId = randomUUID();
  // Do not log raw exceptions: provider errors can contain credentials or request URLs.
  console.error(JSON.stringify({ event: "auth_request_failed", requestId, code: known ? error.code : "INTERNAL_ERROR" }));
  return requestId;
}

export function errorResponse(error: unknown): NextResponse {
  const known = error instanceof AuthHttpError;
  const status = known ? error.status : 500;
  const requestId = logAuthFailure(error);
  const response = noStore(NextResponse.json({ error: {
    code: known ? error.code : "INTERNAL_ERROR",
    message: known ? error.message : "The request could not be completed.",
    ...(known && error.fields ? { fields: error.fields } : {}),
    ...(requestId ? { requestId } : {}),
  } }, { status }));
  if (known && error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
  return response;
}

export function assertMutationOrigin(request: Request) {
  if (request.headers.get("origin") !== getAppOrigin() || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AuthHttpError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed.");
  }
}

export async function readJson(request: Request): Promise<unknown> {
  assertMutationOrigin(request);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new AuthHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send an application/json request.");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new AuthHttpError(400, "INVALID_REQUEST", "Send a JSON request body.");
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    throw new AuthHttpError(400, "INVALID_REQUEST", "Send a valid JSON request body.");
  } finally {
    reader.releaseLock();
  }
}
