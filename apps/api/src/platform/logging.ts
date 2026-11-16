export function logServerError(source: string, error: unknown, request?: Request): void {
	console.error("[api] internal server error", {
		source,
		request: request ? formatRequestForLog(request) : undefined,
		error: formatErrorForLog(error),
	});
}

function formatRequestForLog(request: Request): { method: string; path: string } {
	const url = new URL(request.url);

	return {
		method: request.method,
		path: url.pathname,
	};
}

function formatErrorForLog(error: unknown): unknown {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			cause: formatErrorCauseForLog(error.cause),
		};
	}

	return error;
}

function formatErrorCauseForLog(cause: unknown): unknown {
	if (cause instanceof Error) {
		return {
			name: cause.name,
			message: cause.message,
			stack: cause.stack,
		};
	}

	return cause;
}
