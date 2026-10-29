/**
 * Sweep the speech channel over a workload model instead of a single trace.
 *
 * `arbiter-compare` answers "what happens on this one input". One input cannot tell you whether a
 * policy wins or just got lucky, and the real sessions only hold a dozen arbitrated candidates — too
 * few to sweep. So this file generates candidate streams from a stated arrival model, runs both
 * schedules on each, and reports the trade-off surface.
 *
 * What is modelled, and what it is fitted to:
 *   - arrival of hazards and questions as a Poisson process. The rates are swept, not measured, so
 *     every number below is conditional on the cell it sits in — that is why the cells are printed;
 *   - answer length drawn from a range, its speech duration estimated the same way the replay does;
 *   - TTS start delay swept over the 0.7-1.2s that was actually measured.
 *
 * Nothing here is a user study. A cell where safety-first loses is a hypothesis to test on the
 * phone, not a proven failure; a cell where it wins is not evidence that it works.
 *
 * Usage:
 *   npm run sim:arbiter:sweep
 *   npm run sim:arbiter:sweep -- --hazards 0.5,3 --questions 1,4 --seeds 40 --minutes 5
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argValue } from "../experiment.js";
import { DEFAULT_TTL_MS, POLICY_VARIANTS, comparePolicies, type PolicyMetrics } from "../agent/arbiter-sim.js";
import { safetyFirstPolicy } from "../agent/response-arbiter.js";
import type { Utterance } from "../agent/response-arbiter.js";

const args = process.argv.slice(2);
const numberList = (raw: string, fallback: number[]): number[] => {
	const list = raw.split(",").map((part) => Number(part.trim())).filter((value) => Number.isFinite(value) && value >= 0);
	return list.length > 0 ? list : fallback;
};
const hazardRates = numberList(argValue(args, "--hazards", "0.5,1.5,4"), [1.5]);
const questionRates = numberList(argValue(args, "--questions", "1,2,4"), [2]);
const startDelays = numberList(argValue(args, "--start-delays", "700,950,1200"), [950]);
const seeds = Math.max(1, Math.round(Number(argValue(args, "--seeds", "24"))));
const minutes = Math.max(0.5, Number(argValue(args, "--minutes", "3")));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(argValue(args, "--out", join("run/arbiter-sweep", stamp)));

/** Deterministic per-cell RNG: a report you cannot re-run is not evidence. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SAFETY_LINES = [
	"小心，前面有台阶，请停下",
	"小心，前方有人靠近",
	"小心，右边有台阶",
	"小心，左侧有桌角，向右一点",
];
const TASK_LINES = [
	"画面里是一张书桌，桌面上有橙色鼠标垫、黑色鼠标，右侧还有一个白色的小吸尘器，后面是黄色的收纳篮。",
	"你前方是宿舍书桌，左边架子上有一瓶水，右边靠墙立着一个灰黑色的长包，看起来像吉他包。",
	"这里光线有点暗，桌面上能看清键盘和杯子，地面没有被挡住的障碍物。",
	"你右手边是书架，上面有书和盒子，前面一米的范围内是空的。",
];
const AMBIENT_LINES = ["这里光线有点暗", "画面里有个人经过", "桌面上多了一个杯子"];

/** Poisson arrival times inside the simulated span, in milliseconds. */
function arrivals(rng: () => number, perMinute: number, spanMs: number): number[] {
	const times: number[] = [];
	if (perMinute <= 0) return times;
	const meanGap = 60_000 / perMinute;
	let at = rng() * meanGap;
	while (at < spanMs) {
		times.push(at);
		at += -Math.log(1 - rng()) * meanGap;
	}
	return times;
}

/** A long answer text of roughly `chars` characters, cut on a character boundary. */
function filler(chars: number, index: number): string {
	const base = TASK_LINES[index % TASK_LINES.length]!;
	let text = base;
	while (text.length < chars) text += base;
	return text.slice(0, chars);
}

interface Workload {
	hazardPerMin: number;
	questionPerMin: number;
	spanMs: number;
	seed: number;
}

function buildTrace(workload: Workload): Utterance[] {
	const rng = mulberry32(workload.seed);
	const trace: Utterance[] = [];
	let next = 0;
	const add = (kind: Utterance["kind"], text: string, createdAtMs: number): void => {
		next += 1;
		trace.push({ id: `w${next}`, kind, text, createdAtMs, ttlMs: DEFAULT_TTL_MS[kind], source: kind === "safety" ? "hazard" : "request" });
	};

	for (const at of arrivals(rng, workload.hazardPerMin, workload.spanMs)) {
		add("safety", SAFETY_LINES[Math.floor(rng() * SAFETY_LINES.length)]!, at);
	}
	for (const at of arrivals(rng, workload.questionPerMin, workload.spanMs)) {
		// 20-110 characters covers both a one-line confirmation and the long room descriptions
		// the real sessions actually contain.
		add("task", filler(20 + Math.floor(rng() * 90), Math.floor(rng() * TASK_LINES.length)), at);
	}
	for (const at of arrivals(rng, workload.questionPerMin / 4, workload.spanMs)) {
		add("ambient", AMBIENT_LINES[Math.floor(rng() * AMBIENT_LINES.length)]!, at);
	}
	return trace.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

interface CellRow {
	hazardPerMin: number;
	questionPerMin: number;
	startDelayMs: number;
	policy: string;
	safetyArrivals: number;
	safetyLost: number;
	safetyDeduped: number;
	safetyDedupedUnmatched: number;
	/** Loss under the strict reading, where an unexplained suppression counts as lost too. */
	safetyLostStrict: number;
	/** Mean of the per-seed means; seeds where nothing was spoken are excluded and counted. */
	safetyDelayMeanMs: number | null;
	safetySeedsWithNoSpeech: number;
	safetyDelayMaxMs: number | null;
	interruptedTask: number;
	preemptions: number;
	spokenTotal: number;
	lostRate: number;
	strictLostRate: number;
}

const totalSpoken = (metrics: PolicyMetrics): number =>
	metrics.spoken.safety + metrics.spoken.clarify + metrics.spoken.task + metrics.spoken.ambient;

function aggregate(
	cell: { hazardPerMin: number; questionPerMin: number; startDelayMs: number },
	policy: string,
	runs: PolicyMetrics[],
): CellRow {
	const mean = (values: number[]): number | null =>
		values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
	const delays = runs.map((run) => run.meanDelayMs.safety).filter((value): value is number => value !== null);
	const maxes = runs.map((run) => run.maxDelayMs.safety).filter((value): value is number => value !== null);
	const sum = (pick: (run: PolicyMetrics) => number): number => runs.reduce((acc, run) => acc + pick(run), 0);
	const safetyArrivals = sum((run) => run.arrivals.safety);
	const safetyLost = sum((run) => run.safetyLost);
	const safetyLostStrict = sum((run) => run.safetyLostStrict);
	return {
		...cell,
		policy,
		safetyArrivals,
		safetyLost,
		safetyDeduped: sum((run) => run.safetyDeduped),
		safetyDedupedUnmatched: sum((run) => run.safetyDedupedUnmatched),
		safetyLostStrict,
		safetyDelayMeanMs: mean(delays),
		safetySeedsWithNoSpeech: runs.length - delays.length,
		safetyDelayMaxMs: maxes.length === 0 ? null : Math.max(...maxes),
		interruptedTask: sum((run) => run.interrupted.task),
		preemptions: sum((run) => run.preemptions),
		spokenTotal: sum(totalSpoken),
		lostRate: safetyArrivals === 0 ? 0 : safetyLost / safetyArrivals,
		strictLostRate: safetyArrivals === 0 ? 0 : safetyLostStrict / safetyArrivals,
	};
}

const rows: CellRow[] = [];
for (const hazardPerMin of hazardRates) {
	for (const questionPerMin of questionRates) {
		for (const startDelayMs of startDelays) {
			const runs = new Map<string, PolicyMetrics[]>();
			for (let seed = 0; seed < seeds; seed += 1) {
				const workload = { hazardPerMin, questionPerMin, spanMs: minutes * 60_000, seed: seed * 7919 + 17 };
				const comparison = comparePolicies(buildTrace(workload), "sweep", { startDelayMs }, POLICY_VARIANTS);
				for (const metrics of comparison.policies) {
					const bucket = runs.get(metrics.policy) ?? [];
					bucket.push(metrics);
					runs.set(metrics.policy, bucket);
				}
			}
			for (const [policy, metrics] of runs) rows.push(aggregate({ hazardPerMin, questionPerMin, startDelayMs }, policy, metrics));
		}
	}
}

/**
 * The case the shipping policy gets wrong today: two *different* hazards 100ms apart. The
 * per-kind safety cooldown in `response-arbiter.ts` does not look at the text, so the second one is
 * discarded as a repeat. Kept as a fixed cell so any regression is visible in every sweep.
 */
function adversarialCase(): Utterance[] {
	const base = 1_000_000;
	return [
		{ id: "adv-answer", kind: "task", text: filler(90, 0), createdAtMs: base, ttlMs: DEFAULT_TTL_MS.task, source: "request" },
		{ id: "adv-hazard-a", kind: "safety", text: "小心，前面有台阶，请停下", createdAtMs: base + 800, ttlMs: DEFAULT_TTL_MS.safety, source: "hazard" },
		{ id: "adv-hazard-b", kind: "safety", text: "小心，右边有台阶", createdAtMs: base + 900, ttlMs: DEFAULT_TTL_MS.safety, source: "hazard" },
	];
}

const adversarial = comparePolicies(adversarialCase(), "两条不同危险相隔 100ms");

/** A point dominates another when it is no worse on both axes and strictly better on one. */
const dominates = (a: CellRow, b: CellRow): boolean => {
	const ax = a.safetyDelayMeanMs ?? Number.POSITIVE_INFINITY;
	const bx = b.safetyDelayMeanMs ?? Number.POSITIVE_INFINITY;
	return a.interruptedTask <= b.interruptedTask && ax <= bx && (a.interruptedTask < b.interruptedTask || ax < bx);
};
const front = rows.filter((row) => !rows.some((other) => other !== row && dominates(other, row)));

const fmt = (value: number | null, digits = 0): string => (value === null ? "-" : value.toFixed(digits));
const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const lines: string[] = [
	"# 语音通道策略扫描",
	"",
	`- 生成时间：${new Date().toISOString()}`,
	`- 网格：危险 ${hazardRates.join("/")} 次/分 × 提问 ${questionRates.join("/")} 次/分 × 起播延迟 ${startDelays.join("/")} ms`,
	`- 每个格子 ${seeds} 个随机种子，每个种子模拟 ${minutes} 分钟`,
	"- 到达过程是**假设**（泊松），不是测得的真实分布；每个数字只在它所在的那一行里成立。",
	"- 宽口径丢失率 = 真丢失 / 安全行到达数，去重抑制不计入。",
	"- 严格丢失率 = (真丢失 + 未被近期同文解释的去重) / 安全行到达数。宽口径会偏袒压得越狠越好看的策略，所以两个都给，读结论用严格口径。",
	"- 策略：`safety-first`（现行）、`safety-first-nocooldown`（安全行不受 1.5s 同类冷却约束，仅为测量）、`fifo`（不抢占、不去重的基线）。",
	"- safety-first 的安全行延迟恒等于起播延迟：抢占就是下一拍出声，这是构造决定的，不是成绩。这一行的信息量在丢失率与打断数，不在延迟。",
	"",
	"## 对抗用例（固定回归）",
	"",
	"一条长回答播到一半，两条**不同**危险相隔 100ms 到达。任何一条没播出来都是失败。",
	"",
	"| 策略 | 危险 A | 危险 B | 真丢失 | 去重抑制 | 去重无同文已播 |",
	"|---|---|---|---|---|---|",
];
for (const metrics of adversarial.policies) {
	const record = (id: string) => metrics.records.find((item) => item.id === id);
	lines.push(`| ${metrics.policy} | ${record("adv-hazard-a")?.outcome ?? "-"} | ${record("adv-hazard-b")?.outcome ?? "-"} | ${metrics.safetyLost} | ${metrics.safetyDeduped} | ${metrics.safetyDedupedUnmatched} |`);
}

lines.push(
	"",
	"## 扫描结果",
	"",
	"| 危险/分 | 提问/分 | 起播延迟 | 策略 | 安全行丢失率 | 严格丢失率 | 真丢失 | 去重抑制 | 去重无近期同文 | 安全行均延迟 | 安全行最大延迟 | 被打断回答 | 抢占 |",
	"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const row of rows) {
	lines.push(`| ${row.hazardPerMin} | ${row.questionPerMin} | ${row.startDelayMs}ms | ${row.policy} | ${pct(row.lostRate)} | ${pct(row.strictLostRate)} | ${row.safetyLost} | ${row.safetyDeduped} | ${row.safetyDedupedUnmatched} | ${fmt(row.safetyDelayMeanMs)}ms | ${fmt(row.safetyDelayMaxMs)}ms | ${row.interruptedTask} | ${row.preemptions} |`);
}

lines.push(
	"",
	"## 帕累托前沿",
	"",
	"两个目标同时最小化：安全行平均延迟、被打断的回答数。只有前沿上的点值得讨论，被支配的格子可以直接淘汰。",
	"",
	"| 危险/分 | 提问/分 | 起播延迟 | 策略 | 安全行均延迟 | 被打断回答 | 安全行丢失率 | 严格丢失率 |",
	"|---|---|---|---|---|---|---|---|",
);
for (const row of front) {
	lines.push(`| ${row.hazardPerMin} | ${row.questionPerMin} | ${row.startDelayMs}ms | ${row.policy} | ${fmt(row.safetyDelayMeanMs)}ms | ${row.interruptedTask} | ${pct(row.lostRate)} | ${pct(row.strictLostRate)} |`);
}

const lost = rows.filter((row) => row.safetyLost > 0);
const strictLost = rows.filter((row) => row.safetyLostStrict > 0);
const suspicious = rows.filter((row) => row.safetyDedupedUnmatched > 0);

console.log(`网格 ${rows.length / POLICY_VARIANTS.length} 个格子 × ${seeds} 种子 × ${minutes} 分钟 × ${POLICY_VARIANTS.length} 个策略`);
console.log("\n对抗用例：");
for (const metrics of adversarial.policies) {
	console.log(`  [${metrics.policy}] 真丢失 ${metrics.safetyLost}，去重抑制 ${metrics.safetyDeduped}（无同文已播 ${metrics.safetyDedupedUnmatched}）`);
}
// Only the shipping schedule is held to "no hazard may be lost"; the baselines are expected to fail.
const production = adversarial.policies.find((metrics) => metrics.policy === safetyFirstPolicy.name);
if (production && production.safetyLost + production.safetyDedupedUnmatched > 0) {
	console.log(`  → 生产策略 ${production.policy} 下有一条不同的危险没被播出来，这是必须解释或修掉的，不是可接受的代价。`);
}
const byPolicy = new Map<string, CellRow[]>();
for (const row of rows) {
	const bucket = byPolicy.get(row.policy) ?? [];
	bucket.push(row);
	byPolicy.set(row.policy, bucket);
}
console.log("\n按策略汇总（严格口径）：");
for (const [policy, cells] of byPolicy) {
	const hit = cells.filter((row) => row.safetyLostStrict > 0).length;
	const worst = Math.max(...cells.map((row) => row.strictLostRate));
	const interrupted = cells.map((row) => row.interruptedTask);
	console.log(`  ${policy.padEnd(28)} 严格丢失>0 的格子 ${String(hit).padStart(2)}/${cells.length}，最高 ${pct(worst)}，打断 ${Math.min(...interrupted)}-${Math.max(...interrupted)}`);
}
if (lost.length > 0) {
	const worst = [...lost].sort((a, b) => b.lostRate - a.lostRate)[0]!;
	console.log(`\n宽口径：${lost.length} 个格子出现真丢失，最高在 危险${worst.hazardPerMin}/分·提问${worst.questionPerMin}/分·${worst.policy}：丢失率 ${pct(worst.lostRate)}`);
}
if (strictLost.length > 0) {
	const worst = [...strictLost].sort((a, b) => b.strictLostRate - a.strictLostRate)[0]!;
	console.log(`严格口径（无理由去重也算丢失）：${strictLost.length} 个格子有丢失，最高在 危险${worst.hazardPerMin}/分·提问${worst.questionPerMin}/分·${worst.policy}：${pct(worst.strictLostRate)}`);
}
if (suspicious.length > 0) {
	console.log(`${suspicious.length} 个格子出现“按重复抑制但近期没有播过同一句”，需要人工确认`);
}
console.log("\n帕累托前沿：");
for (const row of front) {
	console.log(`  危险${row.hazardPerMin}/分·提问${row.questionPerMin}/分·${row.startDelayMs}ms ${row.policy}：延迟 ${fmt(row.safetyDelayMeanMs)}ms，打断 ${row.interruptedTask}，丢失率 ${pct(row.lostRate)}`);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "sweep.json"), JSON.stringify({ parameters: { hazardRates, questionRates, startDelays, seeds, minutes }, rows, front: front.map((row) => `${row.hazardPerMin}/${row.questionPerMin}/${row.startDelayMs}/${row.policy}`) }, null, 2), "utf8");
await writeFile(join(outDir, "report.md"), lines.join("\n"), "utf8");
console.log(`\n输出目录：${outDir}`);
