declare const __DEV__: boolean | undefined;

type ScenarioName =
  | 'cold_start'
  | 'tab_change'
  | 'card_touch'
  | 'recording_start'
  | 'recording_cancel'
  | 'recording_save';

type RequestSummary = {
  method: string;
  path: string;
  status: number | 'error';
  durationMs: number;
};

type TaskSummary = {
  name: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
};

type ScenarioState = {
  name: ScenarioName;
  startedAt: number;
  requestCount: number;
  requests: RequestSummary[];
  tasks: TaskSummary[];
  metadata?: Record<string, unknown>;
};

const isDevRuntime = typeof __DEV__ === 'boolean' ? __DEV__ : process.env.NODE_ENV !== 'production';
let activeScenario: ScenarioState | null = null;
let totalSupabaseRequests = 0;

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function safePath(input: unknown) {
  const rawUrl = typeof input === 'string'
    ? input
    : input && typeof input === 'object' && 'url' in input
      ? String((input as { url?: unknown }).url ?? '')
      : String(input ?? '');

  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl.slice(0, 120);
  }
}

function log(message: string, details?: Record<string, unknown>) {
  if (!isDevRuntime) return;
  if (details) {
    console.log(`[ISB QA] ${message}`, details);
  } else {
    console.log(`[ISB QA] ${message}`);
  }
}

export function devMarkScenario(name: ScenarioName, metadata?: Record<string, unknown>) {
  if (!isDevRuntime) return;
  if (activeScenario && activeScenario.name !== name) {
    devEndScenario(activeScenario.name, { interruptedBy: name });
  }
  activeScenario = {
    name,
    startedAt: now(),
    requestCount: 0,
    requests: [],
    tasks: [],
    metadata,
  };
  log(`scenario:start:${name}`, metadata);
}

export function devEndScenario(name: ScenarioName, metadata?: Record<string, unknown>) {
  if (!isDevRuntime || !activeScenario || activeScenario.name !== name) return;
  const scenario = activeScenario;
  activeScenario = null;
  const durationMs = Math.round(now() - scenario.startedAt);
  log(`scenario:end:${name}`, {
    durationMs,
    requestCount: scenario.requestCount,
    requests: scenario.requests,
    taskCount: scenario.tasks.length,
    tasks: scenario.tasks,
    ...scenario.metadata,
    ...metadata,
  });
}

export function devTrackEvent(eventName: string, metadata?: Record<string, unknown>) {
  log(`event:${eventName}`, { scenario: activeScenario?.name ?? 'none', ...metadata });
}

function trackTask(summary: TaskSummary) {
  if (activeScenario) activeScenario.tasks.push(summary);
  log('js:task', { ...summary, scenario: activeScenario?.name ?? 'none' });
}

export function devMeasureSync<T>(name: string, task: () => T, metadata?: Record<string, unknown>): T {
  if (!isDevRuntime) return task();
  const startedAt = now();
  try {
    return task();
  } finally {
    trackTask({ name, durationMs: Math.round(now() - startedAt), metadata });
  }
}

export async function devMeasureAsync<T>(name: string, task: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T> {
  if (!isDevRuntime) return task();
  const startedAt = now();
  try {
    return await task();
  } finally {
    trackTask({ name, durationMs: Math.round(now() - startedAt), metadata });
  }
}

export async function instrumentedSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchImpl = globalThis.fetch;
  if (!isDevRuntime || typeof fetchImpl !== 'function') {
    return fetchImpl(input, init);
  }

  const startedAt = now();
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const path = safePath(input);

  try {
    const response = await fetchImpl(input, init);
    const durationMs = Math.round(now() - startedAt);
    const summary: RequestSummary = { method, path, status: response.status, durationMs };
    totalSupabaseRequests += 1;
    if (activeScenario) {
      activeScenario.requestCount += 1;
      activeScenario.requests.push(summary);
    }
    log('supabase:request', {
      ...summary,
      scenario: activeScenario?.name ?? 'none',
      totalSupabaseRequests,
    });
    return response;
  } catch (error) {
    const durationMs = Math.round(now() - startedAt);
    const summary: RequestSummary = { method, path, status: 'error', durationMs };
    totalSupabaseRequests += 1;
    if (activeScenario) {
      activeScenario.requestCount += 1;
      activeScenario.requests.push(summary);
    }
    log('supabase:request:error', {
      ...summary,
      scenario: activeScenario?.name ?? 'none',
      totalSupabaseRequests,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
