import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendFeedback, appendRun, appendSessionEvent, executeCase, writeSessionManifest, type CaseInput, type Feedback, type RouterDecision } from "./experiment.js";
import { analyzeActivityMotion } from "./activity-motion.js";
import { summarizeRealtimeMotion } from "./realtime-motion.js";
import type { MotionCalibration } from "./dead-reckoning.js";
import { VlmHarness, type AnalysisMode, type AttentionMode, type FrameRef, type MotionContext } from "./vlm-harness.js";
import { SceneAgent } from "./agent/scene-agent.js";
import { SceneChangeAgent } from "./agent/scene-change-agent.js";
import { RequestAgent } from "./agent/request-agent.js";

const PORT = Number(process.env.VLM_TRIAL_PORT || "8765");
/** LAN IPv4 captured by scripts/setup-lan-tls.ps1, used only for console hints. */
const LAN_IP_HINT = (() => {
	try {
		const path = resolve("run", "tls", "lan-ip.txt");
		return existsSync(path) ? readFileSync(path, "utf8").trim() : "<LAN-IP>";
	} catch {
		return "<LAN-IP>";
	}
})();
const GENERATED_PASSCODE = !process.env.VLM_TRIAL_PASSCODE;
const PASSCODE = process.env.VLM_TRIAL_PASSCODE || randomBytes(6).toString("base64url");
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RECORDING_BODY_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_RECORDING_FRAMES = 300;
const MAX_RECORDING_MOTION_SAMPLES = 100_000;
const MAX_RECORDING_BATCH_MOTION_SAMPLES = 5_000;
const MAX_RECORDING_IMAGE_BYTES = 120 * 1024 * 1024;
const MAX_RECORDING_DURATION_MS = 5 * 60_000;
const SESSION_REQUESTS_PER_MINUTE = 60;
const MAX_SESSIONS = 80;
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const sessions = new Map<string, { id: string; expiresAt: number; requests: number[] }>();
const harnesses = new Map<string, VlmHarness>();
const sceneAgents = new Map<string, SceneAgent>();
const sceneChangeAgents = new Map<string, SceneChangeAgent>();
const requestAgents = new Map<string, RequestAgent>();
const badLogins = new Map<string, number[]>();
const experimentRoot = resolve(process.env.VLM_EXPERIMENT_ROOT || "run/experiments");

type ActivityRecordingManifest = {
	schemaVersion: 1;
	recordingId: string;
	sessionId: string;
	status: "recording" | "completed";
	createdAt: string;
	startedAt: string;
	endedAt: string | null;
	targetDurationMs: number;
	durationMs: number | null;
	device: Record<string, unknown>;
	camera: Record<string, unknown>;
	sensorPermission: Record<string, unknown>;
	frameCount: number;
	motionSampleCount: number;
	imageBytes: number;
	inputDiagnostics: Record<string, unknown> | null;
	processedBatchIds: string[];
	analysis: Record<string, unknown> | null;
};

function activityRecordingDirectory(sessionId: string, recordingId: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordingId)) throw new Error("recordingId is invalid");
	return resolve(experimentRoot, sessionId, "activity-recordings", recordingId);
}

async function readActivityRecording(sessionId: string, recordingId: string): Promise<{ directory: string; manifest: ActivityRecordingManifest }> {
	const directory = activityRecordingDirectory(sessionId, recordingId);
	const manifest = JSON.parse(await readFile(resolve(directory, "capture.json"), "utf8")) as ActivityRecordingManifest;
	if (manifest.sessionId !== sessionId || manifest.recordingId !== recordingId) throw new Error("Recording does not belong to this session");
	return { directory, manifest };
}

function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	res.end(JSON.stringify(value));
}

function digest(value: string): Buffer { return createHash("sha256").update(value).digest(); }

async function bodyJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > maxBytes) throw new Error(`Request exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
		chunks.push(bytes);
	}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Request body must be a JSON object");
	return parsed as Record<string, unknown>;
}

function sameOrigin(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	const forwardedHost = req.headers["x-forwarded-host"];
	const validHosts = [req.headers.host, Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost].filter(Boolean);
	try { return validHosts.includes(new URL(origin).host); } catch { return false; }
}

function clientAddress(req: IncomingMessage): string {
	const cfAddress = req.headers["cf-connecting-ip"];
	if (typeof cfAddress === "string") return cfAddress;
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() || "unknown";
	return req.socket.remoteAddress ?? "unknown";
}

function authorized(req: IncomingMessage, res: ServerResponse) {
	const auth = req.headers.authorization;
	const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
	const session = sessions.get(token);
	if (!session || session.expiresAt < Date.now()) {
		if (token && session) harnesses.delete(session.id);
		if (token && session) sceneAgents.delete(session.id);
		if (token && session) sceneChangeAgents.delete(session.id);
		if (token) sessions.delete(token);
		json(res, 401, { error: "会话已过期，请重新输入口令" });
		return null;
	}
	const recent = session.requests.filter((timestamp) => Date.now() - timestamp < 60_000);
	if (recent.length >= SESSION_REQUESTS_PER_MINUTE) {
		json(res, 429, { error: "请求太频繁，请稍后再试" });
		return null;
	}
	session.requests = recent;
	return session;
}

function loginAllowed(ip: string): boolean {
	const recent = (badLogins.get(ip) ?? []).filter((timestamp) => Date.now() - timestamp < 15 * 60_000);
	badLogins.set(ip, recent);
	return recent.length < 8;
}

function recordFailedLogin(ip: string): void {
	const recent = (badLogins.get(ip) ?? []).filter((timestamp) => Date.now() - timestamp < 15 * 60_000);
	recent.push(Date.now());
	badLogins.set(ip, recent);
}

function rateLimit(session: { requests: number[] }): void {
	session.requests.push(Date.now());
}

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const ip = clientAddress(req);
	if (!loginAllowed(ip)) { json(res, 429, { error: "口令尝试次数过多，请 15 分钟后重试" }); return; }
	const input = await bodyJson(req);
	if (typeof input.passcode !== "string" || input.passcode.length > 256 || !timingSafeEqual(digest(input.passcode), digest(PASSCODE!))) {
		recordFailedLogin(ip);
		json(res, 401, { error: "口令不正确" });
		return;
	}
	const token = randomBytes(32).toString("base64url");
	const id = randomUUID();
	if (sessions.size >= MAX_SESSIONS) {
		for (const [key, value] of sessions) if (value.expiresAt < Date.now()) { sessions.delete(key); harnesses.delete(value.id); }
	}
	sessions.set(token, { id, expiresAt: Date.now() + SESSION_TTL_MS, requests: [] });
	json(res, 200, { token, sessionId: id, expiresInSeconds: SESSION_TTL_MS / 1000 });
}

/** Speech-to-text for phones without on-device recognition (e.g. HONOR/Android without Google services). */
const ASR_MODEL = process.env.QWEN_ASR_MODEL || "qwen3-asr-flash";

async function handleAsr(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const input = await bodyJson(req, MAX_RECORDING_BODY_BYTES);
	const audio = input.audioBase64;
	if (typeof audio !== "string" || audio.length === 0) throw new Error("缺少音频数据");
	const mimeType = typeof input.mimeType === "string" ? input.mimeType : "audio/wav";
	const dataUri = audio.startsWith("data:") ? audio : `data:${mimeType};base64,${audio}`;
	const format = ((mimeType.split("/")[1] || "wav").split(";")[0] || "wav").trim() || "wav";
	const baseUrl = process.env.QWEN_BASE_URL!.replace(/\/+$/, "");
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.QWEN_API_KEY}` },
		body: JSON.stringify({
			model: ASR_MODEL,
			messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: dataUri, format } }] }],
		}),
	});
	const result = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
	if (!response.ok) throw new Error(result?.error?.message || `语音识别请求失败 (${response.status})`);
	json(res, 200, { text: result.choices?.[0]?.message?.content?.trim() ?? "" });
}

/** Server-side text-to-speech fallback for phones without a usable local TTS voice. */
const TTS_MODEL = process.env.QWEN_TTS_MODEL || "qwen3-tts-flash";
const TTS_VOICE = process.env.QWEN_TTS_VOICE || "Cherry";

async function handleTts(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const input = await bodyJson(req);
	const text = input.text;
	if (typeof text !== "string" || !text.trim()) throw new Error("缺少要合成的文本");
	if (text.length > 600) throw new Error("文本过长（最多 600 字）");
	const origin = new URL(process.env.QWEN_BASE_URL!).origin;
	const endpoint = `${origin}/api/v1/services/aigc/multimodal-generation/generation`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.QWEN_API_KEY}` },
		body: JSON.stringify({ model: TTS_MODEL, input: { text, voice: TTS_VOICE, language_type: "Chinese" } }),
	});
	const result = await response.json().catch(() => ({})) as { output?: { audio?: { data?: string; url?: string } }; message?: string };
	const audio = result.output?.audio;
	if (!response.ok || !audio) throw new Error(result?.message || `语音合成失败 (${response.status})`);
	let base64 = audio.data ?? "";
	if (!base64 && audio.url) {
		const audioResponse = await fetch(audio.url);
		if (!audioResponse.ok) throw new Error("下载合成音频失败");
		base64 = Buffer.from(await audioResponse.arrayBuffer()).toString("base64");
	}
	if (!base64) throw new Error("语音合成未返回音频");
	json(res, 200, { audioBase64: base64, mimeType: "audio/wav" });
}

async function handleObserve(req: IncomingMessage, res: ServerResponse, session: { id: string; requests: number[] }): Promise<void> {
	const input = await bodyJson(req);
	if (typeof input.goal !== "string" || input.goal.length > 2000) throw new Error("目标文字必须是 2000 字以内的字符串");
	const routerDecision = parseRouterDecision(input.routerDecision);
	const inferredMode: AnalysisMode = input.goal.trim() ? "deep" : "monitor";
	const mode = input.mode === undefined ? inferredMode : input.mode;
	if (mode !== "monitor" && mode !== "deep") throw new Error("mode must be monitor or deep");
	if (mode === "deep" && !input.goal.trim()) throw new Error("深度模式需要填写一个目标或问题");
	const currentTaskGoal = harnesses.get(session.id)?.getWorkingState().activeTask.goal;
	const validAttentionModes: AttentionMode[] = ["quiet", "awareness", "task", "explore"];
	const requestedAttention = input.attentionMode;
	if (requestedAttention !== undefined && !validAttentionModes.includes(requestedAttention as AttentionMode)) throw new Error("attentionMode must be quiet, awareness, task, or explore");
	const attentionMode: AttentionMode = (requestedAttention as AttentionMode | undefined)
		?? (input.goal.trim() || currentTaskGoal ? "task" : mode === "deep" ? "explore" : "quiet");
	if (attentionMode === "task" && !input.goal.trim() && !currentTaskGoal) throw new Error("task attention mode requires an active goal");
	if (input.userInitiated !== undefined && typeof input.userInitiated !== "boolean") throw new Error("userInitiated must be boolean");
	const userInitiated = input.userInitiated as boolean | undefined
		?? (mode === "deep" || ["manual_check", "user_request"].includes(routerDecision?.triggerReason ?? ""));
	if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 8) throw new Error("一次分析需要 1 到 8 张截图");
	const runId = randomUUID();
	const stagingDir = resolve("run/mobile-staging", session.id, runId);
	await mkdir(stagingDir, { recursive: true });
	const frames: CaseInput["frames"] = [];
	try {
		for (const [index, item] of input.frames.entries()) {
			if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`截图 ${index + 1} 格式错误`);
			const row = item as Record<string, unknown>;
			if (typeof row.dataBase64 !== "string" || typeof row.timestampMs !== "number" || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.dataBase64)) throw new Error(`截图 ${index + 1} 缺少有效图像数据或时间戳`);
			const mime = row.mimeType;
			const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : null;
			if (!extension) throw new Error("截图只支持 JPEG、PNG 或 WebP");
			const bytes = Buffer.from(row.dataBase64, "base64");
			if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("每张截图最大为 1.5 MB");
			const path = resolve(stagingDir, `frame-${String(index + 1).padStart(2, "0")}${extension}`);
			const rawQuality = row.quality;
			let quality: CaseInput["frames"][number]["quality"];
			if (rawQuality !== undefined) {
				if (typeof rawQuality !== "object" || rawQuality === null || Array.isArray(rawQuality)) throw new Error(`截图 ${index + 1} quality 格式错误`);
				const qualityRow = rawQuality as Record<string, unknown>;
				if (typeof qualityRow.sharpness !== "number" || qualityRow.sharpness < 0 || qualityRow.sharpness > 1 || typeof qualityRow.exposure !== "number" || qualityRow.exposure < 0 || qualityRow.exposure > 1) throw new Error(`截图 ${index + 1} quality 数值无效`);
				if (qualityRow.visualSignature !== undefined && (typeof qualityRow.visualSignature !== "string" || qualityRow.visualSignature.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(qualityRow.visualSignature))) throw new Error(`截图 ${index + 1} visualSignature 无效`);
				quality = { sharpness: qualityRow.sharpness, exposure: qualityRow.exposure, ...(typeof qualityRow.visualSignature === "string" ? { visualSignature: qualityRow.visualSignature } : {}) };
			}
			const motionContext = parseMotionContext(row.motionContext);
			await writeFile(path, bytes, { flag: "wx" });
			frames.push({ id: `mobile-${index + 1}-${Math.round(row.timestampMs)}`, timestampMs: Math.round(row.timestampMs), path, ...(quality ? { quality } : {}), ...(motionContext ? { motionContext } : {}) });
		}
		const caseId = `mobile-${session.requests.length}-${Date.now()}`;
		await writeSessionManifest(experimentRoot, session.id, "mobile-camera-trial");
		let harness = harnesses.get(session.id);
		if (!harness) {
			harness = new VlmHarness();
			if (harnesses.size >= MAX_SESSIONS) harnesses.delete(harnesses.keys().next().value!);
			harnesses.set(session.id, harness);
		}
		const previousTask = harness.getWorkingState().activeTask;
		const previousWatch = harness.getWorkingState().activeWatch;
		const explicitGoal = mode === "deep" ? input.goal.trim() : null;
		if (explicitGoal && (previousTask.status !== "active" || previousTask.goal !== explicitGoal)) {
			if (previousWatch.status !== "idle") await appendSessionEvent(experimentRoot, session.id, { type: "watch_stopped", goal: previousWatch.condition, details: { reason: "task_started" } });
			if (previousTask.status === "active") {
				await appendSessionEvent(experimentRoot, session.id, { type: "task_stopped", goal: previousTask.goal, details: { reason: "replaced_by_new_goal" } });
			}
			await appendSessionEvent(experimentRoot, session.id, { type: "task_started", goal: explicitGoal });
		}
		const goal = explicitGoal ?? (previousTask.status === "active" ? previousTask.goal : null);
		const rawMotionSamples = Array.isArray(input.motionSamples) ? (input.motionSamples as Array<Record<string, unknown>>) : [];
		if (rawMotionSamples.length > 2_000) throw new Error("运动样本过多（每次最多 2000 条）");
		const motionReport = rawMotionSamples.length >= 30 ? summarizeRealtimeMotion(rawMotionSamples, 10_000, parseMotionCalibration(input.motionCalibration), typeof input.motionWindowEndMs === "number" ? input.motionWindowEndMs : Date.now()) : undefined;
		const motionDescription = typeof input.motionDescription === "string" ? input.motionDescription.slice(0, 1200) : undefined;
		const record = await executeCase(session.id, { caseId, goal, mode, attentionMode, userInitiated: Boolean(userInitiated), ...(routerDecision ? { routerDecision } : {}), ...(motionReport ? { motionReport } : {}), ...(motionDescription ? { motionDescription } : {}), frames }, harness);
		if (rawMotionSamples.length) {
			// Every observation keeps its raw IMU so it can be re-analysed / re-inferred later.
			const motionDir = resolve(experimentRoot, session.id, "inputs", record.runId);
			await mkdir(motionDir, { recursive: true });
			await writeFile(resolve(motionDir, "motion.json"), JSON.stringify({ calibration: input.motionCalibration ?? null, samples: rawMotionSamples }), "utf8");
			record.input.motionRawPath = `inputs/${record.runId}/motion.json`;
		}
		const runPath = await appendRun(experimentRoot, record);
		if (record.status === "error" || !record.result) {
			json(res, 502, { runId: record.runId, error: record.error?.message ?? "VLM 调用失败", runPath });
			return;
		}
		json(res, 200, {
			runId: record.runId, sessionId: session.id, model: record.result.model, mode: record.result.mode, changed: record.result.changed,
			thinkingEnabled: record.result.thinkingEnabled, inputWindowMs: record.result.inputWindowMs, decision: record.result.decision,
			policyAction: record.result.policyAction, response: record.result.response, decisionGuard: record.result.decisionGuard, latencyMs: record.result.latencyMs,
			attentionMode: record.result.attentionMode, inferenceBudget: record.result.inferenceBudget, userInitiated: record.result.userInitiated, frameGate: record.result.frameGate,
			visualMemoryFrameIds: record.result.visualMemoryFrameIds,
			task: record.result.state.activeTask,
			watch: record.result.state.activeWatch,
			observations: record.result.delta.observations, rawPerception: { changed: record.result.delta.changed, candidateResponse: record.result.delta.response },
			policyDecision: { decision: record.result.decision, guard: record.result.decisionGuard },
			saved: true,
		});
	} finally {
		for (const frame of frames) { try { await unlink(frame.path); } catch { /* already moved or absent */ } }
	}
}

async function handleActivityRecordingStart(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req);
	const targetDurationMs = finiteNumber(input.targetDurationMs, "targetDurationMs", 10_000, MAX_RECORDING_DURATION_MS);
	await writeSessionManifest(experimentRoot, session.id, "mobile-camera-trial");
	const objectOrEmpty = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
	const rawDevice = objectOrEmpty(input.device);
	const rawCamera = objectOrEmpty(input.camera);
	const rawPermission = objectOrEmpty(input.sensorPermission);
	const device = {
		userAgent: typeof rawDevice.userAgent === "string" ? rawDevice.userAgent.slice(0, 512) : null,
		platform: typeof rawDevice.platform === "string" ? rawDevice.platform.slice(0, 128) : null,
		screenWidth: typeof rawDevice.screenWidth === "number" && Number.isFinite(rawDevice.screenWidth) ? Math.round(rawDevice.screenWidth) : null,
		screenHeight: typeof rawDevice.screenHeight === "number" && Number.isFinite(rawDevice.screenHeight) ? Math.round(rawDevice.screenHeight) : null,
		devicePixelRatio: typeof rawDevice.devicePixelRatio === "number" && Number.isFinite(rawDevice.devicePixelRatio) ? rawDevice.devicePixelRatio : null,
	};
	const camera = {
		width: typeof rawCamera.width === "number" && Number.isFinite(rawCamera.width) ? Math.round(rawCamera.width) : null,
		height: typeof rawCamera.height === "number" && Number.isFinite(rawCamera.height) ? Math.round(rawCamera.height) : null,
		captureIntervalMs: typeof rawCamera.captureIntervalMs === "number" && Number.isFinite(rawCamera.captureIntervalMs) ? rawCamera.captureIntervalMs : null,
	};
	const recordingId = randomUUID();
	const directory = activityRecordingDirectory(session.id, recordingId);
	await mkdir(directory, { recursive: true });
	await writeFile(resolve(directory, "frames.jsonl"), "", { flag: "wx" });
	await writeFile(resolve(directory, "motion.jsonl"), "", { flag: "wx" });
	const createdAt = new Date().toISOString();
	const manifest: ActivityRecordingManifest = {
		schemaVersion: 1, recordingId, sessionId: session.id, status: "recording", createdAt,
		startedAt: typeof input.startedAt === "string" ? input.startedAt.slice(0, 80) : createdAt,
		endedAt: null, targetDurationMs, durationMs: null, device, camera,
		sensorPermission: {
			deviceMotion: typeof rawPermission.deviceMotion === "string" ? rawPermission.deviceMotion.slice(0, 64) : "unknown",
			deviceOrientation: typeof rawPermission.deviceOrientation === "string" ? rawPermission.deviceOrientation.slice(0, 64) : "unknown",
		},
		frameCount: 0, motionSampleCount: 0, imageBytes: 0, inputDiagnostics: null, processedBatchIds: [], analysis: null,
	};
	await writeFile(resolve(directory, "capture.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
	await appendSessionEvent(experimentRoot, session.id, { type: "activity_recording_started", details: { recordingId, targetDurationMs, device, camera } });
	json(res, 200, { recordingId, targetDurationMs });
}

function parseRecordingMotionSample(value: unknown, index: number, targetDurationMs: number): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`motionSamples[${index}] must be an object`);
	const row = value as Record<string, unknown>;
	if (row.kind !== "motion" && row.kind !== "orientation") throw new Error(`motionSamples[${index}].kind is invalid`);
	const timeMs = finiteNumber(row.timeMs, `motionSamples[${index}].timeMs`, 0, targetDurationMs + 10_000);
	if (row.kind === "motion") {
		const intervalMs = row.intervalMs === null || row.intervalMs === undefined ? null : finiteNumber(row.intervalMs, `motionSamples[${index}].intervalMs`, 0, 10_000);
		return {
			kind: "motion", timeMs, intervalMs,
			acceleration: finiteVector(row.acceleration),
			accelerationIncludingGravity: finiteVector(row.accelerationIncludingGravity),
			rotationRate: finiteRotationRate(row.rotationRate),
		};
	}
	const angle = (field: string): number | null => row[field] === null || row[field] === undefined ? null : finiteNumber(row[field], `motionSamples[${index}].${field}`, -360, 360);
	if (row.absolute !== null && row.absolute !== undefined && typeof row.absolute !== "boolean") throw new Error(`motionSamples[${index}].absolute must be boolean or null`);
	return { kind: "orientation", timeMs, alpha: angle("alpha"), beta: angle("beta"), gamma: angle("gamma"), absolute: row.absolute ?? null };
}

async function handleActivityRecordingBatch(req: IncomingMessage, res: ServerResponse, session: { id: string }, recordingId: string): Promise<void> {
	const input = await bodyJson(req, MAX_RECORDING_BODY_BYTES);
	if (typeof input.batchId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.batchId)) throw new Error("batchId is invalid");
	if (!Array.isArray(input.frames) || input.frames.length > 10) throw new Error("每批最多保存 10 张截图");
	if (!Array.isArray(input.motionSamples) || input.motionSamples.length > MAX_RECORDING_BATCH_MOTION_SAMPLES) throw new Error("每批运动读数超过限制");
	if (input.frames.length === 0 && input.motionSamples.length === 0) throw new Error("采集批次为空");
	const { directory, manifest } = await readActivityRecording(session.id, recordingId);
	if (manifest.status !== "recording") throw new Error("这段活动已经结束");
	if (manifest.processedBatchIds.includes(input.batchId)) {
		json(res, 200, { saved: true, duplicate: true, frameCount: manifest.frameCount, motionSampleCount: manifest.motionSampleCount });
		return;
	}
	if (manifest.frameCount + input.frames.length > MAX_RECORDING_FRAMES) throw new Error(`单段记录最多 ${MAX_RECORDING_FRAMES} 张截图`);
	if (manifest.motionSampleCount + input.motionSamples.length > MAX_RECORDING_MOTION_SAMPLES) throw new Error("本段运动传感器读数超过存储上限");
	const frameRows: Array<Record<string, unknown>> = [];
	const imageWrites: Array<{ path: string; bytes: Buffer }> = [];
	let addedImageBytes = 0;
	for (const [batchIndex, item] of input.frames.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`frames[${batchIndex}] must be an object`);
		const row = item as Record<string, unknown>;
		const expectedIndex = manifest.frameCount + batchIndex;
		if (row.frameIndex !== expectedIndex) throw new Error(`frames[${batchIndex}].frameIndex must be ${expectedIndex}`);
		if (row.mimeType !== "image/jpeg" || typeof row.dataBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.dataBase64)) throw new Error(`frames[${batchIndex}] must contain a valid JPEG`);
		const bytes = Buffer.from(row.dataBase64, "base64");
		if (bytes.length < 100 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error(`frames[${batchIndex}] is not a valid JPEG or exceeds 1.5 MB`);
		addedImageBytes += bytes.length;
		const timeMs = finiteNumber(row.timeMs, `frames[${batchIndex}].timeMs`, 0, manifest.targetDurationMs + 10_000);
		const timestampMs = finiteNumber(row.timestampMs, `frames[${batchIndex}].timestampMs`, 0);
		const width = finiteNumber(row.width, `frames[${batchIndex}].width`, 1, 4096);
		const height = finiteNumber(row.height, `frames[${batchIndex}].height`, 1, 4096);
		const qualityRow = typeof row.quality === "object" && row.quality !== null && !Array.isArray(row.quality) ? row.quality as Record<string, unknown> : {};
		const quality = typeof qualityRow.sharpness === "number" && Number.isFinite(qualityRow.sharpness) && qualityRow.sharpness >= 0 && qualityRow.sharpness <= 1
			&& typeof qualityRow.exposure === "number" && Number.isFinite(qualityRow.exposure) && qualityRow.exposure >= 0 && qualityRow.exposure <= 1
			? { sharpness: qualityRow.sharpness, exposure: qualityRow.exposure } : undefined;
		const motionContext = parseMotionContext(row.motionContext);
		const filename = `frame-${String(expectedIndex).padStart(5, "0")}.jpg`;
		imageWrites.push({ path: resolve(directory, filename), bytes });
		frameRows.push({ frameIndex: expectedIndex, id: `recording-${recordingId}-${expectedIndex}`, timeMs, timestampMs, width, height, path: filename, byteLength: bytes.byteLength, ...(quality ? { quality } : {}), ...(motionContext ? { motionContext } : {}) });
	}
	if (manifest.imageBytes + addedImageBytes > MAX_RECORDING_IMAGE_BYTES) throw new Error("本段图片总量超过 120 MB，请缩短记录时长");
	const motionRows = input.motionSamples.map((item, index) => parseRecordingMotionSample(item, index, manifest.targetDurationMs));
	for (const image of imageWrites) await writeFile(image.path, image.bytes, { flag: "wx" });
	if (frameRows.length) await appendFile(resolve(directory, "frames.jsonl"), `${frameRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
	if (motionRows.length) await appendFile(resolve(directory, "motion.jsonl"), `${motionRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
	manifest.frameCount += frameRows.length;
	manifest.motionSampleCount += motionRows.length;
	manifest.imageBytes += addedImageBytes;
	manifest.processedBatchIds.push(input.batchId);
	await writeFile(resolve(directory, "capture.json"), JSON.stringify(manifest, null, 2), "utf8");
	json(res, 200, { saved: true, frameCount: manifest.frameCount, motionSampleCount: manifest.motionSampleCount, imageBytes: manifest.imageBytes });
}

async function summarizeActivityRecording(directory: string, manifest: ActivityRecordingManifest): Promise<Record<string, unknown>> {
	const frameRows = (await readFile(resolve(directory, "frames.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	const motionRows = (await readFile(resolve(directory, "motion.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	const deviceMotion = motionRows.filter((row) => row.kind === "motion");
	const orientation = motionRows.filter((row) => row.kind === "orientation");
	const gyroRows = deviceMotion.filter((row) => {
		const rate = row.rotationRate as { alpha: number | null; beta: number | null; gamma: number | null } | null;
		return Boolean(rate && Object.values(rate).some((value) => value !== null));
	});
	const accelerationRows = deviceMotion.filter((row) => {
		const acceleration = row.acceleration as { x: number | null; y: number | null; z: number | null } | null;
		return Boolean(acceleration && Object.values(acceleration).some((value) => value !== null));
	});
	const orientationRows = orientation.filter((row) => [row.alpha, row.beta, row.gamma].some((value) => typeof value === "number"));
	const gyroMagnitudes = gyroRows.map((row) => {
		const rate = row.rotationRate as { alpha: number | null; beta: number | null; gamma: number | null };
		return Math.hypot(rate.alpha ?? 0, rate.beta ?? 0, rate.gamma ?? 0);
	});
	const accelerations = accelerationRows.map((row) => row.acceleration as { x: number | null; y: number | null; z: number | null })
		.filter((value) => [value.x, value.y, value.z].every((component) => component !== null))
		.map((value) => Math.hypot(value.x!, value.y!, value.z!));
	const frameTimes = frameRows.map((row) => row.timeMs as number).filter(Number.isFinite).sort((a, b) => a - b);
	const median = (values: number[]): number | null => {
		if (!values.length) return null;
		const sorted = [...values].sort((a, b) => a - b);
		return roundTo(sorted[Math.floor(sorted.length / 2)]!, 1);
	};
	const frameIntervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]!);
	const accelerationRms = accelerations.length ? Math.sqrt(accelerations.reduce((sum, value) => sum + value * value, 0) / accelerations.length) : null;
	return {
		frameCount: frameRows.length,
		frameIntervalMedianMs: median(frameIntervals),
		averageCaptureFps: manifest.durationMs ? roundTo(frameRows.length * 1000 / manifest.durationMs, 2) : null,
		motionSampleCount: motionRows.length,
		deviceMotionSampleCount: deviceMotion.length,
		orientationSampleCount: orientation.length,
		gyroSampleCount: gyroRows.length,
		accelerationSampleCount: accelerationRows.length,
		orientationValueCount: orientationRows.length,
		maxRotationRateDps: gyroMagnitudes.length ? roundTo(gyroMagnitudes.reduce((maximum, value) => Math.max(maximum, value), 0), 2) : null,
		linearAccelerationRmsMps2: accelerationRms === null ? null : roundTo(accelerationRms, 3),
		imageBytes: manifest.imageBytes,
		absoluteDisplacementMeasured: false,
		note: "浏览器采集的是加速度、角速度和姿态读数；没有直接的位置/位移测量，积分估算会有漂移。",
	};
}

async function handleActivityRecordingStop(req: IncomingMessage, res: ServerResponse, session: { id: string }, recordingId: string): Promise<void> {
	await bodyJson(req);
	const { directory, manifest } = await readActivityRecording(session.id, recordingId);
	if (manifest.status === "recording") {
		manifest.status = "completed";
		manifest.endedAt = new Date().toISOString();
		manifest.durationMs = Math.min(manifest.targetDurationMs, Math.max(0, Date.parse(manifest.endedAt) - Date.parse(manifest.createdAt)));
		manifest.inputDiagnostics = await summarizeActivityRecording(directory, manifest);
		await writeFile(resolve(directory, "capture.json"), JSON.stringify(manifest, null, 2), "utf8");
		await appendSessionEvent(experimentRoot, session.id, {
			type: "activity_recording_completed",
			details: { recordingId, durationMs: manifest.durationMs, frameCount: manifest.frameCount, motionSampleCount: manifest.motionSampleCount, imageBytes: manifest.imageBytes, inputDiagnostics: manifest.inputDiagnostics },
		});
	}
	json(res, 200, { saved: true, recording: { recordingId, status: manifest.status, durationMs: manifest.durationMs ?? 0, frameCount: manifest.frameCount, motionSampleCount: manifest.motionSampleCount, imageBytes: manifest.imageBytes, inputDiagnostics: manifest.inputDiagnostics } });
}

async function handleActivityRecordingAnalyze(req: IncomingMessage, res: ServerResponse, session: { id: string }, recordingId: string): Promise<void> {
	const input = await bodyJson(req);
	if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.length > 1000)) throw new Error("分析重点最多 1000 个字符");
	const { directory, manifest } = await readActivityRecording(session.id, recordingId);
	if (manifest.status !== "completed") throw new Error("请先结束并保存这段记录");
	if (manifest.frameCount < 1) throw new Error("这段记录没有可分析的截图");
	const rows = (await readFile(resolve(directory, "frames.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	const motionRows = (await readFile(resolve(directory, "motion.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	const motionAnalysis = analyzeActivityMotion(motionRows, rows, manifest.durationMs ?? 0);
	const rowsById = new Map(rows.map((row) => [String(row.id), row]));
	const selectedRows = motionAnalysis.selectedFrameIds.map((id) => rowsById.get(id)).filter((row): row is Record<string, unknown> => Boolean(row));
	const frames: CaseInput["frames"] = selectedRows.map((row) => {
		const quality = typeof row.quality === "object" && row.quality !== null ? row.quality as NonNullable<CaseInput["frames"][number]["quality"]> : undefined;
		return {
			id: String(row.id), timestampMs: Number(row.timestampMs), path: resolve(directory, String(row.path)),
			...(quality ? { quality } : {}),
		};
	});
	const goal = typeof input.goal === "string" && input.goal.trim()
		? input.goal.trim()
		: "总结这段记录中能从连续画面和预先提取的位置、摄像头朝向、行进方向变化状态观察到的活动与场景变化；明确区分画面事实、运动推测和不确定项，并提出有助于后续测试的改进方向。";
	const record = await executeCase(session.id, {
		caseId: `activity-recording-${recordingId}`, goal, mode: "deep", inferenceBudget: "deep", attentionMode: "explore", userInitiated: true, frames, motionTimeline: motionAnalysis.segments, maxOutputTokens: 3072,
	}, new VlmHarness());
	const runPath = await appendRun(experimentRoot, record);
	if (record.status === "error" || !record.result) {
		json(res, 502, { runId: record.runId, error: record.error?.message ?? "VLM 调用失败", runPath });
		return;
	}
	const run = record.result;
	const selectedFrameIds = frames.map((frame) => frame.id);
	const analysis = { runId: record.runId, analyzedAt: new Date().toISOString(), selectedFrameIds, motionTimeline: motionAnalysis.segments, motionCalibration: motionAnalysis.calibration, motionTrajectorySummary: motionAnalysis.trajectorySummary, translationSpans: motionAnalysis.translationSpans, turnEvents: motionAnalysis.turnEvents, runPath };
	manifest.analysis = analysis;
	await writeFile(resolve(directory, "capture.json"), JSON.stringify(manifest, null, 2), "utf8");
	await appendSessionEvent(experimentRoot, session.id, { type: "activity_recording_analyzed", details: { recordingId, ...analysis } });
	json(res, 200, {
		runId: record.runId, sessionId: session.id, model: run.model, mode: run.mode, changed: run.changed,
		thinkingEnabled: run.thinkingEnabled, inputWindowMs: run.inputWindowMs, decision: run.decision,
		policyAction: run.policyAction, response: run.response, decisionGuard: run.decisionGuard, latencyMs: run.latencyMs,
		attentionMode: run.attentionMode, inferenceBudget: run.inferenceBudget, userInitiated: true, frameGate: run.frameGate,
		visualMemoryFrameIds: run.visualMemoryFrameIds, task: null, watch: null, observations: run.delta.observations,
		rawPerception: { changed: run.delta.changed, candidateResponse: run.delta.response },
		policyDecision: { decision: run.decision, guard: run.decisionGuard }, saved: true,
		selectedFrameCount: frames.length, frameMotionContexts: [], motionTimeline: motionAnalysis.segments,
		motionCalibration: motionAnalysis.calibration, motionTrajectorySummary: motionAnalysis.trajectorySummary,
		translationSpans: motionAnalysis.translationSpans, turnEvents: motionAnalysis.turnEvents,
	});
}

async function handleVioBurst(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const input = await bodyJson(req, MAX_RECORDING_BODY_BYTES);
	const id = randomUUID();
	const directory = resolve(experimentRoot, "vio-debug", id);
	await mkdir(directory, { recursive: true });
	await writeFile(resolve(directory, "burst.json"), JSON.stringify(input), "utf8");
	json(res, 200, { saved: true, id, frameCount: Array.isArray(input.frames) ? input.frames.length : 0 });
}

async function handleLiveBatch(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req, MAX_RECORDING_BODY_BYTES);
	const frames = Array.isArray(input.frames) ? input.frames as Array<Record<string, unknown>> : [];
	const motionSamples = Array.isArray(input.motionSamples) ? input.motionSamples as Array<Record<string, unknown>> : [];
	const directory = resolve(experimentRoot, session.id, "live");
	await mkdir(directory, { recursive: true });
	let frameCount = 0;
	const frameIndex: Array<Record<string, unknown>> = [];
	for (const item of frames) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		if (typeof row.dataBase64 !== "string" || typeof row.timestampMs !== "number" || !/^[A-Za-z0-9+/]*={0,2}$/.test(row.dataBase64)) continue;
		const bytes = Buffer.from(row.dataBase64, "base64");
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
		const file = `frame-${Math.round(row.timestampMs)}.jpg`;
		await writeFile(resolve(directory, file), bytes);
		frameIndex.push({ timestampMs: Math.round(row.timestampMs), path: file, width: row.width ?? null, height: row.height ?? null, quality: row.quality ?? null });
		frameCount++;
	}
	if (frameIndex.length) await appendFile(resolve(directory, "frames.jsonl"), frameIndex.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
	if (motionSamples.length) await appendFile(resolve(directory, "motion.jsonl"), motionSamples.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
	json(res, 200, { saved: true, frameCount, motionSampleCount: motionSamples.length });
}

async function handleScene(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req);
	if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 6) throw new Error("scene 需要 1 到 6 张截图");
	const motionDescription = typeof input.motionDescription === "string" ? input.motionDescription.slice(0, 1200) : null;
	const runId = randomUUID();
	const stagingDir = resolve("run/mobile-staging", session.id, `scene-${runId}`);
	await mkdir(stagingDir, { recursive: true });
	const frames: FrameRef[] = [];
	for (const [index, item] of input.frames.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`截图 ${index + 1} 格式错误`);
		const row = item as Record<string, unknown>;
		if (typeof row.dataBase64 !== "string" || typeof row.timestampMs !== "number") throw new Error(`截图 ${index + 1} 缺少图像或时间戳`);
		const mime = row.mimeType;
		const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : null;
		if (!extension) throw new Error("截图只支持 JPEG、PNG 或 WebP");
		const bytes = Buffer.from(row.dataBase64, "base64");
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("每张截图最大为 1.5 MB");
		const path = resolve(stagingDir, `frame-${String(index + 1).padStart(2, "0")}${extension}`);
		await writeFile(path, bytes, { flag: "wx" });
		frames.push({ id: `scene-${index + 1}-${Math.round(row.timestampMs)}`, timestampMs: Math.round(row.timestampMs), path });
	}
	let agent = sceneAgents.get(session.id);
	if (!agent) {
		agent = new SceneAgent(resolve(experimentRoot, session.id, "scene-memory"), resolve(experimentRoot, session.id, "place-memory.json"));
		if (sceneAgents.size >= MAX_SESSIONS) sceneAgents.delete(sceneAgents.keys().next().value!);
		sceneAgents.set(session.id, agent);
	}
	const result = await agent.observe(frames, motionDescription);
	// Kept as a safety net: the scene-change agent keeps one baseline per scene,
	// so a new place simply has no baseline yet and returning to a known scene
	// reuses its stored baseline (so changes that happened while away are found).
	await appendSessionEvent(experimentRoot, session.id, { type: "scene_recorded", details: { sceneId: result.sceneId, label: result.label, isNew: result.isNew, sameAsPrevious: result.sameAsPrevious, revisited: result.revisited, matchedSceneId: result.matchedSceneId, changed: result.changed, confidence: result.confidence, provisional: result.provisional, decidedBy: result.decidedBy, match: result.match, motion: motionDescription } });
	json(res, 200, { sceneId: result.sceneId, identityStatus: result.identityStatus, label: result.label, summary: result.summary, objects: result.objects, anchors: result.anchors, localRelations: result.localRelations, identityReason: result.identityReason, isNew: result.isNew, sameAsPrevious: result.sameAsPrevious, revisited: result.revisited, matchedSceneId: result.matchedSceneId, changed: result.changed, confidence: result.confidence, provisional: result.provisional, decidedBy: result.decidedBy, match: result.match, frameIds: result.frameIds, scene: agent.getState() });
}

async function handleSceneChange(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req);
	if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 6) throw new Error("scene-change 需要 1 到 6 张截图");
	const motionDescription = typeof input.motionDescription === "string" ? input.motionDescription.slice(0, 1200) : null;
	const sceneLabel = typeof input.sceneLabel === "string" ? input.sceneLabel.slice(0, 120) : null;
	const sceneId = typeof input.sceneId === "string" ? input.sceneId.slice(0, 60) : null;
	const runId = randomUUID();
	const stagingDir = resolve("run/mobile-staging", session.id, `scene-change-${runId}`);
	await mkdir(stagingDir, { recursive: true });
	const frames: FrameRef[] = [];
	for (const [index, item] of input.frames.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`截图 ${index + 1} 格式错误`);
		const row = item as Record<string, unknown>;
		if (typeof row.dataBase64 !== "string" || typeof row.timestampMs !== "number") throw new Error(`截图 ${index + 1} 缺少图像或时间戳`);
		const mime = row.mimeType;
		const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : null;
		if (!extension) throw new Error("截图只支持 JPEG、PNG 或 WebP");
		const bytes = Buffer.from(row.dataBase64, "base64");
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("每张截图最大为 1.5 MB");
		const path = resolve(stagingDir, `frame-${String(index + 1).padStart(2, "0")}${extension}`);
		await writeFile(path, bytes, { flag: "wx" });
		frames.push({ id: `scene-change-${index + 1}-${Math.round(row.timestampMs)}`, timestampMs: Math.round(row.timestampMs), path });
	}
	let agent = sceneChangeAgents.get(session.id);
	if (!agent) {
		agent = new SceneChangeAgent(resolve(experimentRoot, session.id, "change-staging"));
		if (sceneChangeAgents.size >= MAX_SESSIONS) sceneChangeAgents.delete(sceneChangeAgents.keys().next().value!);
		sceneChangeAgents.set(session.id, agent);
	}
	// Use the scene's canonical first view as the change baseline, so the very
	// first comparison is against the pre-change state.
	const scene = sceneAgents.get(session.id)?.getState().scenes.find((entry) => entry.id === (sceneId ?? ""));
	const sceneBaselinePath = scene?.frames[0]?.path ?? null;
	const result = await agent.observe(frames, motionDescription, sceneId, sceneLabel, sceneBaselinePath);
	if (result.changed) await appendSessionEvent(experimentRoot, session.id, { type: "scene_changed", details: { sceneId: result.sceneId, what: result.what, candidateUtterance: result.candidateUtterance, confidence: result.confidence, via: result.via, detection: result.detection } });
	json(res, 200, { changed: result.changed, what: result.what, candidateUtterance: result.candidateUtterance, confidence: result.confidence, sceneId: result.sceneId, via: result.via, detection: result.detection, reason: result.reason, frameIds: result.frameIds, baselineSet: result.baselineSet, state: agent.getState() });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req);
	const action = typeof input.action === "string" ? input.action : "step";
	let agent = requestAgents.get(session.id);
	if (!agent) {
		agent = new RequestAgent(() => {
			const sceneState = sceneAgents.get(session.id)?.getState();
			const changeState = sceneChangeAgents.get(session.id)?.getState();
			return {
				currentSceneId: sceneState?.currentSceneId ?? null,
				scenes: (sceneState?.scenes ?? []).map((scene) => ({ id: scene.id, label: scene.label, summary: scene.summary, objects: scene.objects, visits: scene.visits.length, lastSeenMs: scene.lastVisitedAt })),
				visitedOrder: (sceneState?.history ?? []).map((entry) => entry.sceneId),
				transitions: (sceneState?.transitions ?? []).map((edge) => ({ from: edge.fromScene, to: edge.toScene, count: edge.count, path: edge.path })),
				changes: (changeState?.events ?? []).map((event) => ({ sceneId: event.sceneId, what: event.what, atMs: event.atMs })),
			};
		});
		if (requestAgents.size >= MAX_SESSIONS) requestAgents.delete(requestAgents.keys().next().value!);
		requestAgents.set(session.id, agent);
	}

	if (action === "stop") {
		const previous = agent.getState();
		const state = agent.stop();
		if (previous.status === "active") await appendSessionEvent(experimentRoot, session.id, { type: "request_stopped", goal: previous.text });
		json(res, 200, { request: state });
		return;
	}

	if (action === "ask" || action === "watch") {
		const text = typeof input.text === "string" ? input.text.trim() : "";
		if (!text || text.length > 500) throw new Error("请提供 1 到 500 字的要求或关注条件");
		const mode = action === "watch" ? "watch" : "ask";
		agent.set(mode, text);
		await appendSessionEvent(experimentRoot, session.id, { type: "request_set", goal: text, details: { mode } });
	} else if (action !== "step") {
		throw new Error("Unsupported request action");
	}

	const current = agent.getState();
	if (current.status !== "active") { json(res, 200, { request: current }); return; }

	if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 6) throw new Error("request 需要 1 到 6 张截图");
	const motionDescription = typeof input.motionDescription === "string" ? input.motionDescription.slice(0, 1200) : null;
	const sceneLabel = typeof input.sceneLabel === "string" ? input.sceneLabel.slice(0, 120) : null;
	const runId = randomUUID();
	const stagingDir = resolve("run/mobile-staging", session.id, `request-${runId}`);
	await mkdir(stagingDir, { recursive: true });
	const frames: FrameRef[] = [];
	for (const [index, item] of input.frames.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`截图 ${index + 1} 格式错误`);
		const row = item as Record<string, unknown>;
		if (typeof row.dataBase64 !== "string" || typeof row.timestampMs !== "number") throw new Error(`截图 ${index + 1} 缺少图像或时间戳`);
		const mime = row.mimeType;
		const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : null;
		if (!extension) throw new Error("截图只支持 JPEG、PNG 或 WebP");
		const bytes = Buffer.from(row.dataBase64, "base64");
		if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("每张截图最大为 1.5 MB");
		const path = resolve(stagingDir, `frame-${String(index + 1).padStart(2, "0")}${extension}`);
		await writeFile(path, bytes, { flag: "wx" });
		frames.push({ id: `request-${index + 1}-${Math.round(row.timestampMs)}`, timestampMs: Math.round(row.timestampMs), path });
	}

	const result = await agent.observe(frames, motionDescription, sceneLabel);
	await appendSessionEvent(experimentRoot, session.id, { type: "request_answered", goal: current.text, details: { kind: result.kind, answer: result.answer, shouldSpeak: result.shouldSpeak, done: result.done, confidence: result.confidence } });
	json(res, 200, {
		request: agent.getState(),
		result: { kind: result.kind, answer: result.answer, shouldSpeak: result.shouldSpeak, done: result.done, confidence: result.confidence, frameIds: result.frameIds },
	});
}

function parseMotionCalibration(value: unknown): MotionCalibration | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	const vector = (candidate: unknown): { x: number; y: number; z: number } | null => {
		if (typeof candidate !== "object" || candidate === null) return null;
		const v = candidate as Record<string, unknown>;
		return typeof v.x === "number" && typeof v.y === "number" && typeof v.z === "number" ? { x: v.x, y: v.y, z: v.z } : null;
	};
	const gravityWorld = vector(row.gravityWorld);
	const gyroBiasDps = vector(row.gyroBiasDps);
	if (!gravityWorld || !gyroBiasDps) return undefined;
	return {
		gravityWorld,
		gyroBiasDps,
		accelerationNoiseMps2: typeof row.accelerationNoiseMps2 === "number" && row.accelerationNoiseMps2 >= 0 ? row.accelerationNoiseMps2 : 0.2,
		gyroNoiseDps: typeof row.gyroNoiseDps === "number" && row.gyroNoiseDps >= 0 ? row.gyroNoiseDps : 4,
		stable: typeof row.stable === "boolean" ? row.stable : true,
	};
}

function parseMotionContext(value: unknown): MotionContext | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("motionContext must be an object");
	const row = value as Record<string, unknown>;
	const enumField = <T extends string>(field: string, values: readonly T[]): T => {
		const fieldValue = row[field];
		if (typeof fieldValue !== "string" || !values.includes(fieldValue as T)) throw new Error(`motionContext.${field} is invalid`);
		return fieldValue as T;
	};
	if (typeof row.windowMs !== "number" || !Number.isFinite(row.windowMs) || row.windowMs < 0 || row.windowMs > 30_000) throw new Error("motionContext.windowMs is invalid");
	if (!Number.isInteger(row.sampleCount) || typeof row.sampleCount !== "number" || row.sampleCount < 0 || row.sampleCount > 10_000) throw new Error("motionContext.sampleCount is invalid");
	for (const field of ["rotationRateDps", "linearAccelerationMps2"] as const) {
		const fieldValue = row[field];
		if (fieldValue !== null && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0 || fieldValue > 100_000)) throw new Error(`motionContext.${field} is invalid`);
	}
	for (const field of ["orientationSpreadDeg", "rotationPathDeg", "accelerationVariance", "estimatedDisplacementM", "estimatedPathLengthM"] as const) {
		const fieldValue = row[field];
		if (fieldValue !== undefined && fieldValue !== null && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0 || fieldValue > 1_000_000)) throw new Error(`motionContext.${field} is invalid`);
	}
	for (const field of ["rotationDirectionCoherence", "translationDirectionCoherence"] as const) {
		const fieldValue = row[field];
		if (fieldValue !== undefined && fieldValue !== null && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0 || fieldValue > 1)) throw new Error(`motionContext.${field} is invalid`);
	}
	return {
		windowMs: row.windowMs,
		sampleCount: row.sampleCount,
		angularMotion: enumField("angularMotion", ["rotating", "quiet", "unknown"] as const),
		linearAcceleration: enumField("linearAcceleration", ["active", "quiet", "unknown"] as const),
		visualViewChange: enumField("visualViewChange", ["high", "low", "unknown"] as const),
		translationLikelihood: enumField("translationLikelihood", ["possible", "unknown"] as const),
		stability: enumField("stability", ["moving", "settling", "stable", "unknown"] as const),
		rotationRateDps: row.rotationRateDps as number | null,
		linearAccelerationMps2: row.linearAccelerationMps2 as number | null,
		orientationSpreadDeg: row.orientationSpreadDeg as number | null | undefined,
		rotationPathDeg: row.rotationPathDeg as number | null | undefined,
		rotationDirectionCoherence: row.rotationDirectionCoherence as number | null | undefined,
		accelerationVariance: row.accelerationVariance as number | null | undefined,
		estimatedDisplacementM: row.estimatedDisplacementM as number | null | undefined,
		estimatedPathLengthM: row.estimatedPathLengthM as number | null | undefined,
		translationDirectionCoherence: row.translationDirectionCoherence as number | null | undefined,
	};
}

function parseRouterDecision(value: unknown): RouterDecision | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("routerDecision must be an object");
	const row = value as Record<string, unknown>;
	const numberFields = ["capturedFrames", "movingFramesSkipped", "noChangeFramesSkipped", "stabilityWaits", "stableFrameCount"] as const;
	for (const field of numberFields) {
		const fieldValue = row[field];
		if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) throw new Error(`routerDecision.${field} must be a non-negative number`);
	}
	if (row.familiarSceneFramesSkipped !== undefined && (typeof row.familiarSceneFramesSkipped !== "number" || !Number.isFinite(row.familiarSceneFramesSkipped) || row.familiarSceneFramesSkipped < 0)) throw new Error("routerDecision.familiarSceneFramesSkipped must be a non-negative number");
	if (row.sensorMotionGatedFrames !== undefined && (typeof row.sensorMotionGatedFrames !== "number" || !Number.isFinite(row.sensorMotionGatedFrames) || row.sensorMotionGatedFrames < 0)) throw new Error("routerDecision.sensorMotionGatedFrames must be a non-negative number");
	const visualNoveltyScore = row.visualNoveltyScore !== undefined ? row.visualNoveltyScore : row.sceneChangeScore !== undefined ? row.sceneChangeScore : null;
	for (const [field, fieldValue] of [["frameChangeScore", row.frameChangeScore], ["visualNoveltyScore", visualNoveltyScore]] as const) {
		if (fieldValue !== null && (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0 || fieldValue > 1)) throw new Error(`routerDecision.${field} must be null or between 0 and 1`);
	}
	if (typeof row.triggerReason !== "string") throw new Error("routerDecision.triggerReason must be a string");
	const motionContext = parseMotionContext(row.motionContext);
	return {
		triggerReason: row.triggerReason.slice(0, 80),
		capturedFrames: row.capturedFrames as number,
		movingFramesSkipped: row.movingFramesSkipped as number,
		noChangeFramesSkipped: row.noChangeFramesSkipped as number,
		familiarSceneFramesSkipped: typeof row.familiarSceneFramesSkipped === "number" ? row.familiarSceneFramesSkipped : 0,
		stabilityWaits: row.stabilityWaits as number,
		stableFrameCount: row.stableFrameCount as number,
		frameChangeScore: row.frameChangeScore as number | null,
		visualNoveltyScore: visualNoveltyScore as number | null,
		sensorMotionGatedFrames: typeof row.sensorMotionGatedFrames === "number" ? row.sensorMotionGatedFrames : 0,
		...(motionContext ? { motionContext } : {}),
	};
}

async function handleTask(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
	const input = await bodyJson(req);
	if (input.action !== "stop") throw new Error("Only the stop task action is supported");
	const harness = harnesses.get(sessionId);
	const previousTask = harness?.getWorkingState().activeTask;
	const workingState = harness?.endTask();
	if (previousTask?.status === "active") await appendSessionEvent(experimentRoot, sessionId, { type: "task_stopped", goal: previousTask.goal });
	json(res, 200, { task: workingState?.activeTask ?? { status: "idle", phase: "done", goal: null, startedAt: null, updatedAt: new Date().toISOString() } });
}

async function handleWatch(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
	const input = await bodyJson(req);
	let harness = harnesses.get(sessionId);
	if (input.action === "stop") {
		const previous = harness?.getWorkingState().activeWatch;
		const watch = harness?.stopWatch().activeWatch ?? { status: "idle" as const, condition: null, startedAt: null, lastCheckedAt: null };
		if (previous && previous.status !== "idle") await appendSessionEvent(experimentRoot, sessionId, { type: "watch_stopped", goal: previous.condition });
		json(res, 200, { watch });
		return;
	}
	if (input.action !== "start" || typeof input.condition !== "string" || !input.condition.trim() || input.condition.length > 500) throw new Error("请提供 1 到 500 字的关注条件");
	if (!harness) {
		harness = new VlmHarness();
		if (harnesses.size >= MAX_SESSIONS) harnesses.delete(harnesses.keys().next().value!);
		harnesses.set(sessionId, harness);
	}
	if (harness.getWorkingState().activeTask.status === "active") throw new Error("请先结束当前任务，再开始关注条件");
	const watch = harness.startWatch(input.condition.trim()).activeWatch;
	await appendSessionEvent(experimentRoot, sessionId, { type: "watch_started", goal: watch.condition });
	json(res, 200, { watch });
}

function handleState(res: ServerResponse, sessionId: string): void {
	const state = harnesses.get(sessionId)?.getWorkingState();
	json(res, 200, {
		task: state?.activeTask ?? { status: "idle", phase: "done", goal: null, startedAt: null, updatedAt: null },
		watch: state?.activeWatch ?? { status: "idle", condition: null, startedAt: null, lastCheckedAt: null },
	});
}

async function handleFeedback(req: IncomingMessage, res: ServerResponse, session: { id: string }): Promise<void> {
	const input = await bodyJson(req);
	if (typeof input.runId !== "string") throw new Error("runId is required");
	const bool = (name: string): boolean | null => typeof input[name] === "boolean" ? input[name] as boolean : null;
	const feedback: Omit<Feedback, "createdAt"> & { runId: string } = {
		runId: input.runId, useful: bool("useful"), perceptionCorrect: bool("perceptionCorrect"), positionCorrect: bool("positionCorrect"),
		decisionCorrect: bool("decisionCorrect"), responseCorrect: bool("responseCorrect"), notes: typeof input.notes === "string" ? input.notes.slice(0, 1000) : null,
	};
	const path = await appendFeedback(experimentRoot, session.id, feedback);
	json(res, 200, { saved: true, feedbackPath: path });
}

function finiteNumber(value: unknown, name: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a finite number`);
	return value;
}

function finiteVector(value: unknown): { x: number | null; y: number | null; z: number | null } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const component = (name: string): number | null => typeof row[name] === "number" && Number.isFinite(row[name]) ? row[name] as number : null;
	const vector = { x: component("x"), y: component("y"), z: component("z") };
	return Object.values(vector).every((item) => item === null) ? null : vector;
}

function finiteRotationRate(value: unknown): { alpha: number | null; beta: number | null; gamma: number | null } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const component = (name: string): number | null => typeof row[name] === "number" && Number.isFinite(row[name]) ? row[name] as number : null;
	const rate = { alpha: component("alpha"), beta: component("beta"), gamma: component("gamma") };
	return Object.values(rate).every((item) => item === null) ? null : rate;
}

function roundTo(value: number, places = 2): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
	const assets: Record<string, { file: string; type: string }> = {
		"/vlm": { file: "index.html", type: "text/html; charset=utf-8" },
		"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
		"/vio": { file: "vio.html", type: "text/html; charset=utf-8" },
		"/vio.js": { file: "vio.js", type: "text/javascript; charset=utf-8" },
		"/vio-flow.js": { file: "vio-flow.js", type: "text/javascript; charset=utf-8" },
		"/vio.css": { file: "vio.css", type: "text/css; charset=utf-8" },
		"/motion-fusion.js": { file: "motion-fusion.js", type: "text/javascript; charset=utf-8" },
		"/motion-vio-bridge.js": { file: "motion-vio-bridge.js", type: "text/javascript; charset=utf-8" },
		"/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
	};
	const asset = assets[pathname];
	if (!asset) { json(res, 404, { error: "Not found" }); return; }
	const content = await readFile(resolve("web", asset.file));
	res.writeHead(200, {
		"Content-Type": asset.type,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Permissions-Policy": "camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)",
		"Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
	});
	res.end(content);
}

const ANALYSIS_ROOT = resolve("run", "analysis");
const CA_FILE = resolve("run", "tls", "vlm-local-ca.cer");

/** Best-effort hostname the phone used to reach us, so the /vlm link is never stale. */
function requestHostname(req: IncomingMessage): string {
	const host = req.headers.host ?? "";
	const name = host.split(":")[0] ?? "";
	return name || LAN_IP_HINT || "<LAN-IP>";
}

/** Shared CA install page for iOS and Android (used on both the plain-HTTP helper and the main port). */
function caInstallPageHtml(req: IncomingMessage): string {
	const host = requestHostname(req);
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安装本地证书</title></head>
<body style="font-family:system-ui;padding:24px;line-height:1.7;max-width:680px">
<h1>安装本地证书（iOS / Android）</h1>
<p>先把证书下载到手机上（会提示下载文件）：</p>
<p><a href="/vlm-local-ca.cer" style="font-size:1.2em">⬇︎ 下载 vlm-local-ca.cer</a></p>
<h3>iOS</h3>
<ol><li>设置 → 通用 → VPN 与设备管理 → 安装该描述文件</li><li>设置 → 通用 → 关于本机 → 证书信任设置 → 打开“VLM Local Dev CA”的完全信任</li></ol>
<h3>Android（Chrome）</h3>
<ol><li>设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书 → 选择下载的文件</li><li>确认“受信任的凭据 → 用户”里出现它</li></ol>
<p>完成后用手机浏览器打开 <b>https://${host}:${PORT}/vlm</b>。</p>
</body></html>`;
}

/**
 * Serves the local CA certificate over the main server too, so a phone that can
 * already reach the HTTPS port can install the CA even when the plain-HTTP
 * helper port (8765+2) is blocked by the network.
 */
async function serveCa(req: IncomingMessage, pathname: string, res: ServerResponse): Promise<void> {
	if (!existsSync(CA_FILE)) { json(res, 404, { error: "CA 证书不存在，请先运行 scripts/setup-lan-tls.ps1" }); return; }
	if (pathname === "/vlm-local-ca.cer") {
		res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=vlm-local-ca.cer", "Cache-Control": "no-store" });
		res.end(readFileSync(CA_FILE));
		return;
	}
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(caInstallPageHtml(req));
}

/** Serves the generated trajectory reports (inline scripts, so no restrictive CSP). */
async function serveReport(pathname: string, res: ServerResponse): Promise<void> {
	if (pathname === "/report" || pathname === "/report/") {
		const files = (existsSync(ANALYSIS_ROOT) ? await readdir(ANALYSIS_ROOT) : []).filter((entry) => entry.endsWith(".html")).sort();
		const links = files.map((file) => `<li><a href="/report/${encodeURIComponent(file)}">${file}</a></li>`).join("");
		const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>运动分析报告</title></head><body style="background:#0b1220;color:#e5eaf3;font:15px/1.6 sans-serif;padding:24px"><h1>运动分析报告</h1><p style="color:#8ea0ba">点开查看轨迹图。</p><ul>${links || "<li>暂无报告</li>"}</ul></body></html>`;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
		res.end(html);
		return;
	}
	const name = decodeURIComponent(pathname.slice("/report/".length));
	if (!/^[A-Za-z0-9._-]+\.html$/.test(name)) { json(res, 404, { error: "Not found" }); return; }
	const file = resolve(ANALYSIS_ROOT, name);
	if (!existsSync(file)) { json(res, 404, { error: "Not found" }); return; }
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(await readFile(file));
}

async function main(): Promise<void> {
	if (PASSCODE.length < 3) throw new Error("VLM_TRIAL_PASSCODE must contain at least 3 characters");
	if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("VLM_TRIAL_PORT must be an integer from 1024 to 65535");
	const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
		void (async () => {
			const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
			// Minimal access log: enough to see whether phone uploads reach the server and what status they get.
			const requestStart = Date.now();
			let logged = false;
			const logOnce = (): void => {
				if (logged) return;
				logged = true;
				process.stdout.write(`[req] ${req.method} ${pathname} -> ${res.statusCode} ${Date.now() - requestStart}ms len=${req.headers["content-length"] ?? "-"}\n`);
			};
			res.on("finish", logOnce);
			res.on("close", logOnce);

			if (req.method === "GET") {
				if (pathname === "/") { res.writeHead(302, { Location: "/vlm", "Cache-Control": "no-store" }); res.end(); return; }
				if (pathname === "/api/state") {
					if (!sameOrigin(req)) { json(res, 403, { error: "Cross-origin request rejected" }); return; }
					const session = authorized(req, res);
					if (!session) return;
					rateLimit(session);
					handleState(res, session.id);
					return;
				}
				if (pathname === "/report" || pathname === "/report/" || pathname.startsWith("/report/")) { await serveReport(pathname, res); return; }
				if (pathname === "/ca" || pathname === "/vlm-local-ca.cer") { await serveCa(req, pathname, res); return; }
				await serveStatic(pathname, res); return;
			}
			if (req.method !== "POST") { json(res, 405, { error: "Method not allowed" }); return; }
			if (!sameOrigin(req)) { json(res, 403, { error: "Cross-origin request rejected" }); return; }
			if (pathname === "/api/login") { await handleLogin(req, res); return; }
			if (pathname === "/api/vio/burst") { await handleVioBurst(req, res); return; }
			const session = authorized(req, res);
			if (!session) return;
			rateLimit(session);
			if (pathname === "/api/live/batch") { await handleLiveBatch(req, res, session); return; }
			if (pathname === "/api/observe") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleObserve(req, res, session);
				return;
			}
			if (pathname === "/api/scene") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleScene(req, res, session);
				return;
			}
			if (pathname === "/api/scene-change") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleSceneChange(req, res, session);
				return;
			}
			if (pathname === "/api/request") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleRequest(req, res, session);
				return;
			}
			if (pathname === "/api/asr") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleAsr(req, res);
				return;
			}
			if (pathname === "/api/tts") {
				if (!process.env.QWEN_API_KEY || !process.env.QWEN_BASE_URL) { json(res, 503, { error: "VLM API is not configured" }); return; }
				await handleTts(req, res);
				return;
			}
			if (pathname === "/api/task") { await handleTask(req, res, session.id); return; }
			if (pathname === "/api/watch") { await handleWatch(req, res, session.id); return; }
			if (pathname === "/api/feedback") { await handleFeedback(req, res, session); return; }
			json(res, 404, { error: "Not found" });
		})().catch((error: unknown) => {
			if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : String(error) });
			else res.destroy();
		});
	};

	// Serve HTTPS automatically when a local server certificate exists
	// (generated by scripts/setup-lan-tls.ps1). HTTPS is required for the phone's
	// camera and motion-sensor APIs, and this lets the phone connect directly
	// over the LAN instead of through a slow tunnel.
	const tlsPfxPath = resolve("run", "tls", "vlm-server.pfx");
	const tlsPassphrasePath = resolve("run", "tls", "passphrase.txt");
	const tlsEnabled = existsSync(tlsPfxPath);
	const server = tlsEnabled
		? createHttpsServer({
			pfx: readFileSync(tlsPfxPath),
			...(existsSync(tlsPassphrasePath) ? { passphrase: readFileSync(tlsPassphrasePath, "utf8") } : {}),
			minVersion: "TLSv1.2",
		}, requestHandler)
		: createServer(requestHandler);
	const host = process.env.VLM_TRIAL_HOST || (tlsEnabled ? "0.0.0.0" : "127.0.0.1");
	server.listen(PORT, host, () => {
		const scheme = tlsEnabled ? "https" : "http";
		process.stdout.write(`VLM camera trial ready at ${scheme}://localhost:${PORT}\n`);
		if (tlsEnabled) process.stdout.write(`LAN HTTPS enabled; open https://<this-machine-LAN-IP>:${PORT}/vlm on the phone after trusting run/tls/vlm-local-ca.cer\n`);
		if (GENERATED_PASSCODE) process.stdout.write(`Trial passcode: ${PASSCODE}\n`);
		process.stdout.write("For phone camera access, use an HTTPS URL; then encode that URL as a QR code.\n");
		process.stdout.write(`Experiment records: ${experimentRoot}\n`);
	});

	if (tlsEnabled) {
		// Plain-HTTP helper so the phone can download the CA certificate without
		// first having to bypass an untrusted-certificate warning.
		const caPath = resolve("run", "tls", "vlm-local-ca.cer");
		const caPort = PORT + 2;
		if (existsSync(caPath)) {
			createServer((req, res) => {
				const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
				if (pathname === "/vlm-local-ca.cer") {
					res.writeHead(200, {
						"Content-Type": "application/x-x509-ca-cert",
						"Content-Disposition": "attachment; filename=vlm-local-ca.cer",
						"Cache-Control": "no-store",
					});
					res.end(readFileSync(caPath));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(caInstallPageHtml(req));
			}).listen(caPort, "0.0.0.0", () => {
				process.stdout.write(`CA install page (plain HTTP): http://<this-machine-LAN-IP>:${caPort}/\n`);
			});
		}
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`Trial server failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
