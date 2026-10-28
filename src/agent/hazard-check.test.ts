import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { HAZARD_MAX_FRAMES, assertHazardFrames, checkHazard, hazardFrameIds, hazardTextPrompt } from "./hazard-check.js";

const JPEG = "/9j/4AAQSkZJRg==";

function frame(timestampMs: number) {
	return { timestampMs, mimeType: "image/jpeg", dataBase64: JPEG };
}

interface FetchCall { url: string; body: Record<string, unknown> }

/** Replace the network for the duration of one test; nothing here may hit the real API. */
function stubReply(t: TestContext, reply: { status?: number; payload: unknown }): FetchCall[] {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch;
	process.env.QWEN_API_KEY = "test-key";
	process.env.QWEN_BASE_URL = "https://example.test/v1/";
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		const status = reply.status ?? 200;
		return { ok: status >= 200 && status < 300, status, json: async () => reply.payload } as Response;
	}) as typeof fetch;
	t.after(() => { globalThis.fetch = original; });
	return calls;
}

const message = (content: string) => ({ choices: [{ message: { content } }] });

test("one text block plus one image per frame, in a request the model cannot get chatty in", async (t) => {
	const calls = stubReply(t, { payload: message('{"kind":"obstacle","severity":"halt","speech":"停下","confidence":0.9,"reason":"椅子"}') });
	await checkHazard([frame(1_000), frame(2_000)], "正在向前走");
	const [call] = calls;
	assert.ok(call);
	assert.equal(call.url, "https://example.test/v1/chat/completions");
	assert.equal(call.body.temperature, 0);
	assert.equal(call.body.max_tokens, 300);
	const messages = call.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
	const content = messages[0]?.content ?? [];
	assert.equal(content.length, 3);
	assert.equal(content[0]?.type, "text");
	assert.equal(content[1]?.type, "image_url");
	assert.deepEqual(content[1]?.image_url, { url: `data:image/jpeg;base64,${JPEG}` });
});

test("motion is appended as context and can never replace the safety rules", () => {
	const withMotion = hazardTextPrompt("正在向前走，速度大约每秒一米");
	assert.match(withMotion, /正在向前走/);
	// The rules that bias the verdict toward warning must survive the extra context.
	assert.match(withMotion, /防止他受伤/);
	assert.match(withMotion, /无法判断前方是否安全/);
	const withoutMotion = hazardTextPrompt(null);
	assert.doesNotMatch(withoutMotion, /运动状态/);
	assert.match(withoutMotion, /防止他受伤/);
});

test("a clear verdict produces no speech candidate", async (t) => {
	stubReply(t, { payload: message('{"kind":"none","severity":"clear","speech":"","confidence":0.7,"reason":"走廊空"}') });
	const result = await checkHazard([frame(1_000)], null);
	assert.equal(result.assessment.severity, "clear");
	assert.equal(result.utterance, null);
});

test("a danger verdict latches onto the same danger so reminders stay attached", async (t) => {
	stubReply(t, { payload: message('{"kind":"step","severity":"halt","speech":"停下，前面有台阶","confidence":0.86,"reason":"台阶"}') });
	const result = await checkHazard([frame(1_000), frame(2_000)], null);
	assert.equal(result.assessment.severity, "halt");
	assert.equal(result.utterance?.kind, "safety");
	assert.equal(result.utterance?.latchKey, "hazard:step");
	assert.deepEqual(result.utterance?.evidence, ["hazard-1-1000", "hazard-2-2000"]);
});

test("an unreadable reply is a failed look, never a silent all-clear", async (t) => {
	stubReply(t, { payload: message("我看不太清楚，应该没事吧") });
	await assert.rejects(() => checkHazard([frame(1_000)], null), /JSON/);
});

test("provider errors surface instead of being read as safety", async (t) => {
	stubReply(t, { status: 500, payload: { error: { message: "quota exhausted" } } });
	await assert.rejects(() => checkHazard([frame(1_000)], null), /quota exhausted/);
});

test("more frames than the endpoint accepts are rejected before any call is spent", async (t) => {
	const calls = stubReply(t, { payload: message("{}") });
	const tooMany = Array.from({ length: HAZARD_MAX_FRAMES + 1 }, (_, index) => frame(index));
	await assert.rejects(() => checkHazard(tooMany, null), /1 到 3 张截图/);
	assert.equal(calls.length, 0);
});

test("unsupported image types are rejected locally", () => {
	assert.throws(() => assertHazardFrames([{ timestampMs: 1, mimeType: "image/gif", dataBase64: JPEG }]), /JPEG、PNG 或 WebP/);
	assert.throws(() => assertHazardFrames([{ timestampMs: 1, mimeType: "image/jpeg", dataBase64: "" }]), /缺少图像数据/);
});

test("frame ids are stable and order preserving", () => {
	assert.deepEqual(hazardFrameIds([frame(1_700_000_000_123), frame(1_700_000_002_987)]), [
		"hazard-1-1700000000123",
		"hazard-2-1700000002987",
	]);
});
