import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	FakeViewerBackend,
	HostServiceClient,
	HostServiceServer,
	HostServiceSessionLeaseService,
} from "../../src/modules/host_service.ts";

function temporaryDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function withServer<T>(
	leaseService: HostServiceSessionLeaseService,
	fn: (client: HostServiceClient) => Promise<T>,
): Promise<T> {
	const baseDir = temporaryDir("host-service-session-leases-");
	const socketPath = join(baseDir, "host-service.sock");
	const server = new HostServiceServer({
		socketPath,
		serviceName: "host-service-session-lease-test",
		viewerBackend: new FakeViewerBackend(),
		sessionLeases: leaseService,
	});
	await server.start();
	const client = new HostServiceClient({ socketPath, requestTimeoutMs: 1_000 });
	try {
		return await fn(client);
	} finally {
		await server.stop();
		rmSync(baseDir, { recursive: true, force: true });
	}
}

test("Host Service heartbeat records, refreshes, and expires session leases deterministically", async () => {
	let nowNs = 1_000_000_000;
	const leases = new HostServiceSessionLeaseService({ leaseTtlMs: 1_000, nowNs: () => nowNs });

	await withServer(leases, async (client) => {
		const first = await client.requestSessionHeartbeat({ cwd: "/tmp/workspace", session_id: "session-A" });
		assert.equal(first.session_id, "session-A");
		assert.equal(first.last_seen_at_ns, 1_000_000_000);
		assert.equal(first.lease_expires_at_ns, 2_000_000_000);
		assert.equal(first.live_session_count, 1);

		nowNs += 500_000_000;
		const refreshed = await client.requestSessionHeartbeat({ cwd: "/tmp/workspace", session_id: "session-A" });
		assert.equal(refreshed.last_seen_at_ns, 1_500_000_000);
		assert.equal(refreshed.lease_expires_at_ns, 2_500_000_000);
		assert.equal(refreshed.live_session_count, 1);

		nowNs += 999_000_000;
		const liveStatus = await client.requestStatus({ cwd: "/tmp/workspace" });
		assert.equal(liveStatus.live_session_count, 1);

		nowNs += 1_000_000;
		const expiredStatus = await client.requestStatus({ cwd: "/tmp/workspace" });
		assert.equal(expiredStatus.live_session_count, 0);
	});
});

test("Host Service rejects heartbeat and pending-notification requests without a session id", async () => {
	const leases = new HostServiceSessionLeaseService();
	await withServer(leases, async (client) => {
		await assert.rejects(
			() => client.requestSessionHeartbeat({ cwd: "/tmp/workspace" }),
			/error status.*workspace_context\.session_id is required|workspace_context\.session_id is required.*code=invalid_request/,
		);
		await assert.rejects(
			() => client.requestPendingNotifications({ cwd: "/tmp/workspace" }),
			/error status.*workspace_context\.session_id is required|workspace_context\.session_id is required.*code=invalid_request/,
		);
	});
});

test("Host Service pending notification retrieval is session scoped and can return empty", async () => {
	const leases = new HostServiceSessionLeaseService();
	leases.queuePendingNotification("session-A", {
		id: "notification-1",
		created_at_ns: 42,
		message: "[system info] background compile failed",
	});

	await withServer(leases, async (client) => {
		const empty = await client.requestPendingNotifications({ cwd: "/tmp/workspace", session_id: "session-B" });
		assert.equal(empty.session_id, "session-B");
		assert.deepEqual(empty.notifications, []);
		assert.equal(empty.delivered_count, 0);

		const delivered = await client.requestPendingNotifications({ cwd: "/tmp/workspace", session_id: "session-A" });
		assert.equal(delivered.session_id, "session-A");
		assert.equal(delivered.delivered_count, 1);
		assert.equal(delivered.notifications[0]?.id, "notification-1");

		const afterDelivery = await client.requestPendingNotifications({ cwd: "/tmp/workspace", session_id: "session-A" });
		assert.deepEqual(afterDelivery.notifications, []);
		assert.equal(afterDelivery.delivered_count, 0);
	});
});
