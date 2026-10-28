/**
 * Offline hazard replay: run the same safety look the phone runs, over frames already on disk.
 *
 * Why this exists: the detector could only ever be judged by walking around with a phone, so it was
 * never judged at all. The frames the phone already staged are enough to re-run the check, which
 * turns "we have never measured it" into "here is every verdict, label them".
 *
 * What it does NOT do: it does not claim accuracy. Without human labels there is no ground truth, so
 * the report leaves a label column blank and the summary says how many looks are unlabelled. Pass
 * --labels to score; missed dangers are listed by id, never averaged away.
 *
 * Usage:
 *   npm run sim:hazard:replay -- --dry-run                 list what would be replayed, spends nothing
 *   npm run sim:hazard:replay -- --limit 10                replay 10 looks (10 model calls)
 *   npm run sim:hazard:replay -- --labels labels.json      score against {"<look id>": "halt|caution|clear"}
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argValue, hasArg } from "../experiment.js";
import { HAZARD_MAX_FRAMES, checkHazard } from "../agent/hazard-check.js";
import { collectHazardLooks, loadHazardFrames, scoreHazardReplay } from "../agent/hazard-replay.js";

interface ReplayRow {
	id: string;
	session: string;
	kind: string;
	frameCount: number;
	frames: string[];
	severity: string | null;
	hazardKind: string | null;
	speech: string | null;
	confidence: number | null;
	model: string | null;
	elapsedMs: number | null;
	error: string | null;
	humanLabel: string | null;
	humanNote: string | null;
}

const args = process.argv.slice(2);
const root = argValue(args, "--root", "run/mobile-staging");
const limit = Number(argValue(args, "--limit", "10"));
const maxFrames = Math.min(HAZARD_MAX_FRAMES, Math.max(1, Number(argValue(args, "--max-frames", "3"))));
const kinds = argValue(args, "--kind", "").split(",").map((value) => value.trim()).filter(Boolean);
const labelsPath = argValue(args, "--labels", "");
const dryRun = hasArg(args, "--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(argValue(args, "--out", join("run/hazard-replay", stamp)));

if (!Number.isFinite(limit) || limit < 0) throw new Error("--limit 必须是非负整数（0 表示全部）");
if (!Number.isFinite(maxFrames) || maxFrames < 1) throw new Error("--max-frames 必须是 1 到 3");

const looks = await collectHazardLooks(root, { limit, maxFrames, ...(kinds.length > 0 ? { kinds } : {}) });
console.log(`扫描 ${resolve(root)}：找到 ${looks.length} 个视角（每个视角最多取 ${maxFrames} 帧）`);
for (const look of looks) console.log(`  ${look.id}  ${look.frames.length} 帧  [${look.kind}]`);
if (looks.length === 0) throw new Error("没有找到可回放的截图目录；确认 --root 指向 run/mobile-staging");
if (dryRun) {
	console.log("--dry-run：只列出待回放视角，未调用模型，未产生费用。");
	process.exit(0);
}
// Cost is stated before it is spent: one look is one paid request.
console.log(`即将调用危险检测模型 ${looks.length} 次（每个视角 1 个请求）。\n`);

const rows: ReplayRow[] = [];
for (const [index, look] of looks.entries()) {
	const frames = await loadHazardFrames(look.frames);
	const label = `[${index + 1}/${looks.length}] ${look.id}`;
	try {
		const result = await checkHazard(frames, null);
		rows.push({
			id: look.id,
			session: look.session,
			kind: look.kind,
			frameCount: frames.length,
			frames: look.frames.map((frame) => frame.name),
			severity: result.assessment.severity,
			hazardKind: result.assessment.kind,
			speech: result.assessment.speech,
			confidence: result.assessment.confidence,
			model: result.model,
			elapsedMs: result.elapsedMs,
			error: null,
			humanLabel: null,
			humanNote: null,
		});
		console.log(`${label}: ${result.assessment.severity}/${result.assessment.kind} · ${result.assessment.speech || "(无需播报)"} · ${result.elapsedMs}ms`);
	} catch (error) {
		// A failed look is recorded as a failure, never as "clear": silence must not be counted as
		// evidence that the way ahead is safe.
		const message = error instanceof Error ? error.message : String(error);
		rows.push({
			id: look.id,
			session: look.session,
			kind: look.kind,
			frameCount: frames.length,
			frames: look.frames.map((frame) => frame.name),
			severity: null,
			hazardKind: null,
			speech: null,
			confidence: null,
			model: null,
			elapsedMs: null,
			error: message,
			humanLabel: null,
			humanNote: null,
		});
		console.log(`${label}: 检查失败 ${message}`);
	}
}

const labels = labelsPath ? JSON.parse(await readFile(resolve(labelsPath), "utf8")) as Record<string, string> : {};
const scored = Object.keys(labels).length > 0
	? scoreHazardReplay(
		rows.filter((row) => row.severity !== null).map((row) => ({ id: row.id, severity: row.severity! })),
		labels,
	)
	: null;

const failed = rows.filter((row) => row.severity === null).length;
const warned = rows.filter((row) => row.severity === "halt" || row.severity === "caution").length;
const note = [
	"离线回放，不是准确率验收。",
	"没有人工标注就没有真值，因此 unlabelled 单独计数，不折算成分数。",
	"帧时间戳取文件 mtime（写入时间，非拍摄时间）。",
	"检查失败的视角记为 error，不计入 clear，也不当作安全。",
	"人工标注格式：results.jsonl 中的 humanLabel 填 halt/caution/clear，再用 --labels 重新打分。",
].join(" ");

const report: string[] = [
	"# 危险检测离线回放",
	"",
	`- 运行时间：${new Date().toISOString()}`,
	`- 回放来源：${resolve(root)}`,
	`- 视角数：${rows.length}（失败 ${failed}）`,
	`- 判定为危险：${warned}；判定为安全：${rows.filter((row) => row.severity === "clear").length}`,
	`- 说明：${note}`,
	"",
];
if (scored) {
	report.push(
		"## 与人工标注对照",
		"",
		`- 已标注：${scored.labeled}；未标注：${scored.unlabeled}；标注值非法：${scored.invalidLabels}`,
		`- 漏报（标为危险却判定安全）：**${scored.missed.length}**`,
		`- 误报（标为安全却发出警告）：${scored.falseAlarm.length}`,
		`- 完全一致：${scored.agreed}`,
		"",
	);
	if (scored.missed.length > 0) report.push("漏报视角：", "", ...scored.missed.map((id) => `- ${id}`), "");
	if (scored.falseAlarm.length > 0) report.push("误报视角：", "", ...scored.falseAlarm.map((id) => `- ${id}`), "");
}
report.push(
	"## 逐视角结果",
	"",
	"| # | 视角 | 帧 | 判定 | 类型 | 播报 | 置信 | 用时 | 人工标注（待填） |",
	"|---|---|---|---|---|---|---|---|---|",
	...rows.map((row, index) => `| ${index + 1} | ${row.id} | ${row.frameCount} | ${row.severity ?? `失败：${row.error}`} | ${row.hazardKind ?? "-"} | ${row.speech || "-"} | ${row.confidence === null ? "-" : row.confidence.toFixed(2)} | ${row.elapsedMs === null ? "-" : `${row.elapsedMs}ms`} |  |`),
	"",
);

await mkdir(outDir, { recursive: true });
const flag = "wx";
await writeFile(join(outDir, "results.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { encoding: "utf8", flag });
await writeFile(join(outDir, "report.md"), report.join("\n"), { encoding: "utf8", flag });
await writeFile(join(outDir, "summary.json"), JSON.stringify({
	note,
	generatedAt: new Date().toISOString(),
	source: resolve(root),
	looks: rows.length,
	failed,
	warned,
	clear: rows.filter((row) => row.severity === "clear").length,
	scored,
}, null, 2), { encoding: "utf8", flag });

console.log(`\n共 ${rows.length} 个视角，失败 ${failed}，判定危险 ${warned}。`);
if (scored) console.log(`与标注对照：漏报 ${scored.missed.length}，误报 ${scored.falseAlarm.length}，一致 ${scored.agreed}，未标注 ${scored.unlabeled}。`);
else console.log("未提供 --labels：本次只产出待标注结果，不给任何准确率结论。");
console.log(`输出目录：${outDir}`);
