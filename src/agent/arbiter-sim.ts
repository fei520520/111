/**
 * Offline comparison of speech-channel policies.
 *
 * The arbiter module already exposes `fifoPolicy` as a baseline, but nothing has ever measured the
 * difference: "safety-first is better" is a design belief until the same candidate stream is run
 * through both schedules and the outcome is counted. This file does exactly that, on traces recorded
 * from real sessions, with no network and no phone.
 *
 * What it measures, and why those are the numbers that matter:
 *   - a safety line that is *never spoken* (expired while waiting) is the failure the whole design
 *     exists to prevent, so it is reported separately from ordinary drops;
 *   - the delay between a hazard being detected and being audible;
 *   - how many answers get cut off in exchange for that.
 *
 * Stated assumptions (they are estimates, not measurements):
 *   - speech duration is modelled from character count, because the trace records text, not audio;
 *   - a line becomes audible `START_DELAY_MS` after it wins the channel, standing in for synthesis;
 *   - the trace's timing comes from a run under one policy, so replaying another policy is a
 *     counterfactual about scheduling, not a re-run of the model.
 */
import {
	DEFAULT_LIMITS,
	PRIORITY,
	createArbiterState,
	createSafetyFirstPolicy,
	decideUtterance,
	fifoPolicy,
	isExpired,
	markFinished,
	markSpoken,
	safetyFirstPolicy,
	takeNext,
	type ArbiterPolicy,
	type ArbiterState,
	type Utterance,
	type UtteranceKind,
} from "./response-arbiter.js";

/** Client-side TTL defaults, mirrored so a replayed line expires the way it would on the phone. */
export const DEFAULT_TTL_MS: Record<UtteranceKind, number> = { safety: 4000, clarify: 20000, task: 15000, ambient: 30000 };

/** Time from winning the channel to being audible (TTS fetch + decode). Measured ~0.7-1.2s. */
export const START_DELAY_MS = 800;

/**
 * Speech duration estimate.
 *
 * From real synthesis: 21 characters produced 3.4s of audio at 1.25x, i.e. ~2.7s of playback. The fit
 * `400 + 120 * chars` gives 2.9s for that line; the floor keeps very short lines from vanishing.
 */
export function estimateSpeechMs(text: string): number {
	return Math.max(600, 400 + 120 * (text || "").length);
}

export type Outcome = "spoken" | "interrupted" | "dropped-expired" | "dropped-cooldown" | "dropped-queue-full" | "never-spoken";

export interface ReplayRecord {
	id: string;
	kind: UtteranceKind;
	text: string;
	arrivalMs: number;
	audibleAtMs: number | null;
	outcome: Outcome;
	/** Machine-readable arbiter reason for the final outcome. */
	reason: string;
}

export interface PolicyMetrics {
	policy: string;
	arrivals: Record<UtteranceKind, number>;
	/** Lines whose final outcome is delivered; `spoken + neverSpoken == arrivals`. */
	spoken: Record<UtteranceKind, number>;
	neverSpoken: Record<UtteranceKind, number>;
	/** Lines cut off at least once. Overlaps with both sides: a cut line may be replayed and finish. */
	interrupted: Record<UtteranceKind, number>;
	/** Detection to first audible. */
	meanDelayMs: Record<UtteranceKind, number | null>;
	maxDelayMs: Record<UtteranceKind, number | null>;
	/** How many lower-priority lines were cut off to speak a higher-priority one. */
	preemptions: number;
	/** Safety lines that were never delivered, for any reason. */
	safetyNeverSpoken: number;
	/**
	 * Of `safetyNeverSpoken`, the ones suppressed because the same hazard had just been announced.
	 * Not a failure — but only if the suppressed text really is a repeat, which is why the count
	 * below exists instead of trusting the label.
	 */
	safetyDeduped: number;
	/**
	 * Of `safetyDeduped`, the ones whose text matches no safety line that was actually spoken. A
	 * distinct hazard swallowed by too coarse a cooldown key would hide here; it needs a human.
	 */
	safetyDedupedUnmatched: number;
	/** Of `safetyNeverSpoken`, the ones not explained by duplicate suppression. Must be 0. */
	safetyLost: number;
	/**
	 * `safetyLost + safetyDedupedUnmatched`: the reading where an unjustified suppression is treated
	 * as a loss too. Reported alongside `safetyLost` because the lenient figure alone flatters any
	 * policy that suppresses aggressively, which is exactly the failure this system must not have.
	 */
	safetyLostStrict: number;
	records: ReplayRecord[];
}

const EMPTY_KINDS: Record<UtteranceKind, number> = { safety: 0, clarify: 0, task: 0, ambient: 0 };

function bump(bucket: Record<UtteranceKind, number>, kind: UtteranceKind): void {
	bucket[kind] += 1;
}

/**
 * Replay one trace through one policy.
 *
 * Single-threaded event loop over `min(next arrival, channel release)`: the phone has one voice
 * channel, so the only two things that can happen are "someone wants to speak" and "the channel
 * freed up".
 */
export interface SimulateOptions {
	/**
	 * Overrides `START_DELAY_MS`. The real figure was measured at 0.7-1.2s, so a sweep has to vary it:
	 * a policy that only wins when synthesis is instant has not won anything.
	 */
	startDelayMs?: number;
}

export function simulatePolicy(trace: Utterance[], policy: ArbiterPolicy, options: SimulateOptions = {}): PolicyMetrics {
	const startDelayMs = options.startDelayMs ?? START_DELAY_MS;
	const ordered = [...trace].sort((a, b) => a.createdAtMs - b.createdAtMs);
	let state: ArbiterState = createArbiterState();
	let busyUntil = -Infinity;
	let index = 0;
	const metrics: PolicyMetrics = {
		policy: policy.name,
		arrivals: { ...EMPTY_KINDS },
		spoken: { ...EMPTY_KINDS },
		neverSpoken: { ...EMPTY_KINDS },
		interrupted: { ...EMPTY_KINDS },
		meanDelayMs: { safety: null, clarify: null, task: null, ambient: null },
		maxDelayMs: { safety: null, clarify: null, task: null, ambient: null },
		preemptions: 0,
		safetyNeverSpoken: 0,
		safetyDeduped: 0,
		safetyDedupedUnmatched: 0,
		safetyLost: 0,
		safetyLostStrict: 0,
		records: [],
	};
	const records = new Map<string, ReplayRecord>();
	const delays = new Map<UtteranceKind, number[]>();

	const record = (utterance: Utterance): ReplayRecord => {
		const existing = records.get(utterance.id);
		if (existing) return existing;
		const created: ReplayRecord = { id: utterance.id, kind: utterance.kind, text: utterance.text, arrivalMs: utterance.createdAtMs, audibleAtMs: null, outcome: "never-spoken", reason: "" };
		records.set(utterance.id, created);
		return created;
	};
	const noteDelay = (utterance: Utterance, audibleAt: number): void => {
		const list = delays.get(utterance.kind) ?? [];
		list.push(Math.max(0, audibleAt - utterance.createdAtMs));
		delays.set(utterance.kind, list);
	};
	/**
	 * Counters are per utterance, not per speaking attempt: a preempted answer returns to the queue
	 * and is started again from the top, which would otherwise inflate `spoken` past `arrivals` and
	 * drag the mean latency toward a number that describes neither attempt.
	 */
	const startedIds = new Set<string>();
	const interruptedIds = new Set<string>();
	const startSpeaking = (utterance: Utterance, at: number): void => {
		state = markSpoken(state, utterance, at);
		const audibleAt = at + startDelayMs;
		busyUntil = audibleAt + estimateSpeechMs(utterance.text);
		const entry = record(utterance);
		entry.outcome = "spoken";
		// Keep the first audible moment: that is the latency the listener actually experienced, and
		// the resumed attempt would otherwise overwrite it with a much later number.
		entry.audibleAtMs ??= audibleAt;
		if (startedIds.has(utterance.id)) entry.reason = "resumed-after-preemption";
		else {
			startedIds.add(utterance.id);
			noteDelay(utterance, audibleAt);
		}
	};
	/** Anything still waiting that has passed its ttl is lost; record it before it is pruned. */
	const reapExpired = (at: number): void => {
		const survivors: Utterance[] = [];
		for (const pending of state.pending) {
			if (!isExpired(pending, at)) { survivors.push(pending); continue; }
			const entry = record(pending);
			if (entry.outcome !== "spoken") { entry.outcome = "dropped-expired"; entry.reason = "expired-in-queue"; }
		}
		state = { ...state, pending: survivors };
	};
	const pump = (at: number): void => {
		reapExpired(at);
		while (!state.speaking) {
			const next = takeNext(state, at);
			state = next.nextState;
			if (!next.utterance) return;
			startSpeaking(next.utterance, at);
		}
	};

	for (const utterance of ordered) bump(metrics.arrivals, utterance.kind);

	while (index < ordered.length || state.speaking) {
		const arriveAt = index < ordered.length ? ordered[index]!.createdAtMs : Infinity;
		const releaseAt = state.speaking ? busyUntil : Infinity;
		if (arriveAt === Infinity && releaseAt === Infinity) break;
		const now = Math.min(arriveAt, releaseAt);

		if (state.speaking && busyUntil <= now) {
			state = markFinished(state);
			busyUntil = -Infinity;
		}
		pump(now);

		if (arriveAt !== Infinity && arriveAt === now) {
			const candidate = ordered[index]!;
			index += 1;
			const entry = record(candidate);
			const decision = decideUtterance(candidate, state, now, policy);
			state = decision.nextState;
			if (decision.action === "drop") {
				entry.outcome = decision.reason === "expired" ? "dropped-expired" : "dropped-cooldown";
				entry.reason = decision.reason;
			} else if (decision.action === "queue") {
				entry.reason = decision.reason;
			} else if (decision.action === "replace") {
				const interruptedId = decision.preemptedId;
				if (interruptedId) {
					const interrupted = records.get(interruptedId);
					// `audibleAtMs` is kept: part of the line was heard, and hiding it would make the
					// interruption look like a line that never made it out at all.
					if (interrupted) {
						interrupted.outcome = "interrupted";
						interrupted.reason = decision.reason;
						if (!interruptedIds.has(interrupted.id)) {
							interruptedIds.add(interrupted.id);
							bump(metrics.interrupted, interrupted.kind);
						}
					}
				}
				metrics.preemptions += 1;
				state = markFinished(state);
				busyUntil = -Infinity;
				startSpeaking(candidate, now);
			} else {
				startSpeaking(candidate, now);
			}
		}
	}

	const kinds = Object.keys(metrics.meanDelayMs) as UtteranceKind[];
	for (const tracked of records.values()) {
		if (tracked.outcome === "never-spoken" && !tracked.reason) tracked.reason = "trace-ended";
	}
	// A safety line that was never heard is not automatically a miss: repeats are suppressed on
	// purpose. The excuse only holds if the *same* warning was delivered shortly before, so the check
	// looks for a recent same-text delivery rather than "that text appeared at some point in the
	// trace" — with a small pool of phrasings, the loose version matches almost anything.
	// Suppressing a repeat is justified by a same-text line that had already *started* speaking, even
	// if its audio has not come out yet: the user is about to hear that exact sentence. Comparing
	// against the audible moment instead would flag every duplicate that lands inside the start delay.
	const startedSafety = [...records.values()]
		.filter((item) => item.kind === "safety" && item.outcome === "spoken" && item.audibleAtMs !== null)
		.map((item) => ({ text: item.text, startedAtMs: (item.audibleAtMs ?? 0) - startDelayMs }));
	// Deliberately one partition, decided by the final outcome: a line that was cut and never
	// resumed is not delivered, so it belongs in `neverSpoken` and nowhere else. `interrupted` is a
	// separate count of "was cut at least once" and may overlap with either side.
	for (const tracked of records.values()) {
		if (tracked.outcome === "spoken") { bump(metrics.spoken, tracked.kind); continue; }
		bump(metrics.neverSpoken, tracked.kind);
		if (tracked.kind !== "safety") continue;
		if (tracked.outcome !== "dropped-cooldown") { metrics.safetyLost += 1; continue; }
		metrics.safetyDeduped += 1;
		const explained = startedSafety.some((earlier) =>
			earlier.text === tracked.text
			&& earlier.startedAtMs <= tracked.arrivalMs
			&& tracked.arrivalMs - earlier.startedAtMs <= DEFAULT_LIMITS.duplicateTextWindowMs);
		if (!explained) metrics.safetyDedupedUnmatched += 1;
	}
	for (const kind of kinds) {
		// Every candidate is either heard or lost; if that stops holding, the table is lying and no
		// conclusion drawn from it is worth anything.
		if (metrics.spoken[kind] + metrics.neverSpoken[kind] !== metrics.arrivals[kind]) {
			throw new Error(`${policy.name}: ${kind} 计数不自洽（到达 ${metrics.arrivals[kind]}，播报 ${metrics.spoken[kind]}，未播报 ${metrics.neverSpoken[kind]}）`);
		}
		const list = delays.get(kind) ?? [];
		metrics.meanDelayMs[kind] = list.length === 0 ? null : Math.round(list.reduce((sum, value) => sum + value, 0) / list.length);
		metrics.maxDelayMs[kind] = list.length === 0 ? null : Math.round(Math.max(...list));
	}
	metrics.safetyNeverSpoken = metrics.neverSpoken.safety;
	metrics.safetyLostStrict = metrics.safetyLost + metrics.safetyDedupedUnmatched;
	metrics.records = [...records.values()].sort((a, b) => a.arrivalMs - b.arrivalMs);
	return metrics;
}

export interface PolicyComparison {
	trace: { size: number; from: string };
	policies: PolicyMetrics[];
}

/**
 * The candidate set for a sweep.
 *
 * `safety-first-oldcooldown` is the schedule as it shipped before 2026-10-29, when the generic
 * per-kind cooldown also silenced safety lines. It stays in the set so the ablation that justified
 * the change remains reproducible instead of living only in a commit message. The variant comes from
 * `createSafetyFirstPolicy`, so it cannot drift from the real implementation.
 */
export const POLICY_VARIANTS = [safetyFirstPolicy, createSafetyFirstPolicy({ safetyKindCooldown: true, name: "safety-first-oldcooldown" }), fifoPolicy];

export function comparePolicies(
	trace: Utterance[],
	from: string,
	options: SimulateOptions = {},
	policies: ArbiterPolicy[] = [safetyFirstPolicy, fifoPolicy],
): PolicyComparison {
	return {
		trace: { size: trace.length, from },
		policies: policies.map((policy) => simulatePolicy(trace, policy, options)),
	};
}

/** One recorded arbiter decision, as written to events.jsonl. */
export interface ArbiterEventLike {
	type?: string;
	goal?: string;
	timestamp?: string;
	details?: Record<string, unknown>;
}

/**
 * Turn recorded decisions into a replayable trace.
 *
 * Only the *candidate* is taken from the record; the recorded outcome is deliberately ignored, since
 * the point is to re-decide it under different policies. A session recorded under safety-first is
 * therefore a fair input for the fifo replay: same utterances, same arrival times.
 */
export function buildTraceFromEvents(events: ArbiterEventLike[]): Utterance[] {
	const trace: Utterance[] = [];
	for (const event of events) {
		if (event.type !== "arbiter_decision") continue;
		const details = event.details ?? {};
		const kind = details.kind;
		if (kind !== "safety" && kind !== "clarify" && kind !== "task" && kind !== "ambient") continue;
		const nowMs = typeof details.nowMs === "number" ? details.nowMs : Date.parse(String(event.timestamp ?? ""));
		if (!Number.isFinite(nowMs)) continue;
		const text = typeof event.goal === "string" ? event.goal : "";
		if (!text) continue;
		trace.push({
			id: typeof details.candidateId === "string" ? details.candidateId : `trace-${trace.length + 1}`,
			kind,
			text,
			createdAtMs: nowMs,
			ttlMs: DEFAULT_TTL_MS[kind],
			source: typeof details.source === "string" ? details.source : kind,
			...(typeof details.latchKey === "string" ? { latchKey: details.latchKey } : {}),
		});
	}
	return trace.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/**
 * A constructed situation, for the case the real logs cannot provide on demand.
 *
 * The counterfactual that motivates the whole design: a long answer is being read out when a hazard
 * is detected. Under safety-first the warning must interrupt it; under fifo the warning must wait for
 * the answer to finish, which is longer than the warning is allowed to live.
 */
export function hazardMidAnswerScenario(kind: UtteranceKind = "safety"): Utterance[] {
	const base = 1_000_000;
	const answer = "你现在正对着书桌一角，白色桌面上有橙色鼠标垫和黑色鼠标，旁边还有一个白色的小吸尘器，后面是黄色收纳篮。";
	return [
		{ id: "scenario-answer", kind: "task", text: answer, createdAtMs: base, ttlMs: DEFAULT_TTL_MS.task, source: "request" },
		{ id: "scenario-hazard", kind, text: "小心，前面有台阶，请停下", createdAtMs: base + 800, ttlMs: DEFAULT_TTL_MS[kind], source: "hazard", ...(kind === "safety" ? { latchKey: "hazard:step" } : {}) },
	];
}

/** Small helper so callers can explain ordering without importing PRIORITY twice. */
export function priorityOf(kind: UtteranceKind): number {
	return PRIORITY[kind];
}

export const SIM_LIMITS = DEFAULT_LIMITS;
