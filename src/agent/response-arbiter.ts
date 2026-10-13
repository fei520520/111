/**
 * ResponseArbiter (decision layer): decides *which* utterance owns the single
 * speech channel. It does not play anything.
 *
 * The phone has exactly one voice channel and several competing producers:
 *   - safety  : hazard warnings (hard constraint: must not wait in a queue)
 *   - clarify : asking the user to change the view so evidence can be re-collected
 *   - task    : the answer to the user's explicit request
 *   - ambient : low-value environment notes
 *
 * Playback (queue, preemption, barge-in, device-side cooldown) already lives in
 * `web/app.js`. This module owns only the *decision*, so it can be unit tested,
 * recorded to `events.jsonl`, and swapped between policies.
 *
 * Research note: the rule set is pluggable on purpose. `fifoPolicy` exists as a
 * baseline so a safety-first schedule can be compared with it on identical input;
 * every decision carries a machine-readable `reason` for offline analysis.
 */

export type UtteranceKind = "safety" | "clarify" | "task" | "ambient";

export interface Utterance {
	id: string;
	kind: UtteranceKind;
	text: string;
	createdAtMs: number;
	/** After `createdAtMs + ttlMs` the utterance is worthless: it must never be spoken. */
	ttlMs: number;
	/** Producer of the utterance, e.g. "hazard", "clarify", "request", "scene". */
	source: string;
	/** Evidence ids (frame ids / detector output) so a decision stays auditable. */
	evidence?: string[];
	confidence?: number;
	/**
	 * Identity of a persistent danger, e.g. "hazard:hallway-step".
	 *
	 * The duty of this system is to keep the user safe, so staying quiet while they keep walking
	 * toward the same obstacle is the failure mode to avoid: a keyed danger may be repeated after
	 * `HAZARD_REMINDER_MS`, and it is exempt from the generic per-kind cooldown.
	 */
	latchKey?: string;
}

export interface SpokenRecord {
	utterance: Utterance;
	atMs: number;
}

export interface ArbiterState {
	/** Waiting utterances; highest priority first when read through `sortPending`. */
	pending: Utterance[];
	/** What is being spoken right now, if anything. */
	speaking: SpokenRecord | null;
	/** Recently spoken utterances, kept for cooldown and de-duplication. */
	recent: SpokenRecord[];
}

export type ArbiterAction = "speak" | "queue" | "replace" | "drop";

export interface ArbiterRecord {
	candidateId: string;
	kind: UtteranceKind;
	priority: number;
	action: ArbiterAction;
	reason: string;
	preemptedId: string | null;
	evictedId: string | null;
	queueDepth: number;
	nowMs: number;
}

export interface ArbiterDecision {
	action: ArbiterAction;
	reason: string;
	/** Utterance the client should speak now (null = say nothing). */
	speak: Utterance | null;
	/** Id of the utterance that gets interrupted, when the action is "replace". */
	preemptedId: string | null;
	/** Interrupted utterance that should return to the queue (null when expired). */
	resume: Utterance | null;
	nextState: ArbiterState;
	record: ArbiterRecord;
}

export interface ArbiterLimits {
	maxPending: number;
	/** How long a spoken utterance stays in `recent` for cooldown purposes. */
	recentWindowMs: number;
	/** Identical text is never repeated inside this window. */
	duplicateTextWindowMs: number;
}

export interface ArbiterPolicy {
	name: string;
	/** May `candidate` interrupt what is being spoken? */
	shouldPreempt(candidate: Utterance, speaking: SpokenRecord): boolean;
	/** May `candidate` be spoken given what was recently spoken? */
	repeatAllowed(candidate: Utterance, recent: SpokenRecord[], nowMs: number, limits: ArbiterLimits): boolean;
}

/** Smaller number = more urgent. */
export const PRIORITY: Record<UtteranceKind, number> = { safety: 0, clarify: 1, task: 2, ambient: 3 };

/** Kinds allowed to interrupt a strictly lower-priority utterance. */
export const PREEMPTIVE: Record<UtteranceKind, boolean> = { safety: true, clarify: true, task: false, ambient: false };

/** Minimum gap before the same kind may speak again (alarm-fatigue control). */
export const COOLDOWN_MS: Record<UtteranceKind, number> = { safety: 1500, clarify: 8000, task: 3000, ambient: 20000 };

export const DEFAULT_LIMITS: ArbiterLimits = { maxPending: 6, recentWindowMs: 30000, duplicateTextWindowMs: 15000 };

/** How often the same persistent danger may be repeated while it is still there. */
export const HAZARD_REMINDER_MS = 3000;

/** Default schedule: a more urgent kind may interrupt a less urgent one. */
export const safetyFirstPolicy: ArbiterPolicy = {
	name: "safety-first",
	shouldPreempt: (candidate, speaking) => PREEMPTIVE[candidate.kind] && PRIORITY[candidate.kind] < PRIORITY[speaking.utterance.kind],
	repeatAllowed: (candidate, recent, nowMs, limits) => {
		// A keyed danger is throttled by its own reminder interval instead of the generic cooldown:
		// silence while the user keeps walking toward the same step is exactly what must not happen.
		if (candidate.latchKey) {
			let newest = -1;
			for (const record of recent) {
				if (record.utterance.latchKey !== candidate.latchKey) continue;
				if (nowMs - record.atMs >= limits.recentWindowMs) continue;
				if (record.atMs > newest) newest = record.atMs;
			}
			if (newest >= 0) return nowMs - newest >= HAZARD_REMINDER_MS;
		}
		const cooldown = COOLDOWN_MS[candidate.kind];
		const text = candidate.text.trim();
		for (const record of recent) {
			const age = nowMs - record.atMs;
			if (age >= limits.recentWindowMs) continue;
			if (record.utterance.kind === candidate.kind && age < cooldown) return false;
			if (age < limits.duplicateTextWindowMs && record.utterance.text.trim() === text) return false;
		}
		return true;
	},
};

/** Baseline that never interrupts and never suppresses repeats; only for comparison runs. */
export const fifoPolicy: ArbiterPolicy = {
	name: "fifo",
	shouldPreempt: () => false,
	repeatAllowed: () => true,
};

export function createArbiterState(): ArbiterState {
	return { pending: [], speaking: null, recent: [] };
}

export function isExpired(utterance: Utterance, nowMs: number): boolean {
	return nowMs > utterance.createdAtMs + utterance.ttlMs;
}

/** Highest priority first; ties broken by creation time so older requests win. */
export function sortPending(pending: Utterance[]): Utterance[] {
	return [...pending].sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || (a.createdAtMs - b.createdAtMs));
}

/**
 * Decide what happens to one candidate utterance.
 *
 * The returned `nextState` already reflects expired-entry pruning and queue
 * changes; `speaking` / `recent` are updated by `markSpoken` once playback is
 * confirmed, so the arbiter never assumes a client actually spoke.
 */
export function decideUtterance(
	candidate: Utterance,
	state: ArbiterState,
	nowMs: number,
	policy: ArbiterPolicy = safetyFirstPolicy,
	limits: ArbiterLimits = DEFAULT_LIMITS,
): ArbiterDecision {
	// Expired waiting utterances are worthless: never let them occupy the queue.
	const pending = state.pending.filter((utterance) => !isExpired(utterance, nowMs));
	const priority = PRIORITY[candidate.kind];

	const decision = (
		action: ArbiterAction,
		reason: string,
		speak: Utterance | null,
		nextPending: Utterance[],
		preemptedId: string | null = null,
		resume: Utterance | null = null,
		evictedId: string | null = null,
	): ArbiterDecision => ({
		action,
		reason,
		speak,
		preemptedId,
		resume,
		nextState: { ...state, pending: nextPending },
		record: { candidateId: candidate.id, kind: candidate.kind, priority, action, reason, preemptedId, evictedId, queueDepth: nextPending.length, nowMs },
	});

	if (isExpired(candidate, nowMs)) return decision("drop", "expired", null, pending);
	if (!policy.repeatAllowed(candidate, state.recent, nowMs, limits)) return decision("drop", "cooldown-or-duplicate", null, pending);

	// Nothing is being spoken: take the channel.
	if (!state.speaking) return decision("speak", "channel-idle", candidate, pending);

	if (policy.shouldPreempt(candidate, state.speaking)) {
		const interrupted = state.speaking.utterance;
		const resume = isExpired(interrupted, nowMs) ? null : interrupted;
		const nextPending = resume ? sortPending([...pending, resume]) : pending;
		return decision("replace", "preempted-by-higher-priority", candidate, nextPending, interrupted.id, resume);
	}

	if (pending.length < limits.maxPending) {
		return decision("queue", "queued-behind-higher-priority", null, sortPending([...pending, candidate]));
	}

	// Queue is full: keep the better set of utterances.
	const sorted = sortPending([...pending, candidate]);
	const worst = sorted[sorted.length - 1]!;
	if (worst.id === candidate.id) return decision("drop", "queue-full-lowest-priority", null, pending);
	const evicted = sorted.filter((utterance) => utterance.id !== worst.id);
	return decision("queue", "queue-full-evicted-lower-priority", null, evicted, null, null, worst.id);
}

/** Record that an utterance was actually spoken, refreshing cooldown/de-duplication memory. */
export function markSpoken(state: ArbiterState, utterance: Utterance, nowMs: number, limits: ArbiterLimits = DEFAULT_LIMITS): ArbiterState {
	const recent = [{ utterance, atMs: nowMs }, ...state.recent].filter((record) => nowMs - record.atMs < limits.recentWindowMs);
	return { pending: state.pending, speaking: { utterance, atMs: nowMs }, recent };
}

/** Record that playback ended (or was stopped) and the channel is free. */
export function markFinished(state: ArbiterState): ArbiterState {
	return { ...state, speaking: null };
}

/** Pull the next utterance to speak once the channel is free, dropping expired heads. */
export function takeNext(state: ArbiterState, nowMs: number): { utterance: Utterance | null; nextState: ArbiterState } {
	const pending = sortPending(state.pending).filter((utterance) => !isExpired(utterance, nowMs));
	const head = pending[0] ?? null;
	return { utterance: head, nextState: { ...state, pending: head ? pending.slice(1) : pending } };
}
