// Shared, dependency-free test harness for the W10 observability suite.
// Not collected by `npm run test:unit` (filename does not end in `.test.mjs`).

export const OBS_MODULE_BASE = new URL('../../../../scripts/agentic/observability/', import.meta.url);
export const CONTRACTS_DIR = new URL('../../../../contracts/agentic/', import.meta.url);

export function loadModule(name) {
  return import(new URL(name, OBS_MODULE_BASE).href);
}

/** Minimal Node http.ServerResponse double. */
export function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers ?? {};
    },
    end(body) {
      this.body = body ?? '';
      this.ended = true;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

export function createRequest({ method = 'GET', url = '/', headers = {} } = {}) {
  return { method, url, headers };
}

export function span({
  id,
  name = 'worker',
  kind = 'invoke_agent',
  status = 'ok',
  startedAt = '2026-10-27T10:00:00.000Z',
  endedAt = '2026-10-27T10:00:02.000Z',
  parentId,
  attributes,
  inputRef,
  outputRef,
  error,
} = {}) {
  const value = { id, name, kind, startedAt, status };
  if (endedAt !== undefined) value.endedAt = endedAt;
  if (parentId !== undefined) value.parentId = parentId;
  if (attributes !== undefined) value.attributes = attributes;
  if (inputRef !== undefined) value.inputRef = inputRef;
  if (outputRef !== undefined) value.outputRef = outputRef;
  if (error !== undefined) value.error = error;
  return value;
}
