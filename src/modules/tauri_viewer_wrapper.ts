import { ViewerHostPdfRegistry } from "./viewer_host_registry.ts";
import { ViewerHostServer, type ViewerHostServerAddress } from "./viewer_host_server.ts";

export interface DesktopViewerHostWrapperOptions {
	registry?: ViewerHostPdfRegistry;
	port?: number;
}

export interface DesktopViewerHostWrapper {
	readonly registry: ViewerHostPdfRegistry;
	readonly server: ViewerHostServer;
	readonly origin: string;
	readonly appUrl: string;
	readonly address: ViewerHostServerAddress;
	shutdown(): Promise<void>;
}

export async function startDesktopViewerHostForDesktopWrapper(options: DesktopViewerHostWrapperOptions = {}): Promise<DesktopViewerHostWrapper> {
	const registry = options.registry ?? new ViewerHostPdfRegistry();
	const server = new ViewerHostServer({ registry, port: options.port });
	await server.start();
	const origin = server.origin;
	return {
		registry,
		server,
		origin,
		appUrl: `${origin}/app`,
		address: server.address,
		shutdown: () => server.stop(),
	};
}
