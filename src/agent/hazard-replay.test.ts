import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHazardLooks, loadHazardFrames, scoreHazardReplay } from "./hazard-replay.js";

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function stagingTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hazard-replay-"));
	await mkdir(join(root, "session-b", "scene-1"), { recursive: true });
	await mkdir(join(root, "session-b", "hazard-2"), { recursive: true });
	await mkdir(join(root, "session-a", "request-1"), { recursive: true });
	await mkdir(join(root, "session-a", "manifest-only"), { recursive: true });
	await writeFile(join(root, "session-a", "request-1", "frame-01.jpg"), JPEG_BYTES);
	await writeFile(join(root, "session-a", "request-1", "frame-02.jpg"), JPEG_BYTES);
	await writeFile(join(root, "session-a", "request-1", "notes.json"), "{}");
	await writeFile(join(root, "session-a", "manifest-only", "manifest.json"), "{}");
	await writeFile(join(root, "session-b", "hazard-2", "frame-01.png"), JPEG_BYTES);
	await writeFile(join(root, "session-b", "scene-1", "frame-01.jpg"), JPEG_BYTES);
	return root;
}

test("a staging directory is one look, and only image directories count", async () => {
	const looks = await collectHazardLooks(await stagingTree());
	assert.deepEqual(looks.map((look) => look.id), [
		"session-a/request-1",
		"session-b/hazard-2",
		"session-b/scene-1",
	]);
	assert.deepEqual(looks.map((look) => look.kind), ["request", "hazard", "scene"]);
	// A non-image file inside a look must not become a frame.
	assert.equal(looks[0]?.frames.length, 2);
});

test("kind filter, limit and frame cap are honoured", async () => {
	const root = await stagingTree();
	assert.deepEqual((await collectHazardLooks(root, { kinds: ["hazard"] })).map((look) => look.id), ["session-b/hazard-2"]);
	assert.deepEqual((await collectHazardLooks(root, { limit: 2 })).map((look) => look.id), ["session-a/request-1", "session-b/hazard-2"]);
	// More than three frames would exceed what the endpoint accepts, so the extra ones are dropped here.
	const capped = await collectHazardLooks(root, { maxFrames: 1 });
	assert.equal(capped[0]?.frames.length, 1);
});

test("frames load as base64 with the mime type taken from the extension", async () => {
	const looks = await collectHazardLooks(await stagingTree(), { kinds: ["hazard"] });
	const frames = await loadHazardFrames(looks[0]!.frames);
	assert.equal(frames.length, 1);
	assert.equal(frames[0]?.mimeType, "image/png");
	assert.equal(frames[0]?.dataBase64, JPEG_BYTES.toString("base64"));
});

test("scoring separates a missed danger from a false alarm and refuses to score unlabelled looks", () => {
	const summary = scoreHazardReplay([
		{ id: "a", severity: "clear" },
		{ id: "b", severity: "halt" },
		{ id: "c", severity: "caution" },
		{ id: "d", severity: "clear" },
		{ id: "e", severity: "halt" },
	], { a: "halt", b: "clear", c: "caution", e: "danger" });
	assert.equal(summary.labeled, 3);
	assert.equal(summary.unlabeled, 1);
	assert.equal(summary.invalidLabels, 1);
	assert.equal(summary.agreed, 1);
	assert.deepEqual(summary.missed, ["a"]);
	assert.deepEqual(summary.falseAlarm, ["b"]);
	assert.deepEqual(summary.byLabel.halt, { total: 1, missed: 1 });
	assert.deepEqual(summary.byLabel.clear, { total: 1, missed: 0 });
});
