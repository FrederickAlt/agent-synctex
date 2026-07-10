import type { ViewerHostErrorMessage } from "./viewer_host_protocol.ts";

const MAX_FAILURE_CODE_LENGTH = 80;
const MAX_FAILURE_TITLE_LENGTH = 200;
const MAX_FAILURE_DETAIL_LENGTH = 2_000;
const MAX_FAILURE_INJECT_TEXT_LENGTH = 4_000;

export interface ViewerFailureContext {
	code: string;
	title: string;
	pdfId?: number;
	detail?: string;
	injectText?: string;
}

export type ViewerFailureDelivery = (message: ViewerHostErrorMessage) => Promise<void> | void;

/** Converts unexpected viewer-path failures into one bounded, user-visible protocol message. */
export class ViewerFailureReporter {
	private readonly deliver: ViewerFailureDelivery;

	constructor(deliver: ViewerFailureDelivery) {
		this.deliver = deliver;
	}

	async report(error: unknown, context: ViewerFailureContext): Promise<void> {
		await this.deliver(viewerFailureMessage(error, context));
	}

	async capture<T>(context: ViewerFailureContext, operation: () => Promise<T> | T): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			try {
				await this.report(error, context);
			} catch (reportingError) {
				throw new AggregateError(
					[asError(error), asError(reportingError)],
					`${context.title}; additionally failed to report the error to the viewer: ${errorMessage(reportingError)}`,
				);
			}
			throw error;
		}
	}
}

export function viewerFailureMessage(error: unknown, context: ViewerFailureContext): ViewerHostErrorMessage {
	const code = boundedText(context.code, MAX_FAILURE_CODE_LENGTH) || "unexpected_failure";
	const title = boundedText(context.title, MAX_FAILURE_TITLE_LENGTH) || "Unexpected viewer failure";
	const detail = boundedText(context.detail ?? errorMessage(error), MAX_FAILURE_DETAIL_LENGTH) || "An unexpected viewer operation failed.";
	const injectText = boundedText(context.injectText ?? `${title}: ${detail}`, MAX_FAILURE_INJECT_TEXT_LENGTH);
	return {
		type: "viewer_error",
		...(context.pdfId === undefined ? {} : { pdf_id: context.pdfId }),
		code,
		title,
		detail,
		...(injectText ? { inject_text: injectText } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function boundedText(value: string, maxLength: number): string {
	const trimmed = value.trim();
	return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}
