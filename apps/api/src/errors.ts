import { logServerError } from "./platform/logging";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
};

export function apiError(
	status: ContentfulStatusCode,
	code: string,
	message: string,
): HTTPException {
	return new HTTPException(status, {
		message,
		res: new Response(JSON.stringify({ error: code, message }, null, 2), {
			status,
			headers: JSON_HEADERS,
		}),
		cause: {
			code,
		},
	});
}

export function onError(error: unknown, c: Context): Response {
	if (error instanceof HTTPException) {
		return error.getResponse();
	}

	if (
		error &&
		typeof error === "object" &&
		"status" in error &&
		typeof error.status === "number" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		const message =
			"message" in error && typeof error.message === "string"
				? error.message
				: "request failed";
		return c.json(
			{
				error: error.code,
				message,
			},
			error.status as ContentfulStatusCode,
		);
	}

	logServerError("request", error, c.req.raw);
	return c.json(
		{
			error: "internal_error",
			message: "unexpected server error",
		},
		500,
	);
}
