import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaceMemory } from "./place-memory.js";
import { parseMotionHint } from "./motion-hint.js";

test("layered memory preserves evidence through grouping, merging, rebinding and reload", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "warnfirst-memory-")), "memory.json");
	const memory = new PlaceMemory(file);
	const hint = parseMotionHint(null);
	const a = memory.ensureScene(null, "sofa", "", [], 1);
	const b = memory.ensureScene(null, "window", "", [], 2);
	const evidence = { frames: [{ id: "frame", path: "frame.jpg" }], confidence: 0.95, raw: "verified", uncertain: false };
	await memory.onSceneResolved(a.id, "a", hint, null, 1, evidence);
	await memory.onSceneResolved(b.id, "b", hint, null, 2, evidence);
	assert.equal(memory.getState().transitions.length, 1);
	await memory.groupPlaces([a.id, b.id], "living room", "continuous room evidence", ["observation-1", "observation-2"]);
	assert.equal(memory.listScenes().length, 2);
	await memory.mergePlaces(b.id, a.id, "duplicate local place", ["observation-2"]);
	assert.equal(memory.getScene(b.id)?.id, a.id);
	assert.equal(memory.getState().transitions.length, 0);
	assert.equal(memory.getState().observations.length, 2);
	const c = memory.ensureScene(null, "doorway", "", [], 3, true);
	await memory.rebindVisits(["visit-2"], c.id, "correct earlier assignment", ["observation-2"]);
	assert.equal(memory.getState().observations[1]?.placeId, c.id);
	assert.equal(memory.getState().transitions.length, 0);
	const restored = new PlaceMemory(file);
	await restored.load();
	assert.equal(restored.getState().revisions.length, 3);
	assert.equal(restored.getState().currentSceneId, c.id);
	await restored.onSceneResolved(a.id, "c", hint, null, 4, { ...evidence, uncertain: true });
	assert.equal(restored.getState().transitionExperiences.at(-1)?.confirmed, false);
	assert.equal(restored.getState().observations.at(-1)?.visitId, "visit-3");
	assert.equal(JSON.parse(await readFile(file, "utf8")).schemaVersion, 2);
});

test("split inside a visit is reversible and later observations block destructive undo", async () => {
	const memory = new PlaceMemory();
	const hint = parseMotionHint(null);
	const a = memory.ensureScene(null, "local A", "", [], 1);
	const b = memory.ensureScene(null, "local B", "", [], 2, true);
	const evidence = { frames: [{ id: "f", path: "f.jpg", matchPath: "front.jpg" }], confidence: 0.9, raw: "verified", uncertain: false };
	await memory.onSceneResolved(a.id, "f1", hint, null, 1, evidence);
	await memory.onSceneResolved(a.id, "f2", hint, null, 2, evidence);
	await memory.splitVisit("visit-1", "observation-2", b.id, "boundary revealed", ["observation-1", "observation-2"]);
	assert.equal(memory.getState().observations[1]?.visitId, "visit-2");
	assert.equal(memory.getScene(b.id)?.frames[0]?.matchPath, "front.jpg");
	assert.equal(memory.getState().transitionExperiences[0]?.confirmed, false);
	await memory.undoLastRevision("incorrect boundary");
	assert.equal(memory.getState().observations[1]?.visitId, "visit-1");
	assert.equal(memory.getState().currentSceneId, a.id);
	await memory.onSceneResolved(b.id, "f3", hint, null, 3, evidence);
	await memory.groupPlaces([a.id, b.id], "room", "continuous enclosure", ["observation-1", "observation-3"]);
	await memory.onSceneResolved(a.id, "f4", hint, null, 4, evidence);
	await assert.rejects(memory.undoLastRevision("too late"), /New observations/);
	await assert.rejects(memory.groupPlaces([a.id, b.id], "room", "bad evidence", ["missing"]), /Space evidence/);
});

test("V1 migration preserves visits and never invents VLM provenance; corrupt files fail", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "warnfirst-migration-")), "memory.json");
	const original = new PlaceMemory(file);
	const place = original.ensureScene(null, "old place", "", [], 1);
	await original.onSceneResolved(place.id, "f", parseMotionHint(null), null, 1);
	const data = JSON.parse(await readFile(file, "utf8"));
	data.schemaVersion = 1;
	delete data.observations;
	delete data.transitionExperiences;
	await writeFile(file, JSON.stringify(data));
	const migrated = new PlaceMemory(file);
	await migrated.load();
	assert.equal(migrated.getState().observations.length, 0);
	await migrated.onSceneResolved(place.id, "g", parseMotionHint(null), null, 2);
	assert.equal(migrated.getState().observations[0]?.decision.via, "legacy");
	assert.equal(migrated.getState().observations[0]?.visitId, "visit-1");
	await writeFile(file, "{bad json");
	await assert.rejects(new PlaceMemory(file).load());
});

test("a single over-merged place can be split into a new provisional place", async () => {
	const memory = new PlaceMemory();
	const place = memory.ensureScene(null, "mixed", "", [], 1);
	const evidence = { frames: [{ id: "f", path: "f.jpg" }], confidence: 0.9, raw: "verified", uncertain: false };
	await memory.onSceneResolved(place.id, "f", parseMotionHint(null), null, 1, evidence);
	await memory.onSceneResolved(place.id, "g", parseMotionHint(null), null, 2, evidence);
	await memory.splitVisit("visit-1", "observation-2", null, "different occupied area", ["observation-1", "observation-2"], "doorway");
	assert.equal(memory.listScenes().length, 2);
	assert.equal(memory.listScenes()[1]?.provisional, true);
	await memory.undoLastRevision("boundary not established");
	assert.equal(memory.listScenes().length, 1);
});

test("Space groups connected distinct local positions without merging their identities", async () => {
	const memory = new PlaceMemory();
	const a = memory.ensureScene(null, "beside table", "", ["table"], 1);
	const b = memory.ensureScene(null, "across aisle", "", ["table"], 2);
	const c = memory.ensureScene(null, "unrelated position", "", ["table"], 3);
	const evidence = { frames: [{ id: "same-visible-table", path: "table.jpg" }], confidence: 0.95, raw: "verified", uncertain: false, anchors: ["table"], localRelations: ["beside table"], identityReason: "different observer position" };
	await memory.onSceneResolved(a.id, "a", parseMotionHint(null), null, 1, evidence);
	await memory.onSceneResolved(b.id, "b", parseMotionHint(null), null, 2, { ...evidence, localRelations: ["across aisle from table"] });
	const space = await memory.groupPlaces([a.id, b.id], "table-and-aisle area", "adjacent positions in the continuous table area", ["observation-1", "observation-2"]);
	assert.notEqual(a.id, b.id);
	assert.equal(memory.getScene(a.id)?.spaceId, space.id);
	assert.equal(memory.getScene(b.id)?.spaceId, space.id);
	assert.equal(memory.getState().observations[1]?.localRelations?.[0], "across aisle from table");
	assert.equal(memory.getState().transitions.length, 1);
	await assert.rejects(memory.groupPlaces([a.id, c.id], "same-looking area", "shared table image", ["observation-1", "observation-2"]), /cover every member/);
});

test("representative budget retains initial anchor and recent multi-view snapshots", () => {
	const memory = new PlaceMemory();
	const place = memory.ensureScene(null, "region", "", [], 0);
	for (let i = 0; i < 8; i++) memory.addRepresentative(place.id, { id: `frame-${i}`, path: `${i}.jpg`, matchViews: [{ view: "left", path: `left-${i}.jpg` }] });
	assert.equal(place.frames.length, 5);
	assert.equal(place.frames[0]?.id, "frame-0");
	assert.equal(place.frames.at(-1)?.matchViews?.[0]?.path, "left-7.jpg");
	memory.addRepresentative(place.id, { id: "frame-7", path: "duplicate-copy.jpg" });
	assert.equal(place.frames.at(-1)?.path, "7.jpg");
});
