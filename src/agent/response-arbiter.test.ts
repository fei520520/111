import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createArbiterState,
	decideUtterance,
	fifoPolicy,
	markFinished,
	markSpoken,
	sortPending,
	takeNext,
	type ArbiterState,
	type Utterance,
	type UtteranceKind,
} from "./response-arbiter.js";

const u = (id: string, kind: UtteranceKind, opts: { atMs?: number; ttlMs?: number; text?: string } = {}): Utterance => ({
	id,
	kind,
	text: opts.text ?? id,
	createdAtMs: opts.atMs ?? 0,
	ttlMs: opts.ttlMs ?? 10000,
	source: "test",
});

const speaking = (utterance: Utterance, atMs = 0): ArbiterState => ({ pending: [], speaking: { utterance, atMs }, recent: [] });

test("urgency order is safety, clarify, task, ambient with stable ties", () => {
	const sorted = sortPending([u("c", "ambient", { atMs: 0 }), u("a", "safety", { atMs: 5 }), u("b", "clarify", { atMs: 1 }), u("d", "clarify", { atMs: 0 })]);
	assert.deepEqual(sorted.map((item) => item.id), ["a", "d", "b", "c"]);
});

test("an expired utterance is dropped and never queued", () => {
	const decision = decideUtterance(u("a", "task", { atMs: 0, ttlMs: 1000 }), createArbiterState(), 5000);
	assert.equal(decision.action, "drop");
	assert.equal(decision.reason, "expired");
	assert.equal(decision.speak, null);
});

test("idle channel speaks immediately and prunes expired waiting utterances", () => {
	const state: ArbiterState = { pending: [u("dead", "task", { atMs: 0, ttlMs: 100 })], speaking: null, recent: [] };
	const decision = decideUtterance(u("a", "task", { atMs: 1000 }), state, 1000);
	assert.equal(decision.action, "speak");
	assert.equal(decision.speak?.id, "a");
	assert.equal(decision.nextState.pending.length, 0);
});

test("alarm fatigue: the same kind cannot speak twice inside its cooldown", () => {
	const state = markSpoken(createArbiterState(), u("s1", "safety", { atMs: 0 }), 0);
	const decision = decideUtterance(u("s2", "safety", { atMs: 500 }), state, 500);
	assert.equal(decision.action, "drop");
	assert.equal(decision.reason, "cooldown-or-duplicate");
});

test("identical text is suppressed across kinds inside the duplicate window", () => {
	const state = markSpoken(createArbiterState(), u("a", "task", { atMs: 0, text: "前方有一扇门" }), 0);
	const decision = decideUtterance(u("b", "ambient", { atMs: 2000, text: "前方有一扇门" }), state, 2000);
	assert.equal(decision.action, "drop");
});

test("safety interrupts a task answer and the interrupted answer goes back to the queue", () => {
	const decision = decideUtterance(u("s1", "safety", { atMs: 1000 }), speaking(u("t1", "task")), 1000);
	assert.equal(decision.action, "replace");
	assert.equal(decision.preemptedId, "t1");
	assert.equal(decision.resume?.id, "t1");
	assert.equal(decision.nextState.pending.length, 1);
});

test("a task answer cannot interrupt a clarification request; it waits", () => {
	const decision = decideUtterance(u("t1", "task", { atMs: 1000 }), speaking(u("c1", "clarify")), 1000);
	assert.equal(decision.action, "queue");
	assert.equal(decision.speak, null);
	assert.deepEqual(decision.nextState.pending.map((item) => item.id), ["t1"]);
});

test("a full queue rejects a candidate that is the least urgent", () => {
	const pending = Array.from({ length: 6 }, (_, index) => u(`p${index}`, "task", { atMs: index }));
	const state: ArbiterState = { pending, speaking: { utterance: u("live", "task", { atMs: 0 }), atMs: 0 }, recent: [] };
	const decision = decideUtterance(u("new", "ambient", { atMs: 100 }), state, 100);
	assert.equal(decision.action, "drop");
	assert.equal(decision.reason, "queue-full-lowest-priority");
});

test("a full queue evicts its least urgent entry for a more urgent candidate", () => {
	const pending = Array.from({ length: 6 }, (_, index) => u(`a${index}`, "ambient", { atMs: index }));
	const state: ArbiterState = { pending, speaking: { utterance: u("live", "task", { atMs: 0 }), atMs: 0 }, recent: [] };
	const decision = decideUtterance(u("want", "task", { atMs: 100 }), state, 100);
	assert.equal(decision.action, "queue");
	assert.notEqual(decision.record.evictedId, null);
	assert.equal(decision.nextState.pending.length, 6);
});

test("the fifo baseline never interrupts and never suppresses repeats", () => {
	const decision = decideUtterance(u("s1", "safety", { atMs: 1000 }), speaking(u("t1", "task")), 1000, fifoPolicy);
	assert.equal(decision.action, "queue");
	assert.equal(decision.preemptedId, null);
});

test("an interrupted utterance that expired while speaking is not resumed", () => {
	const state = speaking(u("old", "task", { atMs: 0, ttlMs: 500 }));
	const decision = decideUtterance(u("s1", "safety", { atMs: 5000 }), state, 5000);
	assert.equal(decision.action, "replace");
	assert.equal(decision.resume, null);
	assert.equal(decision.nextState.pending.length, 0);
});

test("takeNext skips expired heads and shrinks the queue", () => {
	const state: ArbiterState = { pending: [u("dead", "safety", { atMs: 0, ttlMs: 100 }), u("live", "task", { atMs: 1000 })], speaking: null, recent: [] };
	const { utterance, nextState } = takeNext(state, 1000);
	assert.equal(utterance?.id, "live");
	assert.equal(nextState.pending.length, 0);
});

test("recent-spoken memory is trimmed to the cooldown window", () => {
	let state = markSpoken(createArbiterState(), u("a", "task", { atMs: 0 }), 0);
	state = markSpoken(state, u("b", "task", { atMs: 0 }), 40000, { maxPending: 6, recentWindowMs: 30000, duplicateTextWindowMs: 15000 });
	assert.equal(state.recent.length, 1);
	assert.equal(state.recent[0]!.utterance.id, "b");
});

test("a hazard interrupts an answer that then returns to the queue once the channel frees", () => {
	let state = createArbiterState();
	const answer = u("task-1", "task", { atMs: 0 });
	assert.equal(decideUtterance(answer, state, 0).action, "speak");
	state = markSpoken(state, answer, 0);

	const hazard = u("safety-1", "safety", { atMs: 1000 });
	const interrupted = decideUtterance(hazard, state, 1000);
	assert.equal(interrupted.action, "replace");
	assert.equal(interrupted.preemptedId, "task-1");
	state = markSpoken(interrupted.nextState, hazard, 1000);
	assert.deepEqual(state.pending.map((item) => item.id), ["task-1"]);

	// The hazard finishes; the interrupted answer is what the user actually asked for, so it comes back.
	state = markFinished(state);
	const next = takeNext(state, 1200);
	assert.equal(next.utterance?.id, "task-1");
	assert.equal(next.nextState.pending.length, 0);
});

test("the same danger is throttled by its own reminder interval, not silenced by it", () => {
	const step = { ...u("s1", "safety", { atMs: 0, text: "小心脚下有台阶" }), latchKey: "hazard:step" };
	const state = markFinished(markSpoken(createArbiterState(), step, 0));

	const tooSoon = { ...u("s2", "safety", { atMs: 1000, text: "停下" }), latchKey: "hazard:step" };
	assert.equal(decideUtterance(tooSoon, state, 1000).action, "drop");

	const reminder = { ...u("s3", "safety", { atMs: 4000, text: "停下" }), latchKey: "hazard:step" };
	assert.equal(decideUtterance(reminder, state, 4000).action, "speak");
});

test("a persistent danger is exempt from the generic per-kind cooldown", () => {
	const step = { ...u("s1", "safety", { atMs: 0, text: "小心脚下有台阶" }), latchKey: "hazard:step" };
	let state = markFinished(markSpoken(createArbiterState(), step, 0));
	// A different warning (same kind) spoke moments ago, which would normally silence the whole kind.
	const other = { ...u("other", "safety", { atMs: 0, text: "前方有人" }), latchKey: "hazard:person" };
	state = markFinished(markSpoken(state, other, 6500));

	const again = { ...u("s2", "safety", { atMs: 7000, text: "小心脚下有台阶" }), latchKey: "hazard:step" };
	assert.equal(decideUtterance(again, state, 7000).action, "speak");
});
