const $ = (id) => document.getElementById(id);
const FRAME_BUFFER_MAX = 32;
const MONITOR_MAX_WINDOW_MS = 30_000;
const MONITOR_MAX_FRAMES = 8;
const AWARENESS_RECHECK_INTERVAL_MS = 10_000;
const CAPTURE_INTERVAL_MS = 1_000;
/** Unconditional background save cadence while the camera is on. */
const LIVE_SYNC_INTERVAL_MS = 5_000;
/** On-device VIO-lite: small grayscale frames, ~15fps. */
const VIO_WIDTH = 160;
const VIO_HEIGHT = 120;
const VIO_INTERVAL_MS = 66;
const VIO_BUFFER_MS = 12_000;
const ROUTER_SIGNATURE_WIDTH = 32;
const ROUTER_SIGNATURE_HEIGHT = 24;
const ROUTER_STABLE_DELTA = 0.04;
const ROUTER_VISUAL_NOVELTY_DELTA = 0.10;
/** Automatic observations are rate-limited to at most one per 10 s. */
const ROUTER_MIN_INTERVAL_MS = 10_000;
const ROUTER_COOLDOWN_MS = 10_000;
/** The phone must have travelled this cumulative path in the window to count as an action. */
const ACTION_PATH_M = 1.5;
/** Net heading change (with coherence) required to count as a turn. */
const TURN_NET_DEG = 40;
const MOTION_WINDOW_MS = 10_000;
const MOTION_SAMPLE_RETENTION_MS = 12_000;
const MOTION_SETTLE_MS = 900;
const ROTATION_ACTIVE_DPS = 10;
const ROTATION_QUIET_DPS = 4;
const LINEAR_ACCELERATION_ACTIVE_MPS2 = 0.9;
const LINEAR_ACCELERATION_QUIET_MPS2 = 0.35;
const BOUNDED_ORIENTATION_SPREAD_DEG = 18;
const MIN_TRANSLATION_ESTIMATE_M = 0.12;
const MIN_TRANSLATION_DIRECTION_COHERENCE = 0.58;
const MAX_MOTION_INTEGRATION_GAP_MS = 250;
const ROUTER_VISUAL_WINDOW = 5;
const ROUTER_VISUAL_PERSISTENCE = 3;

function emptyRouterStats() {
	return { capturedFrames: 0, movingFramesSkipped: 0, sensorMotionGatedFrames: 0, noChangeFramesSkipped: 0, familiarSceneFramesSkipped: 0, stabilityWaits: 0, frameChangeScore: null, visualNoveltyScore: null, motionContext: null };
}

const state = { token: sessionStorage.getItem("vlm-token"), sessionId: sessionStorage.getItem("vlm-session"), stream: null, frames: [], captureTimer: null, monitorCursorMs: null, captureBusy: false, busy: false, currentRequestMode: null, pendingDeepGoal: null, pendingDeepReason: null, pendingMonitorReason: null, pendingTaskStop: false, activeTask: null, activeWatch: null, lastRunId: null, sceneStatus: "未开始", changeStatus: "未开始", sceneLabel: null, sceneId: null, request: { mode: null, kind: null, status: "idle", text: null, lastAnswer: null, spoken: false, lastStepMs: 0 }, live: { pendingFrames: [], pendingMotionSamples: [], timer: null }, vio: { canvas: null, ctx: null, prevGray: null, prevAlpha: null, prevTickMs: 0, prevAbsHeading: null, features: [], startMs: 0, timer: null, placeTimer: null, lastPlaceMs: 0, lastSceneChangeMs: 0, lastSceneSignature: null }, motion: { samples: [], orientations: [], lastActivityAt: null, lastAbsoluteMs: 0, absoluteHeadingDeg: null, angularState: "unknown", linearState: "unknown", calibration: null, listenerActive: false, motionPermission: "unknown", orientationPermission: "unknown" }, router: { baselineSignature: null, knownViewSignatures: [], stableFrames: 0, lastAnalysisMs: 0, lastTriggerAt: 0, motionSignature: null, frameChangeHistory: [], noveltyHistory: [], stats: emptyRouterStats() } };

async function post(path, payload, authenticated = true, timeoutMs = 25_000) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated && state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：网络或临时隧道不通，可稍后重试`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && authenticated) {
    sessionStorage.removeItem("vlm-token");
    sessionStorage.removeItem("vlm-session");
    state.token = null;
    state.sessionId = null;
    $("app-panel").hidden = true;
    $("login-panel").hidden = false;
  }
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}

function setStatus(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle("error", error);
}

function showApp() {
  $("login-panel").hidden = true;
  $("app-panel").hidden = false;
}

async function syncTaskState() {
  if (!state.token) return;
  const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${state.token}` } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    sessionStorage.removeItem("vlm-token");
    sessionStorage.removeItem("vlm-session");
    state.token = null;
    state.sessionId = null;
    $("app-panel").hidden = true;
    $("login-panel").hidden = false;
  }
  if (!response.ok) throw new Error(result.error || `状态同步失败 (${response.status})`);
  state.activeTask = result.task ?? null;
  state.activeWatch = result.watch ?? null;
  updateActionState();
}

function makeFrameSignature(canvas) {
  const small = document.createElement("canvas");
  small.width = ROUTER_SIGNATURE_WIDTH;
  small.height = ROUTER_SIGNATURE_HEIGHT;
  const context = small.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, small.width, small.height);
  const rgba = context.getImageData(0, 0, small.width, small.height).data;
  const signature = new Uint8Array(small.width * small.height);
  for (let pixel = 0; pixel < signature.length; pixel++) {
    const offset = pixel * 4;
    signature[pixel] = Math.round((rgba[offset] * 0.299) + (rgba[offset + 1] * 0.587) + (rgba[offset + 2] * 0.114));
  }
  return signature;
}

function measureFrameQuality(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const luminance = new Uint8Array(width * height);
  let clipped = 0;
  for (let pixel = 0; pixel < luminance.length; pixel++) {
    const offset = pixel * 4;
    const value = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
    luminance[pixel] = value;
    if (value < 12 || value > 243) clipped++;
  }
  let sum = 0;
  let sumSquares = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const index = y * width + x;
      const laplacian = 4 * luminance[index] - luminance[index - 1] - luminance[index + 1] - luminance[index - width] - luminance[index + width];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      samples++;
    }
  }
  const variance = samples ? Math.max(0, sumSquares / samples - (sum / samples) ** 2) : 0;
  return {
    sharpness: Math.max(0, Math.min(1, variance / (variance + 250))),
    exposure: Math.max(0, Math.min(1, 1 - clipped / luminance.length)),
  };
}

function encodeSignature(signature) {
  let binary = "";
  for (let offset = 0; offset < signature.length; offset += 0x8000) binary += String.fromCharCode(...signature.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function signatureDifference(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

function vectorMagnitude(vector) {
  if (!vector) return null;
  const values = [vector.x, vector.y, vector.z].filter(Number.isFinite);
  return values.length ? Math.hypot(...values) : null;
}

function percentile(values, fraction) {
	if (!values.length) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function vectorDirectionCoherence(vectors) {
	const valid = vectors.filter((vector) => vector && [vector.x, vector.y, vector.z].every(Number.isFinite));
	if (!valid.length) return null;
	const totalMagnitude = valid.reduce((sum, vector) => sum + Math.hypot(vector.x, vector.y, vector.z), 0);
	if (totalMagnitude < 1e-6) return 1;
	const sum = valid.reduce((acc, vector) => ({ x: acc.x + vector.x, y: acc.y + vector.y, z: acc.z + vector.z }), { x: 0, y: 0, z: 0 });
	return Math.min(1, Math.hypot(sum.x, sum.y, sum.z) / totalMagnitude);
}

function variance(values) {
	if (values.length < 2) return 0;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function classifyMotionSignal(samples, key, vectorKey, activeThreshold, quietThreshold, previousState) {
	const values = samples.map((sample) => sample[key]).filter(Number.isFinite);
	if (!values.length) return { state: "unknown", magnitude: null, variance: null, directionCoherence: null };
	const magnitude = percentile(values, 0.5);
	const p75 = percentile(values, 0.75);
	const signalVariance = variance(values);
	const directionCoherence = vectorDirectionCoherence(samples.map((sample) => sample[vectorKey]));
	const activeShare = values.filter((value) => value >= activeThreshold).length / values.length;
	const coefficientOfVariation = Math.sqrt(signalVariance) / Math.max(0.05, magnitude);
	const coherentSustainedMotion = p75 !== null && p75 >= activeThreshold && activeShare >= 0.6
		&& (directionCoherence === null || directionCoherence >= 0.3)
		&& coefficientOfVariation < 2.5;
	const boundedJitter = directionCoherence !== null && directionCoherence < 0.25
		&& coefficientOfVariation >= 0.3 && magnitude < activeThreshold * 2;
	if (coherentSustainedMotion) return { state: "active", magnitude, variance: signalVariance, directionCoherence };
	if ((p75 !== null && p75 <= quietThreshold) || boundedJitter) return { state: "quiet", magnitude, variance: signalVariance, directionCoherence };
	return { state: previousState === "active" || previousState === "quiet" ? previousState : "unknown", magnitude, variance: signalVariance, directionCoherence };
}

function wrapDegrees(value) {
	return ((value + 180) % 360 + 360) % 360 - 180;
}

function orientationSummary(samples) {
	const valid = samples.filter((sample) => [sample.alpha, sample.beta, sample.gamma].every(Number.isFinite));
	if (valid.length < 2) return { spreadDeg: null, pathDeg: null, netChangeDeg: null, directionCoherence: null };
	const center = ["alpha", "beta", "gamma"].map((axis) => {
		const radians = valid.map((sample) => sample[axis] * Math.PI / 180);
		return Math.atan2(radians.reduce((sum, value) => sum + Math.sin(value), 0), radians.reduce((sum, value) => sum + Math.cos(value), 0)) * 180 / Math.PI;
	});
	const axisSpread = ["alpha", "beta", "gamma"].map((axis, index) => percentile(valid.map((sample) => Math.abs(wrapDegrees(sample[axis] - center[index]))), 0.9) ?? 0);
	let pathDeg = 0;
	const net = ["alpha", "beta", "gamma"].map((axis) => wrapDegrees(valid.at(-1)[axis] - valid[0][axis]));
	for (let index = 1; index < valid.length; index++) {
		const delta = ["alpha", "beta", "gamma"].map((axis) => wrapDegrees(valid[index][axis] - valid[index - 1][axis]));
		pathDeg += Math.hypot(...delta);
	}
	const netChangeDeg = Math.hypot(...net);
	return {
		spreadDeg: Math.hypot(...axisSpread),
		pathDeg,
		netChangeDeg,
		directionCoherence: pathDeg > 1e-6 ? Math.min(1, netChangeDeg / pathDeg) : 1,
	};
}

function integrateLinearMotion(samples) {
	const valid = samples.filter((sample) => sample.linearAccelerationVector && [sample.linearAccelerationVector.x, sample.linearAccelerationVector.y, sample.linearAccelerationVector.z].every(Number.isFinite));
	if (valid.length < 3) return { displacementM: null, pathLengthM: null, directionCoherence: null };
	const axes = ["x", "y", "z"];
	const medians = Object.fromEntries(axes.map((axis) => [axis, percentile(valid.map((sample) => sample.linearAccelerationVector[axis]), 0.5) ?? 0]));
	const noiseFloors = Object.fromEntries(axes.map((axis) => {
		const residuals = valid.map((sample) => Math.abs(sample.linearAccelerationVector[axis] - medians[axis]));
		return [axis, 1.4826 * (percentile(residuals, 0.5) ?? 0)];
	}));
	let velocity = { x: 0, y: 0, z: 0 };
	let position = { x: 0, y: 0, z: 0 };
	let pathLengthM = 0;
	for (let index = 1; index < valid.length; index++) {
		const previous = valid[index - 1];
		const current = valid[index];
		const dt = (current.timeMs - previous.timeMs) / 1000;
		if (!(dt > 0)) continue;
		if (dt > MAX_MOTION_INTEGRATION_GAP_MS / 1000) {
			velocity = { x: 0, y: 0, z: 0 };
			continue;
		}
		const acceleration = Object.fromEntries(axes.map((axis) => {
			const average = (previous.linearAccelerationVector[axis] + current.linearAccelerationVector[axis]) / 2 - medians[axis];
			const noiseFloor = noiseFloors[axis];
			return [axis, Math.sign(average) * Math.max(0, Math.abs(average) - noiseFloor)];
		}));
		const nextVelocity = { x: velocity.x + acceleration.x * dt, y: velocity.y + acceleration.y * dt, z: velocity.z + acceleration.z * dt };
		const midVelocity = { x: (velocity.x + nextVelocity.x) / 2, y: (velocity.y + nextVelocity.y) / 2, z: (velocity.z + nextVelocity.z) / 2 };
		position = { x: position.x + midVelocity.x * dt, y: position.y + midVelocity.y * dt, z: position.z + midVelocity.z * dt };
		pathLengthM += Math.hypot(midVelocity.x, midVelocity.y, midVelocity.z) * dt;
		velocity = nextVelocity;
	}
	const displacementM = Math.hypot(position.x, position.y, position.z);
	return { displacementM, pathLengthM, directionCoherence: pathLengthM > 1e-6 ? Math.min(1, displacementM / pathLengthM) : 1 };
}

function motionInvariantsFromContext(context) {
	const boundedOrientation = context.orientationSpreadDeg !== null && context.orientationSpreadDeg !== undefined
		&& context.orientationSpreadDeg <= BOUNDED_ORIENTATION_SPREAD_DEG;
	const rotationNet = (context.rotationPathDeg ?? 0) * (context.rotationDirectionCoherence ?? 0);
	const translationDistance = context.estimatedDisplacementM ?? 0;
	const translationPath = context.estimatedPathLengthM ?? 0;
	const translationCoherence = context.translationDirectionCoherence ?? 0;
	const viewHeadingChange = boundedOrientation && rotationNet < 15
		? "no_significant_change"
		: rotationNet >= 15 && (context.rotationDirectionCoherence ?? 0) >= 0.5
			? "significant_change"
			: "unknown";
	let positionChange = "unknown";
	if (boundedOrientation && context.estimatedDisplacementM !== null && context.estimatedDisplacementM !== undefined
		&& context.estimatedPathLengthM !== null && context.estimatedPathLengthM !== undefined) {
		if (translationDistance >= MIN_TRANSLATION_ESTIMATE_M) positionChange = "significant_change";
		else if (translationDistance < MIN_TRANSLATION_ESTIMATE_M && translationPath < 0.35) positionChange = "no_significant_change";
	}
	let travelDirectionChange = "unknown";
	if (positionChange === "significant_change" && translationPath >= MIN_TRANSLATION_ESTIMATE_M) {
		if (translationCoherence >= MIN_TRANSLATION_DIRECTION_COHERENCE) travelDirectionChange = "no_significant_change";
		else if (translationPath >= 0.35 && translationCoherence < 0.4) travelDirectionChange = "significant_change";
	}
	return { positionChange, viewHeadingChange, travelDirectionChange };
}

function motionBudgetClassFromContext(context) {
	const invariants = motionInvariantsFromContext(context);
	const changes = [invariants.positionChange, invariants.viewHeadingChange, invariants.travelDirectionChange]
		.filter((change) => change === "significant_change").length;
	if (changes >= 2) return "irregular";
	if (changes === 1) return "ordered";
	if (invariants.positionChange === "no_significant_change" && invariants.viewHeadingChange === "no_significant_change") return "still";
	return "unknown";
}

function onDeviceMotion(event) {
  const now = performance.now();
  const rotationRate = readRotationRate(event.rotationRate);
  const rotationVector = rotationRate ? { x: rotationRate.alpha, y: rotationRate.beta, z: rotationRate.gamma } : null;
  const linearAccelerationVector = readSensorVector(event.acceleration);
  const rotationRateDps = event.rotationRate
    ? vectorMagnitude({ x: event.rotationRate.alpha, y: event.rotationRate.beta, z: event.rotationRate.gamma })
    : null;
  const linearAccelerationMps2 = vectorMagnitude(linearAccelerationVector);
  if (rotationRateDps === null && linearAccelerationMps2 === null && !event.accelerationIncludingGravity) return;
  state.motion.samples.push({ timeMs: now, rotationRateDps, rotationVector, linearAccelerationMps2, linearAccelerationVector, gravityVector: readSensorVector(event.accelerationIncludingGravity) });
  while (state.motion.samples.length && now - state.motion.samples[0].timeMs > MOTION_SAMPLE_RETENTION_MS) state.motion.samples.shift();
  if (state.live.timer) {
    state.live.pendingMotionSamples.push({
      kind: "motion", timestampMs: Date.now(),
      acceleration: readSensorVector(event.acceleration),
      accelerationIncludingGravity: readSensorVector(event.accelerationIncludingGravity),
      rotationRate: readRotationRate(event.rotationRate),
      intervalMs: Number.isFinite(event.interval) ? event.interval : null,
    });
  }
}

function readSensorVector(value) {
  if (!value) return null;
  return { x: Number.isFinite(value.x) ? value.x : null, y: Number.isFinite(value.y) ? value.y : null, z: Number.isFinite(value.z) ? value.z : null };
}

function readRotationRate(value) {
  if (!value) return null;
  return { alpha: Number.isFinite(value.alpha) ? value.alpha : null, beta: Number.isFinite(value.beta) ? value.beta : null, gamma: Number.isFinite(value.gamma) ? value.gamma : null };
}

function onDeviceOrientation(event) {
  handleOrientation(event, false);
}

/** Android (and some others) can provide an absolute heading; prefer it while it fires. */
function onDeviceOrientationAbsolute(event) {
  handleOrientation(event, true);
}

function handleOrientation(event, isAbsolute) {
  const now = performance.now();
  // Absolute heading (compass): Android absolute alpha, or iOS webkitCompassHeading.
  if (isAbsolute && Number.isFinite(event.alpha)) state.motion.absoluteHeadingDeg = (360 - event.alpha) % 360;
  if (Number.isFinite(event.webkitCompassHeading)) state.motion.absoluteHeadingDeg = event.webkitCompassHeading;
  // If the absolute event is available, ignore the relative one (they would
  // otherwise double-feed the same orientation).
  if (!isAbsolute && state.motion.lastAbsoluteMs && now - state.motion.lastAbsoluteMs < 3000) return;
  if (isAbsolute) state.motion.lastAbsoluteMs = now;
  const orientation = {
    timeMs: now,
    alpha: Number.isFinite(event.alpha) ? event.alpha : null,
    beta: Number.isFinite(event.beta) ? event.beta : null,
    gamma: Number.isFinite(event.gamma) ? event.gamma : null,
  };
  state.motion.orientations.push(orientation);
  while (state.motion.orientations.length && now - state.motion.orientations[0].timeMs > MOTION_SAMPLE_RETENTION_MS) state.motion.orientations.shift();
  if (state.live.timer) {
    state.live.pendingMotionSamples.push({
      kind: "orientation", timestampMs: Date.now(),
      alpha: orientation.alpha, beta: orientation.beta, gamma: orientation.gamma,
      absolute: isAbsolute ? true : (typeof event.absolute === "boolean" ? event.absolute : null),
    });
  }
}

function motionContextForFrame(frameChangeScore) {
  const now = performance.now();
  const recent = state.motion.samples.filter((sample) => now - sample.timeMs <= MOTION_WINDOW_MS);
  const recentOrientations = state.motion.orientations.filter((sample) => now - sample.timeMs <= MOTION_WINDOW_MS);
  const angular = classifyMotionSignal(recent, "rotationRateDps", "rotationVector", ROTATION_ACTIVE_DPS, ROTATION_QUIET_DPS, state.motion.angularState);
  const linear = classifyMotionSignal(recent, "linearAccelerationMps2", "linearAccelerationVector", LINEAR_ACCELERATION_ACTIVE_MPS2, LINEAR_ACCELERATION_QUIET_MPS2, state.motion.linearState);
  const rotation = orientationSummary(recentOrientations);
  const translation = integrateLinearMotion(recent);
  state.motion.angularState = angular.state;
  state.motion.linearState = linear.state;
	const visualViewChange = frameChangeScore === null ? "unknown" : frameChangeScore > ROUTER_STABLE_DELTA ? "high" : "low";
	const sensorMotionActive = angular.state === "active" || linear.state === "active";
  if (sensorMotionActive) state.motion.lastActivityAt = now;
  const recentlyActive = state.motion.lastActivityAt !== null && now - state.motion.lastActivityAt <= MOTION_SETTLE_MS;
	const stability = sensorMotionActive
    ? "moving"
    : recentlyActive
      ? "settling"
			: "unknown";
	const inertialPathCoherent = translation.displacementM !== null && translation.displacementM >= MIN_TRANSLATION_ESTIMATE_M
	&& translation.directionCoherence !== null && translation.directionCoherence >= MIN_TRANSLATION_DIRECTION_COHERENCE
		&& translation.pathLengthM !== null && translation.pathLengthM >= MIN_TRANSLATION_ESTIMATE_M
		&& rotation.spreadDeg !== null && rotation.spreadDeg <= BOUNDED_ORIENTATION_SPREAD_DEG;
	const result = {
    windowMs: MOTION_WINDOW_MS,
    sampleCount: recent.length,
    angularMotion: angular.state === "active" ? "rotating" : angular.state,
    linearAcceleration: linear.state,
    visualViewChange,
		translationLikelihood: inertialPathCoherent ? "possible" : "unknown",
    stability,
    rotationRateDps: angular.magnitude === null ? null : Number(angular.magnitude.toFixed(2)),
    linearAccelerationMps2: linear.magnitude === null ? null : Number(linear.magnitude.toFixed(2)),
	orientationSpreadDeg: rotation.spreadDeg === null ? null : Number(rotation.spreadDeg.toFixed(2)),
	rotationPathDeg: rotation.pathDeg === null ? null : Number(rotation.pathDeg.toFixed(2)),
	rotationDirectionCoherence: rotation.directionCoherence === null ? null : Number(rotation.directionCoherence.toFixed(3)),
		accelerationVariance: linear.variance === null ? null : Number(linear.variance.toFixed(4)),
	estimatedDisplacementM: translation.displacementM === null ? null : Number(translation.displacementM.toFixed(3)),
	estimatedPathLengthM: translation.pathLengthM === null ? null : Number(translation.pathLengthM.toFixed(3)),
	translationDirectionCoherence: translation.directionCoherence === null ? null : Number(translation.directionCoherence.toFixed(3)),
  };
	result.stability = motionBudgetClassFromContext(result) === "still" ? "stable"
		: ["ordered", "irregular"].includes(motionBudgetClassFromContext(result)) ? "moving"
			: result.stability;
	// Lightweight trigger state for the live router (authoritative summary is computed server-side).
	// Use the local motion class (the raw integrator under-reports path), plus the path fallback.
	result.actionActive = result.stability === "moving" || (translation.pathLengthM ?? 0) >= ACTION_PATH_M;
	result.turnActive = Math.abs(rotation.netChangeDeg ?? 0) * (rotation.directionCoherence ?? 0) >= TURN_NET_DEG;
	result.motionSignature = `${result.actionActive ? "A" : "-"}${result.turnActive ? "T" : "-"}`;
	return result;
}

function requestDeviceMotionPermission() {
  const constructor = window.DeviceMotionEvent;
  if (typeof constructor?.requestPermission !== "function") return Promise.resolve("not_required");
  try {
    return Promise.resolve(constructor.requestPermission()).catch(() => "error");
  } catch {
    return Promise.resolve("error");
  }
}

function requestDeviceOrientationPermission() {
  const constructor = window.DeviceOrientationEvent;
  if (typeof constructor?.requestPermission !== "function") return Promise.resolve("not_required");
  try {
    return Promise.resolve(constructor.requestPermission()).catch(() => "error");
  } catch {
    return Promise.resolve("error");
  }
}

function isKnownViewSignature(signature) {
  return state.router.knownViewSignatures.some((known) => {
    const difference = signatureDifference(signature, known);
    return difference !== null && difference <= 0.012;
  });
}

function rememberKnownViewSignature(signature) {
  if (!signature || isKnownViewSignature(signature)) return;
  state.router.knownViewSignatures.push(signature.slice());
  if (state.router.knownViewSignatures.length > 24) state.router.knownViewSignatures.shift();
}

function takeRouterDecision(triggerReason) {
  const stats = state.router.stats;
  state.router.stats = emptyRouterStats();
  return { triggerReason, ...stats, stableFrameCount: state.router.stableFrames };
}

function restoreRouterDecision(decision) {
  const stats = state.router.stats;
  stats.capturedFrames += decision.capturedFrames;
  stats.movingFramesSkipped += decision.movingFramesSkipped;
  stats.sensorMotionGatedFrames += decision.sensorMotionGatedFrames || 0;
  stats.noChangeFramesSkipped += decision.noChangeFramesSkipped;
  stats.familiarSceneFramesSkipped += decision.familiarSceneFramesSkipped || 0;
  stats.stabilityWaits += decision.stabilityWaits;
  if (decision.motionContext) stats.motionContext = decision.motionContext;
  if (decision.frameChangeScore !== null) stats.frameChangeScore = decision.frameChangeScore;
  if (decision.visualNoveltyScore !== undefined) stats.visualNoveltyScore = decision.visualNoveltyScore;
  else if (decision.sceneChangeScore !== undefined) stats.visualNoveltyScore = decision.sceneChangeScore;
}

async function login() {
  const button = $("login-button");
  button.disabled = true;
  setStatus($("login-status"), "正在验证…");
  // Ask for the motion sensors now, while we are still inside the click gesture
  // (iOS requires requestPermission to be called from a gesture); the camera
  // prompt follows right after login.
  void requestDeviceMotionPermission().then((value) => { state.motion.motionPermission = value; });
  void requestDeviceOrientationPermission().then((value) => { state.motion.orientationPermission = value; });
  primeSpeech();
  try {
    const result = await post("/api/login", { passcode: $("passcode").value }, false);
    state.token = result.token;
    state.sessionId = result.sessionId;
    sessionStorage.setItem("vlm-token", state.token);
    sessionStorage.setItem("vlm-session", state.sessionId);
    $("passcode").value = "";
    showApp();
    void syncTaskState().catch((error) => setStatus($("app-status"), error.message, true));
    // Hands-free: begin listening right after login so a blind user never has to tap anything.
    void startVoiceAssistant();
    setStatus($("app-status"), "验证成功，正在开启摄像头并请求权限…");
    void startCamera().catch((error) => setStatus($("app-status"), error.message, true));
  } catch (error) {
    setStatus($("login-status"), error.message, true);
  } finally { button.disabled = false; }
}

async function startCamera({ autoObserve = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前页面无法访问摄像头；请使用 HTTPS 地址并在手机浏览器中打开。");
  const [motionPermission, orientationPermission] = await Promise.all([
    state.motion.motionPermission === "unknown" ? requestDeviceMotionPermission() : Promise.resolve(state.motion.motionPermission),
    state.motion.orientationPermission === "unknown" ? requestDeviceOrientationPermission() : Promise.resolve(state.motion.orientationPermission),
  ]);
  state.motion.motionPermission = motionPermission;
  state.motion.orientationPermission = orientationPermission;
  state.motion.samples = [];
  state.motion.orientations = [];
  state.motion.lastActivityAt = null;
  state.motion.angularState = "unknown";
  state.motion.linearState = "unknown";
  state.router.frameChangeHistory = [];
  state.router.noveltyHistory = [];
  state.router.stableFrames = 0;
  window.addEventListener("devicemotion", onDeviceMotion, { passive: true });
  window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true });
  window.addEventListener("deviceorientationabsolute", onDeviceOrientationAbsolute, { passive: true });
  state.motion.listenerActive = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (error) {
    window.removeEventListener("devicemotion", onDeviceMotion);
    window.removeEventListener("deviceorientation", onDeviceOrientation);
    window.removeEventListener("deviceorientationabsolute", onDeviceOrientationAbsolute);
    state.motion.listenerActive = false;
    throw error;
  }
  $("camera").srcObject = state.stream;
  await $("camera").play();
  $("camera-placeholder").hidden = true;
  $("live-badge").hidden = false;
  $("camera-button").textContent = "关闭摄像头";
  $("capture-button").disabled = false;
  $("auto-analyze").checked = autoObserve;
  updateAutoAnalyze();
  void captureFrame().catch((error) => setStatus($("app-status"), error.message, true));
  startLiveSync();
  startVio();
  updateActionState();
  const motionStatus = motionPermission === "denied" || motionPermission === "error" ? "运动传感器不可用" : "手机运动传感器已请求权限";
  const orientationStatus = orientationPermission === "denied" || orientationPermission === "error" ? "，姿态传感器不可用" : "";
  setStatus($("app-status"), autoObserve
    ? `摄像头已开启；本地自动观察已运行，只有触发分析时才发送截图。${motionStatus}${orientationStatus}。`
    : `摄像头已开启；自动 VLM 观察未启动。${motionStatus}${orientationStatus}。`);
}

function stopCamera() {
  $("auto-analyze").checked = false;
  updateAutoAnalyze();
  if (state.stream) for (const track of state.stream.getTracks()) track.stop();
  window.removeEventListener("devicemotion", onDeviceMotion);
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  window.removeEventListener("deviceorientationabsolute", onDeviceOrientationAbsolute);
  state.motion.listenerActive = false;
  state.motion.samples = [];
  state.motion.orientations = [];
  state.motion.lastActivityAt = null;
  state.motion.angularState = "unknown";
  state.motion.linearState = "unknown";
  void stopLiveSync();
  stopVio();
  state.stream = null;
  $("camera").srcObject = null;
  $("camera-placeholder").hidden = false;
  $("live-badge").hidden = true;
  $("camera-button").textContent = "开启摄像头";
  $("capture-button").disabled = true;
  syncCaptureTimer();
  updateActionState();
}

function updateActionState() {
  const hasGoal = $("goal").value.trim().length > 0;
  const ready = state.frames.length > 0 && !state.busy;
  const micButton = $("mic-button");
  if (micButton) micButton.disabled = false;
  const active = state.request.status === "active";
  const mode = state.request.mode;
  const askButton = $("ask-button");
  askButton.disabled = !ready || !hasGoal;
  askButton.textContent = active && mode === "ask" ? "更新" : "发送";
  const watchButton = $("watch-button");
  watchButton.disabled = !ready || !hasGoal;
  watchButton.textContent = active && mode === "watch" ? "重新关注" : "关注这个情况";
  $("auto-observe-button").disabled = !state.stream;
  $("auto-observe-button").textContent = $("auto-analyze").checked ? "暂停后台记录" : "恢复后台记录";
  $("stop-task-button").disabled = !active;
  $("stop-task-button").textContent = state.pendingTaskStop ? "等待结束…" : "结束要求";
  const kindLabel = { question: "提问", goal: "目标", watch: "关注" };
  const fallbackLabel = mode === "watch" ? "关注" : "提问";
  const reqText = active && state.request.text ? `要求（${kindLabel[state.request.kind] || fallbackLabel}）：${state.request.text}` : "";
  const answerText = state.request.lastAnswer ? `→ ${state.request.lastAnswer}` : "";
  $("task-status").textContent = [reqText, answerText].filter(Boolean).join("\n") || "当前没有用户要求。";
  $("buffer-count").textContent = `${state.frames.length} / ${FRAME_BUFFER_MAX}`;
  $("scene-status").textContent = state.sceneStatus;
  $("change-status").textContent = state.changeStatus;
  updateDiagnostics();
}

function permissionLabel(value) {
  return { granted: "已授权", denied: "被拒绝", error: "不可用", not_required: "无需授权", unknown: "未知" }[value] || value || "未知";
}

/** Small readout of the real permissions and whether data is actually flowing. */
function updateDiagnostics() {
  const el = $("diagnostics");
  if (!el) return;
  const video = $("camera");
  const camera = state.stream ? `已开启 ${video.videoWidth || "?"}×${video.videoHeight || "?"}` : "未开启";
  const motion = state.motion.listenerActive
    ? `${permissionLabel(state.motion.motionPermission)}（采样 ${state.motion.samples.length}）`
    : permissionLabel(state.motion.motionPermission);
  const orientation = state.motion.listenerActive
    ? `${permissionLabel(state.motion.orientationPermission)}（${state.motion.orientations.length}）`
    : permissionLabel(state.motion.orientationPermission);
  el.textContent = `摄像头：${camera}\n运动传感器：${motion}\n姿态传感器：${orientation}\n截图缓冲：${state.frames.length} 帧 · VIO 特征：${state.vio.features.length}`;
}

function renderFrames() {
  const container = $("thumbnails");
  container.replaceChildren();
  for (const [index, frame] of state.frames.slice(-8).entries()) {
    const tile = document.createElement("div");
    tile.className = "thumb";
    const image = document.createElement("img");
    image.src = frame.previewUrl;
    image.alt = `截图 ${index + 1}`;
    const caption = document.createElement("span");
    caption.textContent = `${new Date(frame.timestampMs).toLocaleTimeString()} · 清晰度估值 ${(frame.quality.sharpness * 100).toFixed(0)}%`;
    tile.append(image, caption);
    container.append(tile);
  }
  updateActionState();
}

async function captureFrame() {
  if (state.captureBusy) return;
  const video = $("camera");
  if (!state.stream || video.videoWidth === 0) return;
  state.captureBusy = true;
  try {
    const scale = Math.min(1, 640 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    const signature = makeFrameSignature(canvas);
    const quality = measureFrameQuality(canvas);
    const previous = state.frames.at(-1);
    const frameChangeScore = signatureDifference(signature, previous?.signature ?? null);
    if (frameChangeScore !== null) {
      state.router.frameChangeHistory.push(frameChangeScore);
      if (state.router.frameChangeHistory.length > ROUTER_VISUAL_WINDOW) state.router.frameChangeHistory.shift();
    }
    const motionContext = motionContextForFrame(frameChangeScore);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
    if (!blob) throw new Error("截图编码失败");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    const frame = { id: crypto.randomUUID(), timestampMs: Date.now(), mimeType: "image/jpeg", dataBase64: btoa(binary), previewUrl: URL.createObjectURL(blob), signature, visualSignature: encodeSignature(signature), frameChangeScore, motionContext, quality };
    state.frames.push(frame);
    while (state.frames.length > FRAME_BUFFER_MAX) {
      const removed = state.frames.shift();
      URL.revokeObjectURL(removed.previewUrl);
    }
    if (state.live.timer) state.live.pendingFrames.push({ timestampMs: frame.timestampMs, width: canvas.width, height: canvas.height, mimeType: frame.mimeType, dataBase64: frame.dataBase64, quality: frame.quality });
    renderFrames();
    evaluateRouter(frame);
  } finally { state.captureBusy = false; }
}

function evaluateRouter(frame) {
  if (!$("auto-analyze").checked) return;
  const router = state.router;
  const stats = router.stats;
  stats.capturedFrames++;
  const frameChange = frame.frameChangeScore;
  const visualNovelty = signatureDifference(frame.signature, router.baselineSignature);
  const motion = frame.motionContext;
  const motionClass = motionBudgetClassFromContext(motion);
  stats.frameChangeScore = frameChange;
  stats.visualNoveltyScore = visualNovelty;
  stats.motionContext = motion;

  if (visualNovelty !== null) {
    router.noveltyHistory.push(visualNovelty);
    if (router.noveltyHistory.length > ROUTER_VISUAL_WINDOW) router.noveltyHistory.shift();
  }
  const recentChanges = router.frameChangeHistory;
  const stableVisualVotes = recentChanges.filter((change) => change <= ROUTER_STABLE_DELTA).length;
  const changedVisualVotes = recentChanges.filter((change) => change > ROUTER_STABLE_DELTA).length;
  const visualStable = recentChanges.length >= ROUTER_VISUAL_PERSISTENCE && stableVisualVotes >= ROUTER_VISUAL_PERSISTENCE;
  const visualMotionPersistent = recentChanges.length >= ROUTER_VISUAL_PERSISTENCE && changedVisualVotes >= ROUTER_VISUAL_PERSISTENCE;
  const persistentNovelty = router.noveltyHistory.length >= ROUTER_VISUAL_PERSISTENCE
    && router.noveltyHistory.filter((change) => change >= ROUTER_VISUAL_NOVELTY_DELTA).length >= ROUTER_VISUAL_PERSISTENCE;
  const sensorMotionGated = ["ordered", "irregular"].includes(motionClass);
  if (sensorMotionGated) {
    router.stableFrames = 0;
    stats.sensorMotionGatedFrames++;
    stats.stabilityWaits++;
  } else if (visualStable || motionClass === "still") router.stableFrames++;
  else {
    router.stableFrames = Math.max(0, router.stableFrames - 1);
    if (visualMotionPersistent) stats.movingFramesSkipped++;
  }

  if (router.stableFrames < 1 && !sensorMotionGated && !visualStable) stats.stabilityWaits++;
  else if (visualNovelty !== null && visualNovelty < ROUTER_VISUAL_NOVELTY_DELTA) stats.noChangeFramesSkipped++;

  const now = frame.timestampMs;
  const sinceAnalysis = now - router.lastAnalysisMs;
  const sinceAwarenessCheck = now - Math.max(router.lastAnalysisMs, router.lastTriggerAt);
  const cooledDown = now - router.lastTriggerAt >= ROUTER_COOLDOWN_MS;
  const awarenessActive = state.activeWatch?.status !== "idle" && Boolean(state.activeWatch?.condition);
  const motionSignature = motion?.motionSignature ?? "--";
  const motionChanged = router.motionSignature !== null && router.motionSignature !== motionSignature;
  let triggerReason = null;
  if (state.activeWatch?.status === "suspected" && router.stableFrames >= 1 && now - (state.activeWatch.lastCheckedAt || 0) >= Math.max(5_000, CAPTURE_INTERVAL_MS)) triggerReason = "watch_recheck";
  else if (awarenessActive && sinceAwarenessCheck >= AWARENESS_RECHECK_INTERVAL_MS) triggerReason = "awareness_periodic_check";
  else if (!router.baselineSignature && router.stableFrames >= 1) triggerReason = "initial_stable_scene";
  else if (motionChanged && sinceAnalysis >= ROUTER_MIN_INTERVAL_MS) triggerReason = "motion_change";
  else if (router.baselineSignature && persistentNovelty && router.stableFrames >= 1 && sinceAnalysis >= ROUTER_MIN_INTERVAL_MS) {
    if (isKnownViewSignature(frame.signature)) {
      stats.familiarSceneFramesSkipped++;
      router.baselineSignature = frame.signature;
      router.lastAnalysisMs = now;
      router.noveltyHistory = [];
      state.monitorCursorMs = frame.timestampMs;
      return;
    }
    triggerReason = "visual_change_after_stabilization";
  }

  if (!triggerReason || !cooledDown) return;
  router.lastTriggerAt = now;
  router.motionSignature = motionSignature;
  if (state.busy) {
    state.pendingMonitorReason = triggerReason;
    setStatus($("app-status"), "检测到新画面变化，当前分析结束后会补看。");
    return;
  }
  void analyzeFrames("monitor", true, null, triggerReason);
}

function startAutoCapture() {
  syncCaptureTimer();
}

function stopAutoCapture() {
  syncCaptureTimer();
}

function syncCaptureTimer() {
  // Capture continuously whenever the camera is on, so every frame can be saved;
  // automatic VLM observation is still gated separately by the auto-analyze flag.
  const shouldCapture = Boolean(state.stream);
  if (shouldCapture && !state.captureTimer) {
    state.captureTimer = window.setInterval(() => { void captureFrame().catch((error) => setStatus($("app-status"), error.message, true)); }, CAPTURE_INTERVAL_MS);
  } else if (!shouldCapture && state.captureTimer) {
    window.clearInterval(state.captureTimer);
    state.captureTimer = null;
  }
}

async function flushLiveBatch() {
  const live = state.live;
  if (!state.token || (!live.pendingFrames.length && !live.pendingMotionSamples.length)) return;
  const batch = {
    frames: live.pendingFrames.splice(0, 8),
    motionSamples: live.pendingMotionSamples.splice(0, 5_000),
  };
  try { await post("/api/live/batch", batch); }
  catch (error) { setStatus($("app-status"), `后台保存失败：${error.message}`, true); }
}

function startLiveSync() {
  if (state.live.timer) return;
  state.live.timer = window.setInterval(() => { void flushLiveBatch(); }, LIVE_SYNC_INTERVAL_MS);
}

async function stopLiveSync() {
  if (state.live.timer) { window.clearInterval(state.live.timer); state.live.timer = null; }
  await flushLiveBatch().catch(() => {});
}

function vioTick() {
  const video = $("camera");
  if (!state.stream || !video.videoWidth) return;
  const vio = state.vio;
  if (!vio.canvas) {
    vio.canvas = document.createElement("canvas");
    vio.canvas.width = VIO_WIDTH;
    vio.canvas.height = VIO_HEIGHT;
    vio.ctx = vio.canvas.getContext("2d", { willReadFrequently: true });
  }
  vio.ctx.drawImage(video, 0, 0, VIO_WIDTH, VIO_HEIGHT);
  const rgba = vio.ctx.getImageData(0, 0, VIO_WIDTH, VIO_HEIGHT).data;
  const gray = new Uint8ClampedArray(VIO_WIDTH * VIO_HEIGHT);
  for (let i = 0; i < gray.length; i++) { const j = i * 4; gray[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0; }
  const now = performance.now();
  if (vio.prevGray && window.VioMotion) {
    const s = window.VioMotion.summarizeFlow(window.VioMotion.blockFlow(vio.prevGray, gray, VIO_WIDTH, VIO_HEIGHT, { block: 16, step: 16, search: 16 }), VIO_WIDTH, VIO_HEIGHT, 16);
    const latest = state.motion.orientations.at(-1);
    const lastMotion = state.motion.samples.at(-1);
    let dYaw = 0;
    const dtSec = vio.prevTickMs ? Math.min(0.25, Math.max(0, (now - vio.prevTickMs) / 1000)) : 0;
    // Yaw from the ABSOLUTE heading (compass) when available — it does not accumulate
    // drift. Gyro is only a short-term fallback; relative alpha is the last resort.
    const absHeading = state.motion.absoluteHeadingDeg;
    if (Number.isFinite(absHeading)) {
      if (vio.prevAbsHeading !== null) dYaw = wrapDegrees(absHeading - vio.prevAbsHeading);
      vio.prevAbsHeading = absHeading;
    } else if (lastMotion && now - lastMotion.timeMs < 500 && lastMotion.rotationVector && Number.isFinite(lastMotion.rotationVector.x) && dtSec > 0) {
      dYaw = lastMotion.rotationVector.x * dtSec;
    } else if (latest && vio.prevAlpha !== null && Number.isFinite(latest.alpha)) {
      dYaw = wrapDegrees(latest.alpha - vio.prevAlpha);
    }
    if (latest && Number.isFinite(latest.alpha)) vio.prevAlpha = latest.alpha;
    vio.prevTickMs = now;
    vio.features.push({ t: (now - vio.startMs) / 1000, expansion: s.expansion, globalDx: s.globalDx, globalDy: s.globalDy, dYaw, edge: s.fracAtEdge });
    const cutoff = (now - vio.startMs - VIO_BUFFER_MS) / 1000;
    while (vio.features.length && vio.features[0].t < cutoff) vio.features.shift();
  }
  vio.prevGray = gray;
}

function startVio() {
  if (state.vio.timer) return;
  state.vio.startMs = performance.now();
  state.vio.features = [];
  state.vio.prevGray = null;
  state.vio.prevAlpha = null;
  state.vio.prevTickMs = 0;
  state.vio.prevAbsHeading = null;
  state.vio.lastPlaceMs = 0;
  state.vio.timer = window.setInterval(vioTick, VIO_INTERVAL_MS);
  state.vio.placeTimer = window.setInterval(() => { void maybeObserveScene(); void maybeObserveSceneChange(); void stepRequest(); updateDiagnostics(); }, 5_000);
}

function stopVio() {
  if (state.vio.timer) { window.clearInterval(state.vio.timer); state.vio.timer = null; }
  if (state.vio.placeTimer) { window.clearInterval(state.vio.placeTimer); state.vio.placeTimer = null; }
}

/** Fuses IMU + camera VIO into a natural-language motion description for the last window. */
function currentMotionDescription() {
  const vio = state.vio;
  let text = null;
  if (window.VioMotion && vio.features.length >= 20) {
    const segments = window.VioMotion.fuseMotion(vio.features);
    text = segments.length ? window.VioMotion.describeMotion(segments) : null;
  }
  if (text && typeof state.motion.absoluteHeadingDeg === "number" && Number.isFinite(state.motion.absoluteHeadingDeg)) {
    text += ` Absolute heading: ${compassSector(state.motion.absoluteHeadingDeg)}.`;
  }
  return text;
}

/** 8-way compass sector from a heading in degrees (0 = north, clockwise). */
function compassSector(degrees) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((degrees % 360) + 360) % 360) / 45) % 8];
}

/**
 * Picks a small, non-redundant set of frames that still *covers* the recent
 * window: always the oldest and newest, then greedily the frames most different
 * from everything chosen so far (farthest-point over the visual signature).
 */
function selectObservationFrames(maxCount = 4, windowMs = 12_000) {
  const now = Date.now();
  let pool = state.frames.filter((frame) => now - frame.timestampMs <= windowMs);
  if (!pool.length) pool = state.frames.slice(-maxCount);
  if (pool.length <= maxCount) return pool.slice();
  const chosen = [pool[0], pool[pool.length - 1]];
  const remaining = pool.slice(1, -1);
  while (chosen.length < maxCount && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      let minDiff = Infinity;
      for (const picked of chosen) {
        const diff = signatureDifference(remaining[i].signature, picked.signature) ?? 0;
        if (diff < minDiff) minDiff = diff;
      }
      if (minDiff > bestScore) { bestScore = minDiff; bestIndex = i; }
    }
    chosen.push(remaining.splice(bestIndex, 1)[0]);
  }
  return chosen.sort((a, b) => a.timestampMs - b.timestampMs);
}

/** The selected frames in the upload payload shape. */
function framesForUpload(maxCount = 4, windowMs = 12_000) {
  return selectObservationFrames(maxCount, windowMs).map((frame) => ({ id: frame.id, timestampMs: frame.timestampMs, mimeType: frame.mimeType, dataBase64: frame.dataBase64, quality: frame.quality }));
}

/** Role 1: scene recording. Runs when the phone moved, or once to establish the first stable scene. */
async function maybeObserveScene() {
  const vio = state.vio;
  if (!state.token || state.busy || !window.VioMotion || vio.features.length < 20) return;
  const segments = window.VioMotion.fuseMotion(vio.features);
  const hasMotion = segments.some((segment) => segment.kind !== "still");
  if (!hasMotion) {
    // No motion: only allow the very first, stable view so the scene-change line
    // has a scene to compare against.
    if (state.sceneId !== null || state.frames.length < 3) return;
    const recent = state.frames.slice(-3);
    if (!recent.every((frame) => (signatureDifference(frame.signature, recent[0].signature) ?? 1) <= 0.03)) return;
  }
  const now = Date.now();
  if (now - vio.lastPlaceMs < 10_000) return;
  vio.lastPlaceMs = now;
  const frames = framesForUpload(4, 12_000);
  if (!frames.length) return;
  try {
    const result = await post("/api/scene", { frames, motionDescription: currentMotionDescription() });
    const tag = result.isNew ? "，新场景" : result.revisited ? "，回到已知场景" : "，同一场景";
    state.sceneStatus = `${result.label}${tag}`;
    state.sceneLabel = result.label ?? null;
    state.sceneId = result.sceneId ?? null;
    state.vio.lastSceneChangeMs = Date.now();
    setStatus($("app-status"), `场景：${state.sceneStatus}`);
    updateActionState();
    // Coupled: the scene agent just confirmed the place, so check it for changes
    // now, using the same frames (no separate still window needed).
    if (!result.isNew && state.sceneId) void runSceneChange(frames, state.sceneId);
  } catch (error) {
    setStatus($("app-status"), `场景记录失败：${error.message}`, true);
  }
}

/** Sends one current view to the change agent and records the result. */
async function runSceneChange(frames, sceneId) {
  try {
    const result = await post("/api/scene-change", {
      frames,
      sceneId,
      motionDescription: currentMotionDescription(),
      ...(state.sceneLabel ? { sceneLabel: state.sceneLabel } : {}),
    });
    const via = result.via ? (result.via === "pixels" ? "像素" : "VLM") : "";
    const detail = result.detection ? `（对齐 ${result.detection.overlapRatio}，变化 ${(result.detection.changedRatio * 100).toFixed(1)}%，${result.detection.regionCount} 区）` : "";
    state.changeStatus = result.baselineSet ? "已建立基线" : result.changed ? `${result.what ?? "有变化"}${via ? `·${via}` : ""}${detail}` : `${result.reason ?? "无变化"}${detail}`;
    if (result.changed) setStatus($("app-status"), `场景内变化：${state.changeStatus}`);
    updateActionState();
  } catch (error) {
    setStatus($("app-status"), `场景变化检测失败：${error.message}`, true);
  }
}

/** Role 2 periodic check: while still and stable, look for in-scene changes. */
async function maybeObserveSceneChange() {
  const vio = state.vio;
  if (!state.token || state.busy) return;
  if (!state.sceneId) return; // wait until the scene agent has decided which place this is
  if (state.frames.length < 3) return;
  const now = Date.now();
  if (now - vio.lastSceneChangeMs < 10_000) return;
  const recent = state.frames.slice(-3);
  const stable = recent.every((frame) => (signatureDifference(frame.signature, recent[0].signature) ?? 1) <= 0.03);
  if (!stable) return;
  if (window.VioMotion && vio.features.length >= 20) {
    const segments = window.VioMotion.fuseMotion(vio.features);
    if (segments.some((segment) => segment.kind !== "still")) return; // wait until the phone is still
  }
  const latest = state.frames.at(-1);
  if (vio.lastSceneSignature && (signatureDifference(latest.signature, vio.lastSceneSignature) ?? 1) <= 0.02) return;
  vio.lastSceneChangeMs = now;
  vio.lastSceneSignature = latest.signature ?? null;
  const frames = [{ id: latest.id, timestampMs: latest.timestampMs, mimeType: latest.mimeType, dataBase64: latest.dataBase64, quality: latest.quality }];
  await runSceneChange(frames, state.sceneId);
}

function hasFrameRelativeDirection(text) {
  const direction = "(?:左|右|上|下)(?:边|側|侧|方|角)?";
  const imageReference = "(?:图片|画面|图像|照片|截图|屏幕|image|picture|frame|screen)";
  return new RegExp(`${imageReference}.{0,10}${direction}|${direction}.{0,10}${imageReference}`, "i").test(text)
    || /(?:你|用户)(?:的)?(?:左|右)(?:手)?(?:边|侧)|(?:to|on)\s+(?:your|the user's)\s+(?:left|right)(?:\s+side)?/i.test(text);
}

function renderResult(result) {
  $("result-card").hidden = false;
  const budgetLabel = result.inferenceBudget === "deep" || result.mode === "deep" ? "深度推理预算" : "节省推理预算";
  const attentionLabels = { quiet: "安静", awareness: "环境感知", task: "任务协助", explore: "主动了解" };
  const attentionLabel = attentionLabels[result.attentionMode] || "环境感知";
  $("decision").textContent = result.decision === "silent"
    ? (result.mode === "monitor" && result.changed === false ? "画面无明显变化 · 保持安静" : "本次不提示")
    : (({ answer: result.userInitiated ? "回答" : "主动提示", clarify: "需要澄清" })[result.decision] || result.decision);
  $("decision").dataset.kind = result.decision;
  $("response").textContent = result.response || "（本次不提示）";
  const thinkingLabel = result.thinkingEnabled === null ? "思考模式未配置" : result.thinkingEnabled ? "思考开启" : "思考关闭";
  $("latency").textContent = `${attentionLabel} · ${budgetLabel} · 覆盖 ${(result.inputWindowMs / 1000).toFixed(1)} 秒 · ${thinkingLabel} · ${(result.latencyMs / 1000).toFixed(1)} 秒 · ${result.model}`;
  const list = $("observations");
  list.replaceChildren();
  const observationKindLabels = { scene: "场景", object: "物体", text: "文字", person: "人物", change: "变化", activity: "活动区间", uncertainty: "不确定区间" };
  for (const item of result.observations || []) {
    if (hasFrameRelativeDirection(item.content)) continue;
    const row = document.createElement("div");
    row.className = "observation";
    const title = document.createElement("strong");
    title.textContent = observationKindLabels[item.kind] || item.kind;
    const content = document.createElement("p");
    content.textContent = item.content;
    const meta = document.createElement("small");
    const historicalLabel = item.status === "uncertain" ? "历史截图证据（不代表目前仍在此处） · " : "";
    meta.textContent = `${historicalLabel}置信度 ${(item.confidence * 100).toFixed(0)}% · 证据 ${item.frameIds.join(", ")}`;
    row.append(title, content, meta);
    list.append(row);
  }
  const timelinePanel = $("motion-timeline");
  const timelineItems = $("motion-timeline-items");
  timelineItems.replaceChildren();
  const patternLabels = { low_motion: "低运动／相对稳定", rotation_dominant: "旋转主导", translation_candidate: "疑似平移", stationary_jitter_candidate: "静止伴抖动（候选）", mixed_or_unknown: "混合或不确定" };
  const invariantLabels = { significant_change: "显著变化", no_significant_change: "无显著变化证据", unknown: "未知" };
  for (const segment of result.motionTimeline || []) {
    const row = document.createElement("div");
    row.className = "motion-segment";
    const heading = document.createElement("strong");
    heading.textContent = `${(segment.startMs / 1000).toFixed(0)}–${(segment.endMs / 1000).toFixed(0)} 秒 · ${patternLabels[segment.pattern] || segment.pattern}`;
    const detail = document.createElement("small");
    const translationLabels = { possible: "可能", not_detected: "未检出", unknown: "未知" };
    const varianceLabels = { elevated: "较大", low: "较低", unknown: "未知" };
    const confidenceLabels = { medium: "中", low: "低" };
    detail.textContent = `朝向：${invariantLabels[segment.viewHeadingChange] || segment.viewHeadingChange}；平移证据：${translationLabels[segment.translationEvidence] || segment.translationEvidence}；运动波动：${varianceLabels[segment.motionVariance] || segment.motionVariance}；置信度：${confidenceLabels[segment.confidence] || segment.confidence}；截图：${(segment.representativeFrameIds || []).join(", ") || "未选入模型帧"}`;
    row.append(heading, detail);
    timelineItems.append(row);
  }
  timelinePanel.hidden = !result.motionTimeline?.length;
  $("raw-decision").textContent = JSON.stringify({ attentionMode: result.attentionMode, inferenceBudget: result.inferenceBudget, userInitiated: result.userInitiated, routerDecision: result.routerDecision, frameMotionContexts: result.frameMotionContexts, motionTimeline: result.motionTimeline, frameGate: result.frameGate, visualMemoryFrameIds: result.visualMemoryFrameIds, ...result.rawPerception, policyDecision: result.policyDecision, policyAction: result.policyAction }, null, 2);
  state.activeTask = result.task ?? state.activeTask;
  state.activeWatch = result.watch ?? state.activeWatch;
  state.lastRunId = result.runId;
  for (const select of document.querySelectorAll("[data-feedback]")) select.value = "";
  $("feedback-notes").value = "";
  setStatus($("feedback-status"), "");
  updateActionState();
}

function hasMotionEvidence(frame) {
	const motion = frame.motionContext;
	if (!motion) return false;
	return ["ordered", "irregular"].includes(motionBudgetClassFromContext(motion));
}

function compactNearDuplicateFrames(frames) {
	const compact = [];
	let anchor = null;
	let anchorIndex = -1;
	for (const frame of frames) {
		const difference = anchor ? signatureDifference(frame.signature, anchor.signature) : null;
		if (anchor && difference !== null && difference <= 0.008 && !hasMotionEvidence(frame) && !hasMotionEvidence(anchor)) {
			compact[anchorIndex] = frame;
			continue;
		}
		compact.push(frame);
		anchor = frame;
		anchorIndex = compact.length - 1;
	}
	return compact;
}

function spreadFrames(frames, limit) {
	const distinct = compactNearDuplicateFrames(frames);
	if (distinct.length <= limit) return distinct;
	if (limit <= 1) return [distinct.at(-1)];
	const quality = (frame) => frame.quality.sharpness * 0.85 + frame.quality.exposure * 0.15;
	const motionScore = (frame) => {
		const motion = frame.motionContext;
		if (!motion) return 0;
		const rotationNetDeg = (motion.rotationPathDeg ?? 0) * (motion.rotationDirectionCoherence ?? 0);
		const alignedPath = (motion.estimatedDisplacementM ?? 0) >= MIN_TRANSLATION_ESTIMATE_M
			&& (motion.translationDirectionCoherence ?? 0) >= MIN_TRANSLATION_DIRECTION_COHERENCE;
		const varianceEvidence = Math.min(0.15, Math.sqrt(Math.max(0, motion.accelerationVariance ?? 0)) / 10);
		return Math.min(1, (rotationNetDeg >= 15 ? 0.4 : 0) + (alignedPath ? 0.45 : 0) + varianceEvidence);
	};
	const duration = Math.max(1, distinct.at(-1).timestampMs - distinct[0].timestampMs);
	const selected = [distinct[0], distinct.at(-1)];
  while (selected.length < limit) {
    let best = null;
    let bestScore = -Infinity;
		for (const candidate of distinct) {
      if (selected.includes(candidate)) continue;
      const diversity = Math.min(...selected.map((frame) => signatureDifference(candidate.signature, frame.signature) ?? 0));
      const timeCoverage = Math.min(...selected.map((frame) => Math.abs(candidate.timestampMs - frame.timestampMs))) / duration;
			const score = 0.40 * quality(candidate) + 0.25 * diversity + 0.10 * timeCoverage + 0.25 * motionScore(candidate);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (!best) break;
    selected.push(best);
  }
  return selected.sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Rotates a device-frame vector into the world frame (W3C Z-X'-Y''). */
function deviceToWorldVector(orientation, vector) {
  const alpha = orientation.alpha * Math.PI / 180, beta = orientation.beta * Math.PI / 180, gamma = orientation.gamma * Math.PI / 180;
  const ca = Math.cos(alpha), sa = Math.sin(alpha), cb = Math.cos(beta), sb = Math.sin(beta), cg = Math.cos(gamma), sg = Math.sin(gamma);
  return {
    x: (ca * cg - sa * sb * sg) * vector.x + (-sa * cb) * vector.y + (ca * sg + sa * sb * cg) * vector.z,
    y: (sa * cg + ca * sb * sg) * vector.x + (ca * cb) * vector.y + (sa * sg - ca * sb * cg) * vector.z,
    z: (-cb * sg) * vector.x + sb * vector.y + (cb * cg) * vector.z,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.5 * sorted.length) - 1))];
}

/** Computes the session calibration (gravity direction, gyro bias, noise) from the earliest retained samples. */
function computeSessionCalibration() {
  const samples = state.motion.samples;
  if (samples.length < 30) return null;
  const start = samples[0].timeMs;
  const windowSamples = samples.filter((sample) => sample.timeMs <= start + 3000);
  const orientations = state.motion.orientations.filter((orientation) => orientation.timeMs <= start + 3000);
  if (windowSamples.length < 10 || orientations.length < 5) return null;
  const nearest = (timeMs) => {
    let best = null, bestDistance = Infinity;
    for (const orientation of orientations) {
      const distance = Math.abs(orientation.timeMs - timeMs);
      if (distance < bestDistance) { bestDistance = distance; best = orientation; }
    }
    return best;
  };
  const worldGravities = [];
  let gyroSum = { x: 0, y: 0, z: 0 }, gyroCount = 0;
  for (const sample of windowSamples) {
    const orientation = nearest(sample.timeMs);
    if (orientation && sample.gravityVector && [sample.gravityVector.x, sample.gravityVector.y, sample.gravityVector.z].every(Number.isFinite)) {
      worldGravities.push(deviceToWorldVector(orientation, sample.gravityVector));
    }
    if (sample.rotationVector && [sample.rotationVector.x, sample.rotationVector.y, sample.rotationVector.z].every(Number.isFinite)) {
      gyroSum.x += sample.rotationVector.x; gyroSum.y += sample.rotationVector.y; gyroSum.z += sample.rotationVector.z; gyroCount++;
    }
  }
  if (worldGravities.length < 10 || gyroCount < 10) return null;
  const gravityWorld = {
    x: worldGravities.reduce((sum, v) => sum + v.x, 0) / worldGravities.length,
    y: worldGravities.reduce((sum, v) => sum + v.y, 0) / worldGravities.length,
    z: worldGravities.reduce((sum, v) => sum + v.z, 0) / worldGravities.length,
  };
  const accelerationNoiseMps2 = Math.sqrt(worldGravities.reduce((sum, v) => sum + (v.x - gravityWorld.x) ** 2 + (v.y - gravityWorld.y) ** 2 + (v.z - gravityWorld.z) ** 2, 0) / worldGravities.length);
  const gyroBiasDps = { x: gyroSum.x / gyroCount, y: gyroSum.y / gyroCount, z: gyroSum.z / gyroCount };
  const gyroNoiseDps = median(windowSamples
    .filter((sample) => sample.rotationVector && [sample.rotationVector.x, sample.rotationVector.y, sample.rotationVector.z].every(Number.isFinite))
    .map((sample) => Math.hypot(sample.rotationVector.x - gyroBiasDps.x, sample.rotationVector.y - gyroBiasDps.y, sample.rotationVector.z - gyroBiasDps.z)));
  return { gravityWorld, gyroBiasDps, accelerationNoiseMps2, gyroNoiseDps, stable: accelerationNoiseMps2 < 0.6 && gyroNoiseDps < 15 };
}

/** Builds the raw IMU rows for the last windowMs, for server-side motion analysis. */
function collectMotionSamplesForWindow(windowMs) {
  const now = performance.now();
  const start = now - windowMs;
  const rows = [];
  for (const sample of state.motion.samples) {
    if (sample.timeMs < start) continue;
    rows.push({
      kind: "motion",
      timeMs: Math.round(sample.timeMs - start),
      intervalMs: null,
      acceleration: sample.linearAccelerationVector ?? null,
      accelerationIncludingGravity: sample.gravityVector ?? null,
      rotationRate: sample.rotationVector ?? null,
    });
  }
  for (const orientation of state.motion.orientations) {
    if (orientation.timeMs < start) continue;
    rows.push({ kind: "orientation", timeMs: Math.round(orientation.timeMs - start), alpha: orientation.alpha, beta: orientation.beta, gamma: orientation.gamma, absolute: null });
  }
  return rows;
}

async function analyzeFrames(requestedMode = null, automatic = false, requestedGoal = null, triggerReason = null, requestedAttentionMode = null) {
  if (!state.frames.length) return;
  const typedGoal = requestedGoal ?? $("goal").value.trim();
  const mode = requestedMode || (typedGoal ? "deep" : "monitor");
  if (mode === "deep" && !typedGoal) {
    setStatus($("app-status"), "请先填写要询问 VLM 的问题。", true);
    return;
  }
  if (state.busy) {
    if (mode === "deep") {
      state.pendingDeepGoal = typedGoal;
      state.pendingDeepReason = triggerReason || "user_request";
      updateActionState();
      setStatus($("app-status"), "已提交目标，当前分析结束后会用最新截图继续处理。");
    } else if (automatic) state.pendingMonitorReason = triggerReason || "visual_change";
    return;
  }
  let candidateFrames;
  let nextMonitorCursor = null;
  if (mode === "monitor") {
    const startMs = state.monitorCursorMs ?? (Date.now() - MONITOR_MAX_WINDOW_MS);
    candidateFrames = state.frames.filter((frame) => frame.timestampMs > startMs);
    if (candidateFrames.length === 0) {
      if (!automatic) setStatus($("app-status"), "上次检查后没有新截图，本次跳过分析。");
      return;
    }
    nextMonitorCursor = candidateFrames[candidateFrames.length - 1].timestampMs;
  } else {
    const count = Number($("frame-count").value);
    candidateFrames = state.frames.slice(-count);
  }
  const candidates = mode === "monitor" ? spreadFrames(candidateFrames, MONITOR_MAX_FRAMES) : candidateFrames;
  const selected = candidates.map(({ id, timestampMs, mimeType, dataBase64, quality, visualSignature, motionContext }) => ({ id, timestampMs, mimeType, dataBase64, quality: { ...quality, visualSignature }, ...(motionContext ? { motionContext } : {}) }));
  const routerDecision = takeRouterDecision(triggerReason || (mode === "deep" ? "user_request" : "manual_check"));
  const hasCurrentTask = state.activeTask?.status === "active";
	  const attentionMode = requestedAttentionMode || (mode === "deep"
    ? (typedGoal ? "task" : "explore")
    : automatic
      ? (hasCurrentTask ? "task" : state.activeWatch?.status !== "idle" && state.activeWatch?.condition ? "awareness" : "quiet")
	      : (hasCurrentTask ? "task" : "explore"));
  const userInitiated = !automatic;
	  state.currentRequestMode = attentionMode;
  state.busy = true;
  updateActionState();
  const windowSeconds = ((candidateFrames[candidateFrames.length - 1].timestampMs - candidateFrames[0].timestampMs) / 1000).toFixed(1);
  setStatus($("app-status"), `正在分析 ${windowSeconds} 秒时间窗中的 ${selected.length} 帧…`);
  try {
    const motionSamples = collectMotionSamplesForWindow(MOTION_WINDOW_MS);
    const motionWindowEndMs = Date.now();
    if (!state.motion.calibration) state.motion.calibration = computeSessionCalibration();
    const motionDescription = currentMotionDescription();
    const result = await post("/api/observe", { mode, goal: mode === "deep" ? typedGoal : "", attentionMode, userInitiated, routerDecision, frames: selected, ...(motionSamples.length >= 30 ? { motionSamples, motionWindowEndMs } : {}), ...(state.motion.calibration ? { motionCalibration: state.motion.calibration } : {}), ...(motionDescription ? { motionDescription } : {}) });
    result.routerDecision = routerDecision;
    result.frameMotionContexts = selected.map(({ id, motionContext }) => ({ frameId: id, motionContext: motionContext ?? null }));
    state.monitorCursorMs = nextMonitorCursor ?? candidateFrames[candidateFrames.length - 1].timestampMs;
    state.router.baselineSignature = candidateFrames[candidateFrames.length - 1].signature;
    state.router.frameChangeHistory = [];
    state.router.noveltyHistory = [];
    state.router.lastAnalysisMs = Date.now();
    if (result.attentionMode === "quiet" && !result.userInitiated && candidateFrames.at(-1).quality.sharpness >= 0.12) rememberKnownViewSignature(candidateFrames.at(-1).signature);
    renderResult(result);
    setStatus($("app-status"), `结果已保存到实验记录。Session ${result.sessionId}`);
  } catch (error) {
    restoreRouterDecision(routerDecision);
    setStatus($("app-status"), error.message, true);
  } finally {
    state.busy = false;
	  state.currentRequestMode = null;
    if (state.pendingTaskStop) {
      state.pendingTaskStop = false;
      state.pendingDeepGoal = null;
      state.pendingDeepReason = null;
      state.pendingMonitorReason = null;
      void finishCurrentTask();
      return;
    }
    const queuedGoal = state.pendingDeepGoal;
    const queuedReason = state.pendingDeepReason;
    state.pendingDeepGoal = null;
    state.pendingDeepReason = null;
    updateActionState();
    if (queuedGoal) {
      void analyzeFrames("deep", false, queuedGoal, queuedReason || "user_request");
      return;
    }
    const queuedMonitorReason = state.pendingMonitorReason;
    state.pendingMonitorReason = null;
    if (queuedMonitorReason) void analyzeFrames("monitor", true, null, queuedMonitorReason);
  }
}

function updateAutoAnalyze() {
  if ($("auto-analyze").checked) {
    if (!state.stream) {
      $("auto-analyze").checked = false;
      updateActionState();
      setStatus($("app-status"), "请先开启摄像头，再启动自动观察。", true);
      return;
    }
    startAutoCapture();
    const latest = state.frames.at(-1);
    state.monitorCursorMs = latest?.timestampMs ?? Date.now();
    state.router.baselineSignature = latest?.signature ?? null;
    state.router.frameChangeHistory = [];
    state.router.noveltyHistory = [];
    state.router.lastAnalysisMs = Date.now();
    state.router.stableFrames = 0;
    setStatus($("app-status"), "自动观察已运行：画面稳定并出现变化后检查；没有固定间隔的模型调用。");
  } else {
    stopAutoCapture();
    state.monitorCursorMs = null;
    state.pendingMonitorReason = null;
    state.router.baselineSignature = null;
    state.router.frameChangeHistory = [];
    state.router.noveltyHistory = [];
    state.router.stableFrames = 0;
    setStatus($("app-status"), "自动观察已暂停；手动抓拍和分析仍可使用。");
  }
  updateActionState();
}

async function saveFeedback() {
  if (!state.lastRunId) return;
  const feedback = { runId: state.lastRunId, notes: $("feedback-notes").value.trim() };
  for (const select of document.querySelectorAll("[data-feedback]")) {
    if (select.value !== "") feedback[select.dataset.feedback] = select.value === "true";
  }
  try {
    await post("/api/feedback", feedback);
    setStatus($("feedback-status"), "反馈已保存。");
  } catch (error) { setStatus($("feedback-status"), error.message, true); }
}

async function finishCurrentTask() {
  const button = $("stop-task-button");
  button.disabled = true;
  try {
    const result = await post("/api/task", { action: "stop" });
    state.activeTask = result.task;
    setStatus($("app-status"), "当前任务已结束。");
  } catch (error) {
    setStatus($("app-status"), error.message, true);
  } finally { updateActionState(); }
}

async function toggleWatch() {
  const button = $("watch-button");
  button.disabled = true;
  try {
    const isWatching = state.activeWatch?.status !== "idle" && Boolean(state.activeWatch?.condition);
    if (isWatching) {
      const result = await post("/api/watch", { action: "stop" });
      state.activeWatch = result.watch;
      setStatus($("app-status"), "已停止关注条件。");
    } else {
      const condition = $("goal").value.trim();
      if (!condition) throw new Error("请先填写要关注的情况。");
      const result = await post("/api/watch", { action: "start", condition });
      state.activeWatch = result.watch;
      if (state.stream && !$("auto-analyze").checked) {
        $("auto-analyze").checked = true;
        updateAutoAnalyze();
      }
      setStatus($("app-status"), "已开始关注。系统正在检查当前画面，并会在条件疑似发生时复核。");
      if (state.frames.length > 0) {
        state.monitorCursorMs = Date.now() - MONITOR_MAX_WINDOW_MS;
        void analyzeFrames("monitor", true, null, "watch_started");
      }
    }
  } catch (error) {
    setStatus($("app-status"), error.message, true);
  } finally { updateActionState(); }
}

async function stopCurrentTask() {
  if (state.busy) {
    state.pendingTaskStop = true;
    updateActionState();
    setStatus($("app-status"), "已请求结束任务；会在当前视觉分析完成后生效。");
    return;
  }
  await finishCurrentTask();
}

// --- Voice input/output for the request line ---
// Hands-free by design: the primary user is blind and cannot tap a button to start/stop
// recording. The app listens continuously and uses a simple energy-based VAD to segment
// the user's speech, then transcribes each segment on the server (/api/asr).
const isAndroidDevice = /Android|HarmonyOS|Huawei|HONOR/i.test(navigator.userAgent || "");
let voiceAssistantOn = false;
let outputSpeaking = false;   // true while playing audio, so the VAD ignores our own voice
const vad = { stream: null, ctx: null, analyser: null, timer: null, buffer: null, speaking: false, silenceSince: 0, startedAt: 0, recorder: null, chunks: [] };

// --- Speech synthesis (voice output) ---
// Mobile quirks handled: getVoices() loads late; the engine can get stuck "paused";
// cancel()+speak() back-to-back can swallow the new utterance.
let zhVoice = null;

function refreshVoices() {
  if (typeof speechSynthesis === "undefined") return;
  const voices = speechSynthesis.getVoices?.() || [];
  if (!voices.length) return;
  zhVoice = voices.find((voice) => /zh[-_]?CN/i.test(voice.lang))
    || voices.find((voice) => /^zh/i.test(voice.lang))
    || voices.find((voice) => /Chinese|中文|普通话|Mandarin/i.test(voice.name))
    || voices.find((voice) => voice.default)
    || voices[0];
}

// Unlocked from a user gesture so server audio can play later without an autoplay block.
let audioCtx = null;
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch { /* ignore */ }
}

/** Unlock speech synthesis on a user gesture (iOS/Chrome block the first unsolicited speak). */
function primeSpeech() {
  unlockAudio();
  if (typeof speechSynthesis === "undefined") return;
  try {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    utterance.lang = "zh-CN";
    if (zhVoice) utterance.voice = zhVoice;
    speechSynthesis.resume();
    speechSynthesis.speak(utterance);
  } catch { /* ignore */ }
}

// --- Speech playback queue: segments play one after another, never overlapping ---
let speechChain = Promise.resolve();
let speechCooldownUntil = 0;   // brief pause after speaking so we don't record our own audio

function speak(text) {
  if (!$("speak-toggle")?.checked || !text) return;
  // Chain so a later line waits for the current one to finish (a blind user must hear each fully).
  speechChain = speechChain.then(() => speakOnce(text)).catch(() => { /* keep the chain alive */ });
}

/** Plays a single line and resolves when it finishes (local engine first, server TTS as fallback). */
function speakOnce(text) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; outputSpeaking = false; speechCooldownUntil = Date.now() + 900; resolve(); };
    outputSpeaking = true;
    if (!isAndroidDevice && typeof speechSynthesis !== "undefined") {
      if (!zhVoice) refreshVoices();
      const voices = speechSynthesis.getVoices?.() || [];
      if (voices.length > 0 && zhVoice) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "zh-CN";
        utterance.voice = zhVoice;
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 1;
        utterance.onend = finish;
        utterance.onerror = finish;
        try { speechSynthesis.cancel(); } catch { /* ignore */ }
        setTimeout(() => {
          try { speechSynthesis.resume(); speechSynthesis.speak(utterance); } catch { finish(); }
        }, 60);
        // Fallback if the local engine silently fails to start.
        setTimeout(() => { if (!settled && !speechSynthesis.speaking) void speakServer(text, finish); }, 1200);
        return;
      }
    }
    void speakServer(text, finish);
  });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Server-side TTS (qwen3-tts) played through the unlocked AudioContext; calls finish() when done. */
async function speakServer(text, finish) {
  try {
    const result = await post("/api/tts", { text }, true, 30_000);
    if (!result.audioBase64) { finish(); return; }
    const bytes = base64ToBytes(result.audioBase64);
    if (audioCtx) {
      const buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.onended = finish;
      source.start();
      return;
    }
    const audio = new Audio(`data:${result.mimeType || "audio/wav"};base64,${result.audioBase64}`);
    audio.onended = finish;
    audio.onerror = finish;
    await audio.play().catch(() => finish());
  } catch { finish(); }
}

/** Shows the key speech capabilities on the page so a phone-only user can see what's missing. */
function reportVoiceDiagnostics() {
  const hasSynth = typeof speechSynthesis !== "undefined";
  const voiceCount = hasSynth ? (speechSynthesis.getVoices?.() || []).length : 0;
  const zhCount = hasSynth ? (speechSynthesis.getVoices?.() || []).filter((voice) => /^zh/i.test(voice.lang)).length : 0;
  const parts = [
    `播报 ${hasSynth ? "✔" : "✘"} 音色${voiceCount}/中文${zhCount}${hasSynth && voiceCount === 0 ? "（系统未装语音引擎）" : ""}`,
    voiceAssistantOn ? "语音助手：开" : "语音助手：关",
  ];
  const el = $("voice-status");
  if (el) el.textContent = `语音诊断：${parts.join(" · ")}`;
}

function setupVoice() {
  if (typeof speechSynthesis !== "undefined") {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
    $("speak-toggle")?.addEventListener("change", (event) => {
      if (event.target.checked) { primeSpeech(); speak("语音播报已开启"); }
    });
  }
  setTimeout(reportVoiceDiagnostics, 1200);
}

// --- Hands-free input: energy-based voice activity detection (VAD) ---
const VAD_THRESHOLD = 0.045;   // RMS above this counts as speech
const VAD_SILENCE_MS = 1400;   // this much silence ends an utterance
const VAD_MAX_MS = 15000;      // hard cap on a single utterance

async function startVoiceAssistant() {
  if (voiceAssistantOn) return;
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    setStatus($("voice-status"), "当前浏览器不支持录音，请改用 Chrome / Edge。", true);
    return;
  }
  try {
    vad.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    setStatus($("voice-status"), `无法访问麦克风：${error.message}（需信任证书并允许麦克风）`, true);
    return;
  }
  unlockAudio();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  vad.ctx = new Ctx();
  const source = vad.ctx.createMediaStreamSource(vad.stream);
  vad.analyser = vad.ctx.createAnalyser();
  vad.analyser.fftSize = 1024;
  source.connect(vad.analyser);
  vad.buffer = new Uint8Array(vad.analyser.fftSize);
  voiceAssistantOn = true;
  vad.timer = window.setInterval(vadTick, 90);
  const mic = $("mic-button");
  mic.disabled = false;
  mic.textContent = "🛑 暂停";
  setStatus($("voice-status"), "语音助手已开启：直接说话，说完稍等即可。");
  speak("语音助手已开启，请直接说您的问题");
}

function stopVoiceAssistant() {
  voiceAssistantOn = false;
  if (vad.timer) { window.clearInterval(vad.timer); vad.timer = null; }
  try { if (vad.recorder && vad.recorder.state !== "inactive") vad.recorder.stop(); } catch { /* ignore */ }
  try { vad.stream?.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
  vad.stream = null; vad.analyser = null; vad.speaking = false;
  $("mic-button").textContent = "🎤 语音助手";
  setStatus($("voice-status"), "语音助手已暂停。");
}

function vadVolume() {
  if (!vad.analyser) return 0;
  vad.analyser.getByteTimeDomainData(vad.buffer);
  let sum = 0;
  for (let i = 0; i < vad.buffer.length; i++) { const value = (vad.buffer[i] - 128) / 128; sum += value * value; }
  return Math.sqrt(sum / vad.buffer.length);
}

function vadTick() {
  // Ignore our own audio output and any in-flight analysis so we don't transcribe the reply.
  if (!voiceAssistantOn || state.busy || outputSpeaking || Date.now() < speechCooldownUntil) return;
  const volume = vadVolume();
  const now = Date.now();
  if (volume > VAD_THRESHOLD) {
    vad.silenceSince = 0;
    if (!vad.speaking) { vad.speaking = true; vad.startedAt = now; startSegment(); }
  } else if (vad.speaking) {
    if (!vad.silenceSince) vad.silenceSince = now;
    if (now - vad.silenceSince > VAD_SILENCE_MS) { vad.speaking = false; stopSegment(); }
  }
  if (vad.speaking && now - vad.startedAt > VAD_MAX_MS) { vad.speaking = false; stopSegment(); }
}

function startSegment() {
  vad.chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  vad.recorder = mimeType ? new MediaRecorder(vad.stream, { mimeType }) : new MediaRecorder(vad.stream);
  vad.recorder.ondataavailable = (event) => { if (event.data && event.data.size) vad.chunks.push(event.data); };
  vad.recorder.onstop = () => { void handleSegment(); };
  vad.recorder.start();
}

function stopSegment() {
  try { if (vad.recorder && vad.recorder.state !== "inactive") vad.recorder.stop(); } catch { /* ignore */ }
}

/** Transcribe one captured utterance on the server and submit it as a question. */
async function handleSegment() {
  if (!vad.chunks.length) return;
  const blob = new Blob(vad.chunks, { type: vad.chunks[0].type || "audio/webm" });
  try {
    const audioBase64 = await blobToWavBase64(blob);
    const result = await post("/api/asr", { audioBase64, mimeType: "audio/wav" }, true, 40_000);
    const text = (result.text || "").trim();
    if (!text || text.length < 2) return;   // ignore noise / short blips
    $("goal").value = text;
    updateActionState();
    setStatus($("voice-status"), `收到：${text}`);
    confirmTone();
    void submitRequest("ask");
  } catch { /* ignore a single bad segment and keep listening */ }
}

/** A short, quiet tone so the user knows their speech was captured (without echoing it back). */
function confirmTone() {
  try {
    unlockAudio();
    if (!audioCtx) return;
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.12);
  } catch { /* ignore */ }
}

function toggleVoiceInput() {
  if (voiceAssistantOn) stopVoiceAssistant();
  else void startVoiceAssistant();
}

/** Decode a recorded blob and re-encode it as 16 kHz mono WAV base64 for the ASR endpoint. */
async function blobToWavBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(arrayBuffer); } finally { void ctx.close(); }
  const sampleRate = 16000;
  const frames = Math.max(1, Math.round(decoded.duration * sampleRate));
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, frames, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return encodeWavBase64(rendered.getChannelData(0), sampleRate);
}

function encodeWavBase64(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** Role 3: the user's explicit requirement. */
async function submitRequest(mode) {
  const text = $("goal").value.trim();
  if (!text) { setStatus($("app-status"), "请先填写要求或关注条件。"); return; }
  if (state.busy) { setStatus($("app-status"), "当前还有分析在进行，稍后再试。"); return; }
  primeSpeech();
  state.busy = true;
  try {
    const motion = currentMotionDescription();
    const result = await post("/api/request", {
      action: mode === "watch" ? "watch" : "ask",
      text,
      frames: framesForUpload(2, 8_000),
      ...(motion ? { motionDescription: motion } : {}),
      ...(state.sceneLabel ? { sceneLabel: state.sceneLabel } : {}),
    });
    state.request = { ...state.request, ...result.request, lastStepMs: Date.now() };
    if (result.result) showRequestResult(result.result);
    else setStatus($("app-status"), `已设定要求：${text}`);
  } catch (error) {
    setStatus($("app-status"), `用户要求失败：${error.message}`, true);
  } finally { state.busy = false; updateActionState(); }
}

async function stepRequest() {
  if (state.busy || state.request.status !== "active") return;
  if (!state.stream || !state.frames.length) return;
  const now = Date.now();
  if (now - (state.request.lastStepMs || 0) < 8_000) return;
  state.busy = true;
  state.request.lastStepMs = now;
  try {
    const motion = currentMotionDescription();
    const result = await post("/api/request", {
      action: "step",
      frames: framesForUpload(2, 8_000),
      ...(motion ? { motionDescription: motion } : {}),
      ...(state.sceneLabel ? { sceneLabel: state.sceneLabel } : {}),
    });
    state.request = { ...state.request, ...result.request, lastStepMs: now };
    if (result.result) showRequestResult(result.result);
  } catch { /* a periodic re-check failing is not worth interrupting the user */ }
  finally { state.busy = false; updateActionState(); }
}

function showRequestResult(result) {
  const kindLabel = { question: "回答", goal: "建议", watch: "关注" }[result.kind] || "回答";
  state.request.lastAnswer = result.answer;
  const frameHint = hasFrameRelativeDirection(result.answer) ? "（模型用了画面方位；实际方位以你身体为准）" : "";
  if ($("output")) $("output").textContent = `${kindLabel}：${result.answer}${frameHint}`;
  if (result.shouldSpeak) {
    setStatus($("app-status"), `◉ ${kindLabel}：${result.answer}${frameHint}`);
    speak(result.answer);
  } else setStatus($("app-status"), `${kindLabel}：${result.answer}${frameHint}（未提示）`);
}

async function stopRequest() {
  try {
    const result = await post("/api/request", { action: "stop" });
    state.request = { ...state.request, ...result.request, lastStepMs: 0 };
    setStatus($("app-status"), "已结束用户要求。");
  } catch (error) { setStatus($("app-status"), error.message, true); }
  finally { updateActionState(); }
}

$("login-button").addEventListener("click", () => void login());
$("passcode").addEventListener("keydown", (event) => { if (event.key === "Enter") void login(); });
$("camera-button").addEventListener("click", () => {
  if (state.stream) { stopCamera(); setStatus($("app-status"), "摄像头已关闭。"); }
  else void startCamera().catch((error) => setStatus($("app-status"), error.message, true));
});
$("capture-button").addEventListener("click", () => void captureFrame().catch((error) => setStatus($("app-status"), error.message, true)));
$("ask-button").addEventListener("click", () => void submitRequest("ask"));
$("watch-button").addEventListener("click", () => void submitRequest("watch"));
$("stop-task-button").addEventListener("click", () => void stopRequest());
$("mic-button").addEventListener("click", toggleVoiceInput);
$("tts-test-button")?.addEventListener("click", () => {
  unlockAudio();
  $("speak-toggle").checked = true;
  setStatus($("voice-status"), "测试播报：正在合成…");
  speak("你好，语音播报测试成功，现在可以正常播报了。");
});
setupVoice();
$("goal").addEventListener("input", updateActionState);
$("auto-observe-button").addEventListener("click", () => {
  $("auto-analyze").checked = !$("auto-analyze").checked;
  updateAutoAnalyze();
});
$("save-feedback-button").addEventListener("click", () => void saveFeedback());

if (state.token && state.sessionId) {
  showApp();
  void syncTaskState().catch((error) => setStatus($("app-status"), error.message, true));
  void startCamera().catch((error) => setStatus($("app-status"), error.message, true));
  void startVoiceAssistant();
}

window.addEventListener("pagehide", () => {
  if (state.stream) for (const track of state.stream.getTracks()) track.stop();
  window.removeEventListener("devicemotion", onDeviceMotion);
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  window.removeEventListener("deviceorientationabsolute", onDeviceOrientationAbsolute);
  state.motion.listenerActive = false;
  state.motion.samples = [];
  if (state.captureTimer) window.clearInterval(state.captureTimer);
  if (state.live.timer) window.clearInterval(state.live.timer);
  void flushLiveBatch();
});
