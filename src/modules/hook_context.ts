import { appendFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveTexActionsHookInstanceCandidates, sanitizeTexActionsAgentId } from "./agent_runtime_context.ts";
import { collectPostUserPdfContextFromEvents, pdfAnnotationEventsFromViewerMarks } from "./post_user_pdf_context.ts";
import { getMcpTmpDir } from "./runtime_paths.ts";
import { persistentViewerHostStatePath, readPersistentViewerHostState, type PersistentViewerHostState } from "./viewer_host_discovery.ts";
import { ViewerFailureReporter } from "./viewer_failure_reporter.ts";
import { ViewerHostControlClient } from "./viewer_host_control_client.ts";
import { ViewerHostMarksClient } from "./viewer_host_marks_client.ts";
import { createLogger } from "./logging.ts";

const logger = createLogger("hook-context");

export interface FetchHookContextOptions {
	runtimeRoot?: string;
	agentId?: string;
	prompt?: string;
	cwd?: string;
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
	agentIdCandidates?: readonly string[];
}

export interface ViewerHostHookDiscovery {
	runtimeDir: string;
	state: PersistentViewerHostState & { control_token: string };
}

export async function fetchHookContext(options: FetchHookContextOptions = {}): Promise<string> {
	let firstFailure: unknown;
	const discoveries = findViewerHostHookDiscoveries(options);
	logger.info("hook.fetch.start", { discoveries: discoveries.length, cwd_hash: traceHash(options.cwd ?? process.cwd()) });
	for (const discovery of discoveries) {
		let client: ViewerHostMarksClient | undefined;
		let claimId: string | undefined;
		const failureReporter = hookFailureReporter(discovery, options);
		try {
			client = new ViewerHostMarksClient({
				origin: discovery.state.origin,
				controlToken: discovery.state.control_token,
				fetchImpl: options.fetchImpl,
				requestTimeoutMs: options.requestTimeoutMs,
			});
			logger.info("hook.claim.start", { origin: discovery.state.origin, runtime_dir_hash: traceHash(discovery.runtimeDir), timeout_ms: options.requestTimeoutMs });
			const claim = await client.claimPdfMarks(undefined, 20);
			claimId = claim.claimId;
			logger.info("hook.claim.result", { origin: discovery.state.origin, marks_count: claim.marks.length, claim_id_present: claim.claimId !== undefined });
			if (claim.marks.length === 0 || claim.claimId === undefined) continue;
			const result = collectPostUserPdfContextFromEvents(pdfAnnotationEventsFromViewerMarks(claim.marks), {
				maxEvents: 20,
				clearViewer: true,
				cwd: options.cwd ?? discovery.state.cwd ?? process.cwd(),
			});
			const consumed = result.events.map((event) => ({ pdf_id: event.pdf_id, annotation_id: event.annotation_id }));
			await client.acknowledgePdfMarks(claim.claimId, consumed);
			logger.info("hook.ack", { origin: discovery.state.origin, consumed_count: consumed.length, injected_text: result.text.length > 0 });
			if (result.text) return result.text;
		} catch (error) {
			let propagatedFailure = error;
			const detail = errorMessage(error);
			if (isViewerHostNetworkFailure(error)) removeStaleDiscovery(discovery);
			if (isVisibleViewerSocketConnectingFailure(error)) {
				logger.info("hook.fetch.socket_connecting", { origin: discovery.state.origin, runtime_dir_hash: traceHash(discovery.runtimeDir), detail });
				continue;
			}
			if (client !== undefined && claimId !== undefined) {
				try {
					await client.releasePdfMarks(claimId, detail);
				} catch (releaseError) {
					propagatedFailure = combinedFailure(error, "release the claimed PDF marks", releaseError);
					try {
						await reportHookFailure(failureReporter, error);
					} catch (reportingError) {
						propagatedFailure = combinedFailure(propagatedFailure, "report the failure to the viewer", reportingError);
					}
				}
			} else {
				try {
					await reportHookFailure(failureReporter, error);
				} catch (reportingError) {
					propagatedFailure = combinedFailure(error, "report the failure to the viewer", reportingError);
				}
			}
			logger.warn("hook.fetch.failure", { origin: discovery.state.origin, runtime_dir_hash: traceHash(discovery.runtimeDir), error: propagatedFailure });
			firstFailure ??= propagatedFailure;
		}
	}
	if (firstFailure !== undefined) throw firstFailure;
	logger.info("hook.fetch.empty", { discoveries: discoveries.length });
	return "";
}

function hookFailureReporter(discovery: ViewerHostHookDiscovery, options: FetchHookContextOptions): ViewerFailureReporter {
	const control = new ViewerHostControlClient({
		origin: discovery.state.origin,
		controlToken: discovery.state.control_token,
		fetchImpl: options.fetchImpl,
		requestTimeoutMs: options.requestTimeoutMs,
	});
	return new ViewerFailureReporter(async (message) => {
		const response = await control.send({
			type: "report_error",
			...(message.pdf_id === undefined ? {} : { pdf_id: message.pdf_id }),
			code: message.code,
			title: message.title,
			detail: message.detail,
			...(message.inject_text === undefined ? {} : { inject_text: message.inject_text }),
		});
		if (!response.ok) throw new Error(response.error.message);
	});
}

async function reportHookFailure(reporter: ViewerFailureReporter, error: unknown): Promise<void> {
	const detail = errorMessage(error);
	await reporter.report(error, {
		code: "mark_fetch_failed",
		title: "Could not fetch PDF marks",
		detail,
		injectText: `PDF mark delivery failed: ${detail}`,
	});
}

function combinedFailure(primary: unknown, action: string, secondary: unknown): AggregateError {
	return new AggregateError(
		[asError(primary), asError(secondary)],
		`${errorMessage(primary)}; additionally failed to ${action}: ${errorMessage(secondary)}`,
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isViewerHostNetworkFailure(error: unknown): boolean {
	const message = errorMessage(error);
	return message === "fetch failed"
		|| /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|other side closed|terminated/i.test(message);
}

function isVisibleViewerSocketConnectingFailure(error: unknown): boolean {
	return /Timed out waiting \d+ms for visible PDF viewer socket connection/.test(errorMessage(error));
}

function removeStaleDiscovery(discovery: ViewerHostHookDiscovery): void {
	const current = readPersistentViewerHostState(discovery.runtimeDir);
	if (current === undefined) return;
	if (current.origin !== discovery.state.origin) return;
	if (current.instance_id !== discovery.state.instance_id) return;
	try {
		rmSync(persistentViewerHostStatePath(discovery.runtimeDir), { force: true });
		logger.warn("hook.discovery_removed", { origin: discovery.state.origin, runtime_dir_hash: traceHash(discovery.runtimeDir) });
		traceHookDiscovery("discovery-removed", { origin_hash: traceHash(discovery.state.origin), session_dir_hash: traceHash(discovery.runtimeDir) });
	} catch { }
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function findViewerHostHookDiscoveries(
	options: Pick<FetchHookContextOptions, "runtimeRoot" | "agentId" | "cwd" | "agentIdCandidates"> = {},
): ViewerHostHookDiscovery[] {
	const runtimeRoot = options.runtimeRoot ?? getMcpTmpDir();
	if (options.agentId?.trim()) {
		const direct = readDiscovery(join(runtimeRoot, "agents", sanitizeTexActionsAgentId(options.agentId)));
		traceHookDiscovery("discovery-session", { session_hash: traceHash(options.agentId), found: direct !== undefined });
		return direct === undefined ? [] : [direct];
	}
	const agentIds = (options.agentIdCandidates ?? resolveTexActionsHookInstanceCandidates()).map(sanitizeTexActionsAgentId);
	const direct = agentIds
		.map((agentId) => readDiscovery(join(runtimeRoot, "agents", agentId)))
		.filter((entry): entry is ViewerHostHookDiscovery => entry !== undefined);
	const uniqueDirect = uniqueDiscoveries(direct);
	if (uniqueDirect.length > 0) {
		traceHookDiscovery("discovery-candidates", { source: "agent-candidates", count: uniqueDirect.length });
		return uniqueDirect.length === 1 ? uniqueDirect : [];
	}
	if (options.cwd === undefined) {
		traceHookDiscovery("discovery-candidates", { source: "none", count: 0 });
		return [];
	}
	const cwdMatched = uniqueDiscoveries(findDiscoveriesByCwd(runtimeRoot, options.cwd));
	traceHookDiscovery("discovery-candidates", { source: "cwd", cwd_hash: traceHash(options.cwd), count: cwdMatched.length });
	return cwdMatched.length === 1 ? cwdMatched : [];
}

function traceHookDiscovery(event: string, details: Record<string, unknown>): void {
	const target = process.env.AGENT_SYNCTEX_HOOK_TRACE;
	if (!target) return;
	try {
		appendFileSync(target, JSON.stringify({ event, at: new Date().toISOString(), ...details }) + "\n", { encoding: "utf8", mode: 0o600 });
	} catch { }
}

function traceHash(value: string | undefined): string | undefined {
	return value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : undefined;
}

function findDiscoveriesByCwd(runtimeRoot: string, cwd: string): ViewerHostHookDiscovery[] {
	const agentsDir = join(runtimeRoot, "agents");
	let agentIds: string[];
	try {
		agentIds = readdirSync(agentsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const resolvedCwd = resolve(cwd);
	return agentIds
		.map((agentId) => readDiscovery(join(agentsDir, agentId)))
		.filter((entry): entry is ViewerHostHookDiscovery => entry !== undefined
			&& entry.state.cwd !== undefined
			&& resolve(entry.state.cwd) === resolvedCwd);
}

function readDiscovery(runtimeDir: string): ViewerHostHookDiscovery | undefined {
	const state = readPersistentViewerHostState(runtimeDir);
	if (state === undefined || typeof state.control_token !== "string" || state.control_token.length < 16) return undefined;
	return { runtimeDir, state: state as PersistentViewerHostState & { control_token: string } };
}

function uniqueDiscoveries(discoveries: ViewerHostHookDiscovery[]): ViewerHostHookDiscovery[] {
	const seen = new Set<string>();
	return discoveries.filter((discovery) => {
		const key = `${discovery.state.origin}\0${discovery.state.control_token}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
