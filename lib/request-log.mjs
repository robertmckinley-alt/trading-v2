export function createRequestLog(request, route) {
  const startedAt = Date.now();
  const requestId = request.headers.get('x-vercel-id') || request.headers.get('x-request-id') || null;
  console.log(JSON.stringify({ level: 'info', message: 'Request started', route, requestId }));

  return {
    done(status, details = {}) {
      console.log(JSON.stringify({
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        message: 'Request completed',
        route,
        requestId,
        status,
        durationMs: Date.now() - startedAt,
        ...details
      }));
    },
    failed(error, status = 500) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Request failed',
        route,
        requestId,
        status,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };
}
