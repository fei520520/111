import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { createQwenModel } from "./qwen-provider.js";
import type { FrameRef } from "./types.js";

/**
 * RequestAgent (role 3 of 3): handles the user's *explicit* requirement.
 *
 * It only runs when the user actually asked for something (a question, a goal,
 * or a condition to watch). It receives the current frames plus the same
 * auxiliary context as the other agents (motion-mode in natural language, and
 * the current scene label) and answers / decides whether to speak.
 *
 * This is deliberately a plain VLM agent with a small amount of state: the model
 * is not fine-tuned, so the reply is natural language and only the control flags
 * (kind/shouldSpeak/done/confidence) are structured.
 */

export type RequestMode = "ask" | "watch";
export type RequestKind = "question" | "goal" | "watch";

export interface RequestTurn {
	atMs: number;
	kind: RequestKind;
	answer: string;
	shouldSpeak: boolean;
	done: boolean;
	confidence: number;
}

export interface RequestState {
	mode: RequestMode | null;
	kind: RequestKind | null;
	text: string | null;
	status: "idle" | "active" | "done";
	/** True once a watch condition has been reported, so it is never repeated. */
	spoken: boolean;
	lastAnswer: string | null;
	turns: RequestTurn[];
	startedAtMs: number | null;
	updatedAtMs: number | null;
}

export interface RequestResult {
	kind: RequestKind;
	answer: string;
	shouldSpeak: boolean;
	done: boolean;
	confidence: number;
	frameIds: string[];
	raw: string;
}

export interface SceneMemoryScene {
	id: string;
	label: string;
	summary: string;
	objects: string[];
	visits: number;
	lastSeenMs: number;
}

export interface SceneMemoryChange {
	sceneId: string;
	what: string;
	atMs: number;
}

export interface SceneMemorySnapshot {
	currentSceneId: string | null;
	scenes: SceneMemoryScene[];
	visitedOrder: string[];
	/** Edges between places with their usual path (qualitative). */
	transitions: Array<{ from: string; to: string; count: number; path: string }>;
	changes: SceneMemoryChange[];
}

export type SceneMemoryProvider = () => SceneMemorySnapshot;

const SYSTEM_PROMPT = [
	"You are the user-request agent of a first-person visual assistant.",
	"The user has given ONE explicit requirement. Read the current camera frames and respond helpfully, in the user's own language.",
	"Classify the requirement as one of: QUESTION (something to answer), GOAL (something to achieve or find), WATCH (a condition to report when it actually happens).",
	"SPATIAL FRAME: the image is a narrow view from the phone's rear camera, roughly what the user is facing — it is NOT the user's whole surroundings and there is no depth map. The image centre is roughly straight ahead of the user; the left of the image is the user's front-left; the right of the image is their front-right; up/down are slightly above/below.",
	"When asked where something is, give its position relative to the USER or to another object the user can name (e.g. 'directly in front of you, left side of the desk, next to the laptop'). NEVER answer in terms of image or pixel coordinates such as 'the right side of the picture'.",
	"If the thing is not visible in the current view, say so plainly and suggest where to look or that it may be outside the current view (behind / beside / below); do not invent a position.",
	"A 'MOTION' line (how the phone moved, natural language) and a 'SCENE' line (current place) are approximate context; use them to help interpret the frames.",
	"For a WATCH condition be conservative: shouldSpeak must be true only when the current frames clearly show the condition is happening now. Never set shouldSpeak for a condition that was already reported.",
	"For a QUESTION answer once and set done=true. For a GOAL give brief, actionable help; set done=true only when it is clearly achieved or impossible.",
	"You have a tool `search_scene_memory` to look up places the user has already visited and recent changes in them. Use it ONLY when the request is about the place they are in, whether they have been somewhere before, or what changed there; never use it for ordinary object questions.",
	"Keep 'answer' to one or two short sentences. If there is nothing useful to say, make 'answer' the reason and shouldSpeak=false.",
	'Reply with ONLY JSON: {"kind": "question|goal|watch", "answer": string, "shouldSpeak": boolean, "done": boolean, "confidence": number}. No markdown.',
].join(" ");

/** Long-term memory limits: keep many turns on disk, feed the most recent ones to the model. */
const MAX_HISTORY = 50;
const PROMPT_HISTORY = 12;

function mimeTypeFor(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg": case ".jpeg": return "image/jpeg";
		case ".png": return "image/png";
		case ".webp": return "image/webp";
		default: return "image/jpeg";
	}
}

function parseRequest(text: string, fallbackKind: RequestKind | null): Omit<RequestResult, "frameIds" | "raw"> {
	const jsonText = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const root = JSON.parse(jsonText) as Record<string, unknown>;
	const rawKind = typeof root.kind === "string" ? root.kind.toLowerCase() : "";
	const kind: RequestKind = rawKind === "question" || rawKind === "goal" || rawKind === "watch" ? rawKind : fallbackKind ?? "question";
	if (typeof root.answer !== "string" || !root.answer.trim()) throw new Error("request.answer must be a non-empty string");
	const confidence = typeof root.confidence === "number" && root.confidence >= 0 && root.confidence <= 1 ? root.confidence : 0.5;
	return {
		kind,
		answer: root.answer.trim().slice(0, 400),
		shouldSpeak: typeof root.shouldSpeak === "boolean" ? root.shouldSpeak : kind === "question",
		done: typeof root.done === "boolean" ? root.done : kind === "question",
		confidence,
	};
}

export class RequestAgent {
	private readonly model: Model<"openai-completions">;
	private readonly streamFn: Agent["streamFunction"];
	private state: RequestState = {
		mode: null, kind: null, text: null, status: "idle", spoken: false, lastAnswer: null, turns: [], startedAtMs: null, updatedAtMs: null,
	};
	/**
	 * Conversation so far (question + answer per turn). Kept across requests so a follow-up
	 * like "is this it?" still knows the earlier goal ("find the guitar bag").
	 */
	private history: Array<{ question: string; answer: string }> = [];

	constructor(private readonly getSceneMemory: SceneMemoryProvider | null = null, private readonly storePath: string | null = null) {
		const configured = createQwenModel(512);
		this.model = configured.model;
		this.streamFn = configured.streamFn;
		void this.loadHistory();
	}

	/** Load long-term memory from disk so context survives restarts and new sessions. */
	private async loadHistory(): Promise<void> {
		if (!this.storePath) return;
		try {
			const data = JSON.parse(await readFile(this.storePath, "utf8")) as Array<{ question?: unknown; answer?: unknown }>;
			if (Array.isArray(data)) {
				this.history = data
					.filter((turn) => typeof turn?.question === "string" && typeof turn?.answer === "string")
					.map((turn) => ({ question: turn.question as string, answer: turn.answer as string }))
					.slice(-MAX_HISTORY);
			}
		} catch { /* fresh memory */ }
	}

	private async saveHistory(): Promise<void> {
		if (!this.storePath) return;
		try {
			await mkdir(dirname(this.storePath), { recursive: true });
			await writeFile(this.storePath, JSON.stringify(this.history.slice(-MAX_HISTORY)), "utf8");
		} catch { /* best effort */ }
	}

	/** Optional tool: look up visited places and recent changes. The agent decides when to call it. */
	private sceneMemoryTool(): AgentTool<any> {
		return {
			name: "search_scene_memory",
			label: "搜索场景记忆",
			description: "Look up places the user has already visited and recent changes in them. Call this only when the request is about the place, prior visits, or what changed.",
			parameters: {
				type: "object",
				properties: { query: { type: "string", description: "Optional keywords to filter places (a place name or an object)." } },
				required: [],
			},
			execute: async (_toolCallId: string, params: unknown) => {
				const snapshot = this.getSceneMemory?.() ?? { currentSceneId: null, scenes: [], visitedOrder: [], transitions: [], changes: [] };
				const rawQuery = (params as { query?: unknown } | null)?.query;
				const query = typeof rawQuery === "string" ? rawQuery.trim().toLowerCase() : "";
				let scenes = snapshot.scenes;
				if (query) {
					const terms = query.split(/\s+/).filter(Boolean);
					const matched = scenes.filter((scene) => terms.some((term) => `${scene.label} ${scene.summary} ${scene.objects.join(" ")}`.toLowerCase().includes(term)));
					if (matched.length) scenes = matched;
				}
				const kept = new Set(scenes.slice(-10).map((scene) => scene.id));
				const result = {
					currentSceneId: snapshot.currentSceneId,
					visitedOrder: snapshot.visitedOrder,
					scenes: scenes.slice(-10).map((scene) => ({ id: scene.id, label: scene.label, summary: scene.summary, objects: scene.objects, visits: scene.visits })),
					connections: snapshot.transitions.filter((edge) => kept.has(edge.from) || kept.has(edge.to)).slice(-20),
					recentChanges: snapshot.changes.slice(-5),
				};
				return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { sceneCount: result.scenes.length } };
			},
		};
	}

	getState(): RequestState {
		return { ...this.state, turns: this.state.turns.slice(-10) };
	}

	set(mode: RequestMode, text: string): RequestState {
		this.state = {
			mode,
			kind: mode === "watch" ? "watch" : null,
			text,
			status: "active",
			spoken: false,
			lastAnswer: null,
			turns: [],
			startedAtMs: Date.now(),
			updatedAtMs: Date.now(),
		};
		return this.getState();
	}

	stop(): RequestState {
		this.state = { ...this.state, mode: null, kind: null, text: null, status: "idle", spoken: false, lastAnswer: null, turns: [] };
		this.state.updatedAtMs = Date.now();
		return this.getState();
	}

	async observe(frames: FrameRef[], motionDescription: string | null, sceneLabel: string | null): Promise<RequestResult> {
		if (this.state.status !== "active" || !this.state.text) throw new Error("No active user requirement");
		if (frames.length === 0) throw new Error("RequestAgent needs at least one frame");
		const ordered = frames.slice().sort((a, b) => a.timestampMs - b.timestampMs).slice(-3);
		const imageContents: ImageContent[] = await Promise.all(ordered.map(async (frame) => ({
			type: "image" as const, data: (await readFile(frame.path)).toString("base64"), mimeType: mimeTypeFor(frame.path),
		})));

		const recent = this.state.turns.slice(-3).map((turn) => ({ kind: turn.kind, answer: turn.answer, spoke: turn.shouldSpeak }));
		const historyText = this.history.slice(-PROMPT_HISTORY).map((turn) => `the user asked: ${turn.question}\nyou answered: ${turn.answer}`).join("\n");
		const promptLines = [
			"Answer the user's requirement using the current frames. Image blocks are in chronological order.",
			`CONVERSATION SO FAR (earlier turns; the user may be following up on these — e.g. "is this it?" refers to the item they were previously looking for):\n${historyText || "(none)"}`,
			`MODE: ${this.state.mode ?? "ask"}`,
			`REQUIREMENT: ${this.state.text}`,
			`SCENE: ${sceneLabel ?? "unknown"}`,
			`MOTION (approximate, how the phone moved recently): ${motionDescription ?? "none"}`,
			`ALREADY_REPORTED (do not repeat these): ${JSON.stringify(recent)}${this.state.spoken ? " (a watch condition has already been reported; do not report it again)" : ""}`,
		];
		promptLines.push("Reply with only the JSON object.");
		const prompt = promptLines.join("\n\n");

		const tools = this.getSceneMemory ? [this.sceneMemoryTool()] : [];
		const agent = new Agent({ initialState: { systemPrompt: SYSTEM_PROMPT, model: this.model, tools }, streamFn: this.streamFn });
		await agent.prompt(prompt, imageContents);
		if (agent.state.errorMessage) throw new Error(`RequestAgent request failed: ${agent.state.errorMessage}`);
		const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
		if (!assistant || assistant.role !== "assistant") throw new Error("RequestAgent returned no assistant message");
		const raw = assistant.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		const parsed = parseRequest(raw, this.state.mode === "watch" ? "watch" : null);

		// A watch condition fires once; a question is done after answering.
		const shouldSpeak = parsed.kind === "watch" ? parsed.shouldSpeak && !this.state.spoken : parsed.shouldSpeak;
		const done = parsed.done || (parsed.kind === "watch" && shouldSpeak) || parsed.kind === "question";
		const turn: RequestTurn = { atMs: Date.now(), kind: parsed.kind, answer: parsed.answer, shouldSpeak, done, confidence: parsed.confidence };
		this.state.kind = parsed.kind;
		this.state.lastAnswer = parsed.answer;
		if (shouldSpeak) this.state.spoken = true;
		this.state.turns.push(turn);
		if (done) this.state.status = "done";
		this.state.updatedAtMs = Date.now();
		// Remember this turn so the next request keeps context (follow-ups, "is this it?").
		const question = this.state.text ?? "";
		const previous = this.history[this.history.length - 1];
		if (previous && previous.question === question) previous.answer = parsed.answer;
		else this.history.push({ question, answer: parsed.answer });
		if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
		void this.saveHistory();

		return { ...parsed, shouldSpeak, done, frameIds: [ordered[ordered.length - 1]!.id], raw };
	}
}
