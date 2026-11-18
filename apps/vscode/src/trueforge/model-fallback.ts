/**
 * Model fallback — pure core (no `vscode` imports, so it unit-tests in plain Node).
 *
 * Task C requires that an unreachable endpoint or invalid key does not hang the
 * editor or leave files changed. The strongest anchor is automatic failover to a
 * second configured model with no user action. TrueForge owns the loop, so failover
 * is expressed as: the turn fails, we retry the same prompt on the next model in the
 * chain, and only surface an error when every model has failed.
 *
 * The chain comes from the agent definition (`model.name` plus `model.fallbacks`),
 * so a user switches models by editing one file — no rebuild, no provider code here.
 */

export interface ModelChain {
	/** Primary model name, as configured in TrueForge. */
	primary: string
	/** Ordered fallbacks, tried after the primary fails. */
	fallbacks: string[]
}

/** Errors that mean "this model/endpoint is unusable" rather than "the task failed". */
const TRANSPORT_ERROR_PATTERNS = [
	/cannot connect to api/i,
	/bad port/i,
	/econnrefused/i,
	/enotfound/i,
	/etimedout/i,
	/body timeout/i,
	/request failed/i,
	/connection (refused|reset|error)/i,
	/fetch failed/i,
	/socket hang up/i,
	/network error/i,
	/invalid api key/i,
	/unauthorized/i,
	/\b401\b/,
	/\b403\b/,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
	/rate.?limit/i,
	/\b429\b/,
	/model not found/i,
	/no such model/i,
	/provider.*not.*(found|configured)/i,
]

/**
 * True when the failure is about reaching or authenticating to the model, which is
 * exactly the condition a second configured model can rescue. A failure like
 * "tool returned an error" is the task's problem, not the model's, so it must not
 * trigger failover.
 */
export function isModelUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "")
	if (!message) {
		return false
	}
	return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/** Build the ordered model chain from an agent spec's `model` block. */
export function modelChainFromSpec(model: { name?: unknown; fallbacks?: unknown } | undefined): ModelChain {
	const primary = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : ""
	const raw = Array.isArray(model?.fallbacks) ? model.fallbacks : []
	const fallbacks = raw
		.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== primary)
	return { primary, fallbacks }
}

/** Every model to try, in order, primary first. */
export function attemptOrder(chain: ModelChain): string[] {
	return [chain.primary, ...chain.fallbacks].filter((name) => name.length > 0)
}

export interface FallbackDecision {
	/** Model to try next, or undefined when the chain is exhausted. */
	next?: string
	/** Index of `next` in the attempt order. */
	nextIndex?: number
	/** True when this failure is a model-availability problem worth failing over for. */
	shouldFailover: boolean
	/** Human-readable note for the chat transcript. */
	note: string
}

/**
 * Decide what to do after `failedModel` failed. `attempted` is how many models have
 * already been tried (1 after the primary fails). Failover only happens for
 * availability errors and only while models remain.
 */
export function decideFallback(chain: ModelChain, failedModel: string, error: unknown, attempted: number): FallbackDecision {
	const order = attemptOrder(chain)
	const unavailable = isModelUnavailableError(error)
	const message = error instanceof Error ? error.message : String(error ?? "unknown error")
	if (!unavailable) {
		return {
			shouldFailover: false,
			note: `${failedModel} failed with a non-transport error; not failing over: ${message}`,
		}
	}
	const nextIndex = Math.max(attempted, order.indexOf(failedModel) + 1)
	const next = order[nextIndex]
	if (!next) {
		return {
			shouldFailover: false,
			note: `${failedModel} is unavailable and no fallback model remains: ${message}`,
		}
	}
	return {
		next,
		nextIndex,
		shouldFailover: true,
		note: `${failedModel} unavailable (${message}); failing over to ${next}`,
	}
}

/** The user-facing message once every model has failed. */
export function exhaustedMessage(chain: ModelChain, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "unknown error")
	const tried = attemptOrder(chain)
	if (tried.length <= 1) {
		return `[Model Error] ${message}`
	}
	return `[Model Error] ${message} — all ${tried.length} configured models failed (${tried.join(", ")}).`
}

/** Backoff schedule for retrying the same model before giving up on it. */
export function retryDelayMs(attempt: number): number {
	const base = 400
	const capped = Math.min(attempt, 4)
	return base * 2 ** (capped - 1)
}

/**
 * Whether a failure deserves another try against the *same* model before failing over.
 * Only transient conditions qualify: a refused connection or a 5xx is often a blip,
 * while a bad port or an invalid key will fail identically on every attempt.
 */
export function isRetryableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "")
	if (!message) {
		return false
	}
	if (/bad port|invalid api key|unauthorized|\b401\b|\b403\b|model not found|no such model/i.test(message)) {
		return false
	}
	return /econnreset|etimedout|body timeout|socket hang up|network error|fetch failed|connection reset|\b502\b|\b503\b|\b504\b|rate.?limit|\b429\b/i.test(
		message,
	)
}

export interface RetryDecision {
	shouldRetry: boolean
	/** Milliseconds to wait before retrying. */
	delayMs: number
	/** Human-readable note for the transcript. */
	note: string
}

/**
 * Decide whether to retry the current model with backoff. `attempt` counts attempts
 * against this model (1 after its first failure). Bounded so a dead endpoint cannot
 * keep the editor waiting: at most `maxRetries` extra tries per model.
 */
export function decideRetry(model: string, error: unknown, attempt: number, maxRetries = 2): RetryDecision {
	if (attempt > maxRetries) {
		return { shouldRetry: false, delayMs: 0, note: `${model} failed ${attempt} times; no retries left` }
	}
	if (!isRetryableError(error)) {
		return { shouldRetry: false, delayMs: 0, note: `${model} failed with a non-transient error; not retrying` }
	}
	const delayMs = retryDelayMs(attempt)
	return {
		shouldRetry: true,
		delayMs,
		note: `${model} failed transiently (attempt ${attempt}/${maxRetries}); retrying in ${delayMs}ms`,
	}
}

/** Await a delay. Separate so tests can stub it without real time passing. */
export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
