export interface HostServiceCallbackTarget {
	kind: "pi-synctex-callback-v1";
	transport: "unix";
	socket_path: string;
	token: string;
}

export interface HostServiceViewerBackendCapabilities {
	open: boolean;
	close: boolean;
	forward_search: boolean;
	inverse_search: boolean;
	reuse: boolean;
}

export interface ViewerBackendOperationResult<T extends Record<string, unknown> = Record<string, unknown>> {
	status: "ok" | "error";
	error?: string;
	status_details: T;
}

export interface ViewerBackendAdapter {
	readonly name: string;
	readonly capabilities: HostServiceViewerBackendCapabilities;
	isAvailable(): boolean;
	status(requestId: string, operation: string): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	open(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	close(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	forwardSearch(requestId: string, details: Record<string, unknown>): Promise<ViewerBackendOperationResult<Record<string, unknown>>>;
	closeAll(requestId?: string): Promise<void>;
}
