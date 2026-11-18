import { describe, expect, it } from "vitest"
import {
	attemptOrder,
	decideFallback,
	decideRetry,
	exhaustedMessage,
	isModelUnavailableError,
	isRetryableError,
	type ModelChain,
	modelChainFromSpec,
	retryDelayMs,
} from "./model-fallback"

const CHAIN: ModelChain = {
	primary: "opencode-free-models/deepseek-v41-flash-free",
	fallbacks: ["opencode-free-models/jev-113-free"],
}

describe("isModelUnavailableError", () => {
	it("recognises the Task C failure the harness actually produced", () => {
		expect(isModelUnavailableError(new Error("Cannot connect to API: bad port"))).toBe(true)
	})

	it("recognises transport and auth failures", () => {
		for (const message of [
			"fetch failed",
			"connect ECONNREFUSED 127.0.0.1:9",
			"getaddrinfo ENOTFOUND api.example.com",
			"Request failed with status 401",
			"Invalid API key",
			"429 rate limit exceeded",
			"model not found: foo/bar",
		]) {
			expect(isModelUnavailableError(new Error(message)), message).toBe(true)
		}
	})

	it("does not treat a task-level failure as a model outage", () => {
		expect(isModelUnavailableError(new Error("editor_propose_edit returned a stale-base rejection"))).toBe(false)
		expect(isModelUnavailableError(new Error("iteration limit reached"))).toBe(false)
		expect(isModelUnavailableError(undefined)).toBe(false)
	})
})

describe("modelChainFromSpec", () => {
	it("reads primary and fallbacks", () => {
		expect(modelChainFromSpec({ name: "a", fallbacks: ["b", "c"] })).toEqual({ primary: "a", fallbacks: ["b", "c"] })
	})

	it("drops blanks, non-strings and duplicates of the primary", () => {
		expect(modelChainFromSpec({ name: "a", fallbacks: ["a", "", "  ", 42, "b"] })).toEqual({
			primary: "a",
			fallbacks: ["b"],
		})
	})

	it("survives a missing model block", () => {
		expect(modelChainFromSpec(undefined)).toEqual({ primary: "", fallbacks: [] })
	})
})

describe("attemptOrder", () => {
	it("puts the primary first", () => {
		expect(attemptOrder(CHAIN)).toEqual(["opencode-free-models/deepseek-v41-flash-free", "opencode-free-models/jev-113-free"])
	})
})

describe("decideFallback", () => {
	it("fails over to the second model on a transport error", () => {
		const decision = decideFallback(CHAIN, CHAIN.primary, new Error("Cannot connect to API: bad port"), 1)
		expect(decision.shouldFailover).toBe(true)
		expect(decision.next).toBe("opencode-free-models/jev-113-free")
		expect(decision.note).toContain("failing over")
	})

	it("stops when the chain is exhausted", () => {
		const decision = decideFallback(CHAIN, "opencode-free-models/jev-113-free", new Error("fetch failed"), 2)
		expect(decision.shouldFailover).toBe(false)
		expect(decision.next).toBeUndefined()
		expect(decision.note).toContain("no fallback model remains")
	})

	it("does not fail over on a non-transport error", () => {
		const decision = decideFallback(CHAIN, CHAIN.primary, new Error("tool call rejected"), 1)
		expect(decision.shouldFailover).toBe(false)
		expect(decision.note).toContain("non-transport")
	})

	it("has nowhere to go when no fallback is configured", () => {
		const decision = decideFallback({ primary: "only", fallbacks: [] }, "only", new Error("fetch failed"), 1)
		expect(decision.shouldFailover).toBe(false)
	})
})

describe("exhaustedMessage", () => {
	it("names every model that was tried", () => {
		const message = exhaustedMessage(CHAIN, new Error("fetch failed"))
		expect(message).toContain("[Model Error]")
		expect(message).toContain("all 2 configured models failed")
		expect(message).toContain("jev-113-free")
	})

	it("stays plain with a single model", () => {
		expect(exhaustedMessage({ primary: "only", fallbacks: [] }, new Error("boom"))).toBe("[Model Error] boom")
	})
})

describe("retryDelayMs", () => {
	it("backs off exponentially and caps out", () => {
		expect(retryDelayMs(1)).toBe(400)
		expect(retryDelayMs(2)).toBe(800)
		expect(retryDelayMs(3)).toBe(1600)
		expect(retryDelayMs(4)).toBe(3200)
		expect(retryDelayMs(9)).toBe(3200)
	})
})

describe("isRetryableError", () => {
	it("retries transient transport failures", () => {
		expect(isRetryableError(new Error("socket hang up"))).toBe(true)
		expect(isRetryableError(new Error("fetch failed"))).toBe(true)
		expect(isRetryableError(new Error("HTTP 503 Service Unavailable"))).toBe(true)
		expect(isRetryableError(new Error("rate limit exceeded (429)"))).toBe(true)
	})

	it("does not retry a bad port or a rejected key", () => {
		expect(isRetryableError(new Error("Cannot connect to API: bad port"))).toBe(false)
		expect(isRetryableError(new Error("invalid api key"))).toBe(false)
		expect(isRetryableError(new Error("401 Unauthorized"))).toBe(false)
	})

	it("does not retry an unknown model", () => {
		expect(isRetryableError(new Error("model not found"))).toBe(false)
	})
})

describe("decideRetry", () => {
	it("retries a transient error while attempts remain", () => {
		const decision = decideRetry("m1", new Error("socket hang up"), 1)
		expect(decision.shouldRetry).toBe(true)
		expect(decision.delayMs).toBe(400)
		expect(decision.note).toContain("attempt 1/2")
	})

	it("stops after the retry budget is spent", () => {
		const decision = decideRetry("m1", new Error("socket hang up"), 3, 2)
		expect(decision.shouldRetry).toBe(false)
		expect(decision.note).toContain("no retries left")
	})

	it("never retries a non-transient error, whatever the attempt count", () => {
		const decision = decideRetry("m1", new Error("bad port"), 1)
		expect(decision.shouldRetry).toBe(false)
	})
})

describe("real gateway timeout failure", () => {
	it("is treated as a model failure deserving failover", () => {
		const message =
			"[Model Error] Request failed (200): Failed to process successful response: Failed to process successful response: terminated: Body Timeout Error"
		expect(isModelUnavailableError(new Error(message))).toBe(true)
		expect(isRetryableError(new Error(message))).toBe(true)
	})
})
