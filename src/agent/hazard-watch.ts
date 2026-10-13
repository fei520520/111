/**
 * HazardWatch: turns one look at the scene into a safety verdict.
 *
 * The duty of this system is to be the user's eyes, and its first job is that they do not get hurt.
 * That gives the thresholds an asymmetric bias: a missed danger is far worse than a needless
 * warning, so the prompt is written to warn when something *might* be in the way, and to treat an
 * unreadable view as a danger of its own rather than a reason to stay quiet.
 *
 * The counter-weight (also part of the duty) is alarm fatigue: if everything is a stop, the user
 * learns to ignore the warnings and the real one gets missed. Hence three severities, and silence
 * when the view is genuinely clear.
 */

export type HazardKind = "obstacle" | "step" | "traffic" | "unclear" | "none";
export type HazardSeverity = "halt" | "caution" | "clear";

export interface HazardAssessment {
	/** Stable identity of the danger; reused as the arbiter latch key so a persistent danger may be repeated. */
	id: string;
	kind: HazardKind;
	severity: HazardSeverity;
	/** Short spoken instruction, in Chinese, telling the user what to do. */
	speech: string;
	confidence: number;
	ttlMs: number;
	evidence: string[];
}

const HAZARD_KINDS: readonly HazardKind[] = ["obstacle", "step", "traffic", "unclear", "none"];
const HAZARD_SEVERITIES: readonly HazardSeverity[] = ["halt", "caution", "clear"];

const DEFAULT_SPEECH: Record<HazardSeverity, string> = {
	halt: "停下，前面有危险。",
	caution: "小心，前面可能有障碍。",
	clear: "",
};

const DEFAULT_TTL_MS: Record<HazardSeverity, number> = { halt: 8000, caution: 8000, clear: 0 };

export const HAZARD_PROMPT = `你是视障用户的"眼睛"，你唯一的职责是防止他受伤。
判断原则（宁可多提醒，也不要漏掉危险）：
- 只要画面里存在可能让他受伤的东西，就要报警，即使你不完全确定。
- 如果画面太暗、太模糊、或被挡住，导致你无法判断前方是否安全，这本身就是危险。
- 只有当你清楚确认前方安全时，才可以说安全。

kind（危险类型）：
- obstacle：前进路径上有障碍物（门、桌角、柱子、墙、杂物）
- step：脚下有高差（台阶、门槛、沟、斜坡）
- traffic：有车辆或移动物体正在接近
- unclear：画面无法判断
- none：未发现危险

severity（严重程度）：
- halt：必须立刻停下
- caution：可以继续，但要留意
- clear：安全

只输出一个 JSON 对象，不要 Markdown：
{"kind": "<类型>", "severity": "<程度>", "speech": "<对用户说的中文短句，15 字以内，要说明该怎么做>", "confidence": <0 到 1>, "reason": "<依据>"}`;

function asKind(value: unknown): HazardKind {
	// An unrecognised kind is treated as "unclear", never as "none": unknown must not read as safe.
	return typeof value === "string" && (HAZARD_KINDS as readonly string[]).includes(value) ? value as HazardKind : "unclear";
}

function asSeverity(value: unknown): HazardSeverity {
	return typeof value === "string" && (HAZARD_SEVERITIES as readonly string[]).includes(value) ? value as HazardSeverity : "caution";
}

/** Parse one model reply into an assessment. Throws when the reply is not usable at all. */
export function parseHazardReply(text: string, frameIds: string[]): HazardAssessment {
	const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	const parsed: unknown = JSON.parse(cleaned);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("hazard reply must be a JSON object");
	const row = parsed as Record<string, unknown>;
	const kind = asKind(row.kind);
	const severity = asSeverity(row.severity);
	const rawSpeech = typeof row.speech === "string" ? row.speech.trim().slice(0, 40) : "";
	const speech = rawSpeech || DEFAULT_SPEECH[severity];
	const confidence = typeof row.confidence === "number" ? Math.max(0, Math.min(1, row.confidence)) : 0.5;
	return { id: `hazard:${kind}`, kind, severity, speech, confidence, ttlMs: DEFAULT_TTL_MS[severity], evidence: frameIds.slice(0, 8) };
}

/**
 * Convert an assessment into a speech candidate, or null when there is nothing to say.
 *
 * `latchKey` is the stable danger id: while the same danger keeps being seen, the arbiter treats
 * each reminder as the same danger and throttles it by its own interval instead of the generic
 * cooldown, so walking toward the same step cannot silence the warning.
 */
export function hazardToUtterance(assessment: HazardAssessment, nowMs: number): import("./response-arbiter.js").Utterance | null {
	if (assessment.severity === "clear") return null;
	return {
		id: `${assessment.id}-${nowMs}`,
		kind: "safety",
		text: assessment.speech,
		createdAtMs: nowMs,
		ttlMs: assessment.ttlMs,
		source: "hazard",
		evidence: assessment.evidence,
		confidence: assessment.confidence,
		latchKey: assessment.id,
	};
}
