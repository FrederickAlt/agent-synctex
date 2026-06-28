#!/usr/bin/env node
import { PdfJsViewerBrokerServer, defaultPdfJsViewerBrokerSocketPath } from "../src/modules/pdfjs_viewer_broker.ts";

const socketPath = process.argv[2] || defaultPdfJsViewerBrokerSocketPath();
const broker = new PdfJsViewerBrokerServer(socketPath);

await broker.start();
process.once("SIGINT", () => {
	void broker.stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
	void broker.stop().finally(() => process.exit(0));
});
