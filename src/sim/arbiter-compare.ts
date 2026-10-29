/**
 * Compare speech-channel policies on identical input.
 *
 * Usage:
 *   npm run sim:arbiter -- --scenario hazard-mid-answer   constructed case: hazard arrives mid-answer
 *   npm run sim:arbiter -- --session latest               replay the last recorded session
 *   npm run sim:arbiter -- --session all                  pool every recorded session
 *
 * Reads only local files and never calls a model. The recorded run's own decisions are ignored on
 * purpose: the candidate utterances and their arrival times are replayed through both schedules, so
 * the difference in the output is the difference in policy, not in the model.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argValue } from "../experiment.js";
import {
	START_DELAY_MS,
	buildTraceFromEvents,
	comparePolicies,
	hazardMidAnswerScenario,
	type ArbiterEventLike,
	type PolicyMetrics,
	type ReplayRecord,
} from "../agent/arbiter-sim.js";
import type { Utterance } from "../agent/response-arbiter.js";

const args = process.argv.slice(2);
const scenario = argValue(args, "--scenario", "");
const sessionArg = argValue(args, "--session", "latest");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(argValue(args, "--out", join("run/arbiter-compare", stamp)));

const KIND_ORDER = ["safety", "clarify", "task", "ambient"] as const;

async function readSessionEvents(sessionDir: string): Promise<ArbiterEventLike[]> {
	const text = await readFile(join(sessionDir, "events.jsonl"), "utf8").catch(() => "");
	const events: ArbiterEventLike[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line) as ArbiterEventLike); } catch { /* a torn line is not worth failing over */ }
	}
	return events;
}

async function pickSessionFiles(which: string): Promise<{ id: string; file: string }[]> {
	const root = resolve("run/experiments");
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const found: { id: string; file: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const file = join(root, entry.name, "events.jsonl");
		const info = await stat(file).catch(() => null);
		if (info) found.push({ id: entry.name, file, mtimeMs: info.mtimeMs });
	}
	found.sort((a, b) => b.mtimeMs - a.mtimeMs);
	if (which === "all") return found.map(({ id, file }) => ({ id, file }));
	if (which === "latest") return found.slice(0, 1).map(({ id, file }) => ({ id, file }));
	const exact = found.find((item) => item.id === which);
	return exact ? [{ id: exact.id, file: exact.file }] : [];
}

let trace: Utterance[] = [];
let origin = "";
if (scenario === "hazard-mid-answer") {
	trace = hazardMidAnswerScenario();
	origin = "constructed: 长回答播到一半时检出危险";
} else if (scenario) {
	throw new Error(`未知场景 ${scenario}；目前只有 hazard-mid-answer`);
} else {
	const sessions = await pickSessionFiles(sessionArg);
	if (sessions.length === 0) throw new Error(`没有找到会话记录（--session ${sessionArg}）`);
	const contributing: string[] = [];
	for (const session of sessions) {
		const events = await readSessionEvents(join(resolve("run/experiments"), session.id));
		const fromSession = buildTraceFromEvents(events);
		// Most sessions never made an arbitration decision; listing them would bury the ones that did.
		if (fromSession.length === 0) continue;
		contributing.push(`${session.id}（${fromSession.length}）`);
		// Candidate ids are only unique inside one session; without the prefix, pooling sessions
		// would merge two different lines into a single record and quietly undercount.
		trace.push(...fromSession.map((utterance) => ({ ...utterance, id: `${session.id}:${utterance.id}` })));
	}
	if (contributing.length === 0) throw new Error(`这些会话里都没有 arbiter_decision 事件（--session ${sessionArg}）`);
	origin = contributing.join(", ");
}
if (trace.length === 0) throw new Error("该来源里没有可回放的仲裁候选（需要 arbiter_decision 事件）");

const comparison = comparePolicies(trace, origin);
const format = (value: number | null, unit = "ms") => (value === null ? "-" : `${value}${unit}`);
const lines: string[] = [
	"# 语音通道策略对比",
	"",
	`- 生成时间：${new Date().toISOString()}`,
	`- 轨迹来源：${origin}`,
	`- 候选数：${trace.length}`,
	`- 假设：语音时长按 \`400 + 120 × 字数\` 毫秒估算；拿到通道后 ${START_DELAY_MS} ms 才真正出声；轨迹的到达时刻来自真实运行，但策略是反事实重放。`,
	"",
	"| 策略 | 安全行真丢失 | 严格丢失 | 安全行去重抑制 | 去重但无近期同文 | 安全行平均延迟 | 安全行最大延迟 | 被打断的回答 | 抢占次数 | 完整播报 |",
	"|---|---|---|---|---|---|---|---|---|---|",
];

for (const metrics of comparison.policies) {
	const totalSpoken = KIND_ORDER.reduce((sum, kind) => sum + metrics.spoken[kind], 0);
	lines.push(`| ${metrics.policy} | ${metrics.safetyLost} | ${metrics.safetyLostStrict} | ${metrics.safetyDeduped} | ${metrics.safetyDedupedUnmatched} | ${format(metrics.meanDelayMs.safety)} | ${format(metrics.maxDelayMs.safety)} | ${metrics.interrupted.task} | ${metrics.preemptions} | ${totalSpoken} |`);
}
lines.push(
	"",
	"“真丢失”不含被去重压掉的安全行；“严格丢失”把那些“近期并没有播过同一句”的抑制也算作丢失——只有这一列才等于“用户没被告知”。两列并排，是为了不让有意的静默替真正的漏报作掩护。",
);

lines.push("", "## 逐条结果", "", "| 到达 | 类型 | safety-first | 延迟 | fifo | 延迟 | 文本 |", "|---|---|---|---|---|---|---|");
const byPolicy = new Map(comparison.policies.map((policy) => [policy.policy, policy]));
const safetyFirst = byPolicy.get("safety-first");
const fifo = byPolicy.get("fifo");
if (!safetyFirst || !fifo) throw new Error(`comparePolicies 没有返回预期的两个策略：${[...byPolicy.keys()].join(", ")}`);

const delayOf = (record: { audibleAtMs: number | null; arrivalMs: number }): string =>
	record.audibleAtMs === null ? "-" : `${Math.max(0, record.audibleAtMs - record.arrivalMs)}ms`;
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 23);
/** The bare outcome hides that a line was cut and replayed later, which is the whole trade-off. */
const label = (record: ReplayRecord): string =>
	record.reason === "resumed-after-preemption" ? `${record.outcome}（打断后重播）` : record.outcome;

for (const record of safetyFirst.records) {
	const other = fifo.records.find((item) => item.id === record.id);
	const text = record.text.length > 28 ? `${record.text.slice(0, 28)}…` : record.text;
	lines.push(`| ${clock(record.arrivalMs)} | ${record.kind} | ${label(record)} | ${delayOf(record)} | ${other ? label(other) : "-"} | ${other ? delayOf(other) : "-"} | ${text} |`);
}

const print = (metrics: PolicyMetrics) => {
	const parts = KIND_ORDER.filter((kind) => metrics.arrivals[kind] > 0).map((kind) => `${kind} 到达${metrics.arrivals[kind]}/播报${metrics.spoken[kind]}/未播报${metrics.neverSpoken[kind]}${metrics.meanDelayMs[kind] === null ? "" : `（均延迟 ${metrics.meanDelayMs[kind]}ms）`}`);
	console.log(`\n[${metrics.policy}] ${parts.join(" · ")}`);
	console.log(`  安全行真丢失：${metrics.safetyLost}（严格 ${metrics.safetyLostStrict}），去重抑制：${metrics.safetyDeduped}（其中无近期同文 ${metrics.safetyDedupedUnmatched}），抢占：${metrics.preemptions}，被打断的回答：${metrics.interrupted.task}`);
};

console.log(`轨迹来源：${origin}（${trace.length} 条候选）`);
for (const metrics of comparison.policies) print(metrics);
if (safetyFirst.safetyLostStrict > fifo.safetyLostStrict) {
	console.log("\n注意：按严格口径，安全优先策略反而漏掉了更多安全行，这需要先解释清楚再谈优势。");
}
for (const metrics of comparison.policies) {
	if (metrics.safetyDedupedUnmatched > 0) {
		console.log(`\n注意：${metrics.policy} 有 ${metrics.safetyDedupedUnmatched} 条安全行被按重复抑制，但文本和已播报的任何一条都不同，请人工确认不是漏报。`);
	}
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2), "utf8");
await writeFile(join(outDir, "report.md"), lines.join("\n"), "utf8");
console.log(`\n输出目录：${outDir}`);
