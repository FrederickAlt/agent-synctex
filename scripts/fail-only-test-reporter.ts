import { inspect } from "node:util";

type ReporterEvent = {
	type: string;
	data?: unknown;
};

type FailureDetails = {
	duration_ms?: number;
	error?: unknown;
};

type FailureData = {
	name?: string;
	testNumber?: number;
	file?: string;
	line?: number;
	column?: number;
	details?: FailureDetails;
};

type SummaryCounts = {
	tests?: number;
	failed?: number;
	passed?: number;
	cancelled?: number;
	skipped?: number;
	todo?: number;
};

type SummaryData = {
	file?: string;
	duration_ms?: number;
	counts?: SummaryCounts;
};

export default async function* failOnlyTestReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
	for await (const event of source) {
		if (event.type === "test:fail") {
			yield formatFailure(event.data as FailureData);
			continue;
		}
		if (event.type === "test:summary") {
			const summary = event.data as SummaryData;
			if (summary.file === undefined) {
				yield formatSummary(summary);
			}
		}
	}
}

export function formatFailure(data: FailureData): string {
	const header = ["FAIL", data.testNumber === undefined ? undefined : `#${data.testNumber}`, data.name]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ");
	const location = formatLocation(data);
	const duration = data.details?.duration_ms === undefined ? "" : ` (${formatDuration(data.details.duration_ms)})`;
	const error = formatError(data.details?.error);
	return `${header}${location ? `\n${location}` : ""}${duration}${error ? `\n${error}` : ""}\n`;
}

export function formatSummary(data: SummaryData): string {
	const counts = data.counts ?? {};
	const parts = [
		`${counts.passed ?? 0} passed`,
		`${counts.failed ?? 0} failed`,
	];
	if ((counts.cancelled ?? 0) > 0) {
		parts.push(`${counts.cancelled} cancelled`);
	}
	if ((counts.skipped ?? 0) > 0) {
		parts.push(`${counts.skipped} skipped`);
	}
	if ((counts.todo ?? 0) > 0) {
		parts.push(`${counts.todo} todo`);
	}
	const total = counts.tests === undefined ? "" : ` (${counts.tests} tests)`;
	const duration = data.duration_ms === undefined ? "" : ` in ${formatDuration(data.duration_ms)}`;
	return `${parts.join(", ")}${total}${duration}\n`;
}

function formatLocation(data: FailureData): string {
	if (!data.file) {
		return "";
	}
	const line = data.line === undefined ? "" : `:${data.line}`;
	const column = data.column === undefined ? "" : `:${data.column}`;
	return `  at ${data.file}${line}${column}`;
}

function formatDuration(durationMs: number): string {
	return `${durationMs.toFixed(1)}ms`;
}

function formatError(error: unknown): string {
	if (error === undefined) {
		return "";
	}
	if (error instanceof Error) {
		const lines = [error.stack ?? error.message];
		const cause = error.cause;
		if (cause !== undefined) {
			lines.push("Cause:", inspect(cause, { colors: false, depth: 6 }));
		}
		return lines.join("\n");
	}
	return inspect(error, { colors: false, depth: 6 });
}
