import { test } from "node:test";
import assert from "node:assert/strict";
import { hazardToUtterance, parseHazardReply } from "./hazard-watch.js";

test("a clear view says nothing at all", () => {
	const assessment = parseHazardReply(JSON.stringify({ kind: "none", severity: "clear", speech: "", confidence: 0.9 }), ["f1"]);
	assert.equal(hazardToUtterance(assessment, 1000), null);
});

test("a step reported as halt becomes a safety line keyed by the danger", () => {
	const assessment = parseHazardReply(JSON.stringify({ kind: "step", severity: "halt", speech: "停，脚下有台阶。", confidence: 0.8 }), ["f1", "f2"]);
	const utterance = hazardToUtterance(assessment, 1000);
	assert.equal(utterance?.kind, "safety");
	assert.equal(utterance?.latchKey, "hazard:step");
	assert.equal(utterance?.text, "停，脚下有台阶。");
	assert.deepEqual(utterance?.evidence, ["f1", "f2"]);
});

test("a fenced JSON reply is accepted and a missing speech line falls back to a safe default", () => {
	const assessment = parseHazardReply("```json\n{\"kind\": \"obstacle\", \"severity\": \"halt\", \"confidence\": 0.7}\n```", ["f1"]);
	assert.equal(assessment.severity, "halt");
	assert.match(assessment.speech, /停下/);
});

test("an unknown kind is read as unclear, never as safe", () => {
	const assessment = parseHazardReply(JSON.stringify({ kind: "danger", severity: "caution", speech: "小心" }), []);
	assert.equal(assessment.kind, "unclear");
	assert.equal(hazardToUtterance(assessment, 0)?.latchKey, "hazard:unclear");
});

test("an unreadable severity degrades to caution rather than to silence", () => {
	const assessment = parseHazardReply(JSON.stringify({ kind: "traffic", severity: "DANGER", speech: "有车" }), []);
	assert.equal(assessment.severity, "caution");
	assert.notEqual(hazardToUtterance(assessment, 0), null);
});

test("confidence is clamped and a non-JSON reply is rejected outright", () => {
	assert.equal(parseHazardReply(JSON.stringify({ kind: "obstacle", severity: "halt", speech: "停", confidence: 4 }), []).confidence, 1);
	assert.throws(() => parseHazardReply("not json at all", []));
});
