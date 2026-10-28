/**
 * Offline plumbing for replaying the safety look over frames that are already on disk.
 *
 * The detector has never been measured, because measuring it used to require walking around with a
 * phone. The frames the phone already left in `run/mobile-staging` are enough to re-run the same
 * check, so this file only has to do two things: find the looks, and turn human labels into the one
 * number that matters.
 *
 * Deliberate limits: mtime is used as the frame timestamp (it is write time, not capture time), and
 * a look that saw only 1-3 frames is replayed as such. Neither is a defect to paper over, so both are
 * reported rather than smoothed.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { HazardFrame } from "./hazard-check.js";

const MIME_BY_EXTENSION: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
};

export interface HazardReplayFrame {
	path: string;
	name: string;
	mimeType: string;
	/** File mtime, never the original capture time: the staging directory does not preserve it. */
	timestampMs: number;
}

export interface HazardReplayLook {
	/** Stable id used to join human labels, e.g. "<session>/<directory>". */
	id: string;
	session: string;
	directory: string;
	/** Directory prefix before the first "-": scene, request, hazard, ... */
	kind: string;
	frames: HazardReplayFrame[];
}

export interface CollectHazardOptions {
	/** Restrict to these directory prefixes; empty or omitted means every kind. */
	kinds?: string[];
	/** 0 or omitted means all. */
	limit?: number;
	maxFrames?: number;
}

/**
 * Find every staging directory that holds usable images, oldest session first.
 *
 * A directory is one look, because that is how the phone writes them: one directory per request.
 * Ordering is by name so two runs over the same tree produce the same sequence.
 */
export async function collectHazardLooks(root: string, options: CollectHazardOptions = {}): Promise<HazardReplayLook[]> {
	const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
	const maxFrames = Math.max(1, Math.min(options.maxFrames ?? 3, 3));
	const looks: HazardReplayLook[] = [];
	const sessions = await readdir(resolve(root), { withFileTypes: true }).catch(() => []);
	for (const session of [...sessions].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!session.isDirectory()) continue;
		const sessionDir = join(resolve(root), session.name);
		const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.isDirectory()) continue;
			const kind = entry.name.split("-")[0] ?? entry.name;
			if (kinds && !kinds.has(kind)) continue;
			const directory = join(sessionDir, entry.name);
			const names = (await readdir(directory, { withFileTypes: true }).catch(() => []))
				.filter((file) => file.isFile() && MIME_BY_EXTENSION[extname(file.name).toLowerCase()] !== undefined)
				.map((file) => file.name)
				.sort();
			if (names.length === 0) continue;
			const frames: HazardReplayFrame[] = [];
			for (const name of names.slice(0, maxFrames)) {
				const path = join(directory, name);
				const info = await stat(path).catch(() => null);
				if (!info) continue;
				frames.push({ path, name, mimeType: MIME_BY_EXTENSION[extname(name).toLowerCase()]!, timestampMs: Math.round(info.mtimeMs) });
			}
			if (frames.length === 0) continue;
			looks.push({ id: `${session.name}/${entry.name}`, session: session.name, directory, kind, frames });
		}
	}
	const limit = options.limit ?? 0;
	return limit > 0 ? looks.slice(0, limit) : looks;
}

/** Read the chosen files into the payload shape the hazard check expects. */
export async function loadHazardFrames(frames: HazardReplayFrame[]): Promise<HazardFrame[]> {
	const loaded: HazardFrame[] = [];
	for (const frame of frames) {
		const bytes = await readFile(frame.path);
		loaded.push({ timestampMs: frame.timestampMs, mimeType: frame.mimeType, dataBase64: bytes.toString("base64") });
	}
	return loaded;
}

export type HazardLabel = "halt" | "caution" | "clear";

const HAZARD_LABELS: readonly HazardLabel[] = ["halt", "caution", "clear"];

export interface HazardScoreRow {
	id: string;
	severity: string;
}

export interface HazardScoreSummary {
	labeled: number;
	unlabeled: number;
	invalidLabels: number;
	agreed: number;
	/**
	 * Labelled a danger while the model said clear. This is the failure that must not happen, so it
	 * is reported first and as a list rather than folded into an accuracy number.
	 */
	missed: string[];
	/** Labelled clear while the model warned. Annoying, but the acceptable side of the trade-off. */
	falseAlarm: string[];
	byLabel: Record<HazardLabel, { total: number; missed: number }>;
}

/**
 * Compare verdicts with human labels.
 *
 * No score is invented when labels are missing: unlabelled looks are counted and excluded, because a
 * number computed over unlabelled data would read as evidence it is not.
 */
export function scoreHazardReplay(rows: HazardScoreRow[], labels: Record<string, string>): HazardScoreSummary {
	const byLabel: Record<HazardLabel, { total: number; missed: number }> = {
		halt: { total: 0, missed: 0 },
		caution: { total: 0, missed: 0 },
		clear: { total: 0, missed: 0 },
	};
	const summary: HazardScoreSummary = { labeled: 0, unlabeled: 0, invalidLabels: 0, agreed: 0, missed: [], falseAlarm: [], byLabel };
	for (const row of rows) {
		const raw = labels[row.id];
		if (raw === undefined) { summary.unlabeled++; continue; }
		if (!(HAZARD_LABELS as readonly string[]).includes(raw)) { summary.invalidLabels++; continue; }
		const label = raw as HazardLabel;
		summary.labeled++;
		byLabel[label].total++;
		const predicted = row.severity;
		if (predicted === label) { summary.agreed++; continue; }
		const labelIsDanger = label !== "clear";
		const predictedIsDanger = predicted !== "clear";
		if (labelIsDanger && !predictedIsDanger) { summary.missed.push(row.id); byLabel[label].missed++; }
		else if (!labelIsDanger && predictedIsDanger) summary.falseAlarm.push(row.id);
	}
	return summary;
}
