/**
 * One safety look, independent of the HTTP layer.
 *
 * Both the phone-facing server and the offline replay need exactly this: send 1-3 frames plus the
 * user's motion to the hazard model, parse the verdict, and turn it into a speech candidate. Keeping
 * it out of the request handler is what makes the detector checkable at all — the same code that
 * runs while the user walks can be re-run over frames already on disk, without a phone in hand.
 *
 * The prompt and the reply parsing live in hazard-watch.ts; this file owns transport and the model
 * choice so a general observation model change cannot silently alter safety behaviour.
 */
import { HAZARD_PROMPT, hazardToUtterance, parseHazardReply, type HazardAssessment } from "./hazard-watch.js";
import type { Utterance } from "./response-arbiter.js";

export interface HazardFrame {
	/** Capture time. Used only to build stable evidence ids. */
	timestampMs: number;
	mimeType: string;
	dataBase64: string;
}

export interface HazardCheckResult {
	assessment: HazardAssessment;
	/** Null when the verdict was "clear". Nothing to say is not the same claim as "it is safe". */
	utterance: Utterance | null;
	/** Raw reply, kept so a bad verdict can be diagnosed after the fact. */
	raw: string;
	model: string;
	elapsedMs: number;
}

export interface HazardCheckOptions {
	model?: string;
	timeoutMs?: number;
}

/** The endpoint takes a short, close look; extra frames dilute attention instead of adding evidence. */
export const HAZARD_MAX_FRAMES = 3;
const HAZARD_MAX_TOKENS = 300;
const HAZARD_TIMEOUT_MS = 20_000;
const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export function hazardModel(): string {
	return process.env.QWEN_HAZARD_MODEL || process.env.QWEN_MODEL || "qwen3.8-flash";
}

/**
 * Motion is context, never evidence.
 *
 * It may make the prompt more suspicious of what is ahead, but it must not be able to upgrade an
 * unreadable view to "safe" and it must not be able to excuse a visible obstacle either. That is why
 * it is appended to the rules rather than replacing any of them.
 */
export function hazardTextPrompt(motionDescription: string | null): string {
	const motion = typeof motionDescription === "string" ? motionDescription.trim().slice(0, 600) : "";
	return motion ? `${HAZARD_PROMPT}\n\n用户此刻的运动状态：${motion}` : HAZARD_PROMPT;
}

export function hazardFrameIds(frames: HazardFrame[]): string[] {
	return frames.map((frame, index) => `hazard-${index + 1}-${Math.round(frame.timestampMs)}`);
}

/** Validate before spending a call, and validate the offline path with the same rules as the phone. */
export function assertHazardFrames(frames: HazardFrame[]): void {
	if (frames.length < 1 || frames.length > HAZARD_MAX_FRAMES) throw new Error(`hazard 需要 1 到 ${HAZARD_MAX_FRAMES} 张截图`);
	frames.forEach((frame, index) => {
		if (!SUPPORTED_MIME.has(frame.mimeType)) throw new Error(`截图 ${index + 1} 只支持 JPEG、PNG 或 WebP`);
		if (!frame.dataBase64) throw new Error(`截图 ${index + 1} 缺少图像数据`);
		if (!Number.isFinite(frame.timestampMs)) throw new Error(`截图 ${index + 1} 缺少时间戳`);
	});
}

export async function checkHazard(
	frames: HazardFrame[],
	motionDescription: string | null,
	options: HazardCheckOptions = {},
): Promise<HazardCheckResult> {
	assertHazardFrames(frames);
	const apiKey = process.env.QWEN_API_KEY;
	const baseUrl = process.env.QWEN_BASE_URL;
	if (!apiKey || !baseUrl) throw new Error("QWEN_API_KEY / QWEN_BASE_URL is not configured");
	const model = options.model ?? hazardModel();
	const content: Array<Record<string, unknown>> = [{ type: "text", text: hazardTextPrompt(motionDescription) }];
	for (const frame of frames) {
		content.push({ type: "image_url", image_url: { url: `data:${frame.mimeType};base64,${frame.dataBase64}` } });
	}
	const started = Date.now();
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({ model, messages: [{ role: "user", content }], temperature: 0, max_tokens: HAZARD_MAX_TOKENS }),
		// A hung request must not stall the safety clock: the caller is better served by a reported
		// failed look than by a check that never returns.
		signal: AbortSignal.timeout(options.timeoutMs ?? HAZARD_TIMEOUT_MS),
	});
	const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
	if (!response.ok) throw new Error(payload?.error?.message || `危险检测请求失败 (${response.status})`);
	const raw = payload.choices?.[0]?.message?.content ?? "";
	// Parsing throws on an unusable reply, and that is deliberate: a malformed verdict has to reach
	// the caller as a failed look rather than be coerced into silence that reads as "safe".
	const assessment = parseHazardReply(raw, hazardFrameIds(frames));
	return { assessment, utterance: hazardToUtterance(assessment, Date.now()), raw, model, elapsedMs: Date.now() - started };
}
