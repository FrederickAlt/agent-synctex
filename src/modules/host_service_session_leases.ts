import type { HostServiceWorkspaceContext } from "./host_service_protocol.ts";

export interface HostServicePendingNotification {
	id: string;
	created_at_ns: number;
	root_source?: string;
	message: string;
	details?: Record<string, unknown>;
}

export interface HostServiceSessionLease {
	session_id: string;
	workspace_context: HostServiceWorkspaceContext;
	last_seen_at_ns: number;
	expires_at_ns: number;
}

export interface HostServiceSessionLeaseServiceOptions {
	leaseTtlMs?: number;
	nowNs?: () => number;
}

const DEFAULT_SESSION_LEASE_TTL_MS = 30_000;

export class HostServiceSessionLeaseService {
	private readonly leaseTtlNs: number;
	private readonly nowNs: () => number;
	private readonly leasesBySessionId = new Map<string, HostServiceSessionLease>();
	private readonly pendingNotificationsBySessionId = new Map<string, HostServicePendingNotification[]>();

	constructor(options: HostServiceSessionLeaseServiceOptions = {}) {
		this.leaseTtlNs = (options.leaseTtlMs ?? DEFAULT_SESSION_LEASE_TTL_MS) * 1_000_000;
		this.nowNs = options.nowNs ?? (() => Date.now() * 1_000_000);
	}

	heartbeat(workspaceContext: HostServiceWorkspaceContext): HostServiceSessionLease {
		const sessionId = requireSessionId(workspaceContext);
		this.pruneExpired();
		const nowNs = this.nowNs();
		const lease: HostServiceSessionLease = {
			session_id: sessionId,
			workspace_context: { ...workspaceContext, session_id: sessionId },
			last_seen_at_ns: nowNs,
			expires_at_ns: nowNs + this.leaseTtlNs,
		};
		this.leasesBySessionId.set(sessionId, lease);
		return lease;
	}

	pruneExpired(): string[] {
		const nowNs = this.nowNs();
		const expired: string[] = [];
		for (const [sessionId, lease] of this.leasesBySessionId) {
			if (nowNs >= lease.expires_at_ns) {
				this.leasesBySessionId.delete(sessionId);
				this.pendingNotificationsBySessionId.delete(sessionId);
				expired.push(sessionId);
			}
		}
		return expired;
	}

	isLive(sessionId: string): boolean {
		this.pruneExpired();
		return this.leasesBySessionId.has(sessionId);
	}

	get liveSessionCount(): number {
		this.pruneExpired();
		return this.leasesBySessionId.size;
	}

	pendingNotificationCount(sessionId: string): number {
		return this.pendingNotificationsBySessionId.get(sessionId)?.length ?? 0;
	}

	retrievePendingNotifications(workspaceContext: HostServiceWorkspaceContext): HostServicePendingNotification[] {
		const sessionId = requireSessionId(workspaceContext);
		this.pruneExpired();
		const notifications = this.pendingNotificationsBySessionId.get(sessionId) ?? [];
		this.pendingNotificationsBySessionId.delete(sessionId);
		return notifications.map((notification) => ({ ...notification, details: notification.details ? { ...notification.details } : undefined }));
	}

	queuePendingNotification(sessionId: string, notification: HostServicePendingNotification): void {
		if (!sessionId.trim()) {
			throw new Error("session_id is required");
		}
		const current = this.pendingNotificationsBySessionId.get(sessionId) ?? [];
		this.pendingNotificationsBySessionId.set(sessionId, [...current, { ...notification }]);
	}

	clear(): void {
		this.leasesBySessionId.clear();
		this.pendingNotificationsBySessionId.clear();
	}
}

export function requireSessionId(workspaceContext: HostServiceWorkspaceContext): string {
	const sessionId = workspaceContext.session_id;
	if (typeof sessionId !== "string" || !sessionId.trim()) {
		throw new Error("workspace_context.session_id is required");
	}
	return sessionId.trim();
}
