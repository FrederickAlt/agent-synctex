export class HostServiceCompileCoordinationError extends Error {
	readonly errorCode: string;

	constructor(message: string, errorCode: string) {
		super(message);
		this.name = "HostServiceCompileCoordinationError";
		this.errorCode = errorCode;
	}
}

interface RootCompileQueueItem {
	operation: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	started: boolean;
}

interface RootCompileQueue {
	items: RootCompileQueueItem[];
	running: boolean;
}

export class HostServiceRootCompileCoordinator {
	private readonly queues = new Map<string, RootCompileQueue>();
	private stoppedError: HostServiceCompileCoordinationError | undefined;

	runExclusive<T>(rootKey: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.stoppedError !== undefined) {
			return Promise.reject(this.stoppedError);
		}
		if (signal?.aborted) {
			return Promise.reject(new HostServiceCompileCoordinationError(
				"compile request cancelled before entering root compile queue",
				"compile_cancelled",
			));
		}

		return new Promise<T>((resolve, reject) => {
			const queue = this.queueFor(rootKey);
			const item: RootCompileQueueItem = {
				operation,
				resolve: (value) => resolve(value as T),
				reject,
				signal,
				started: false,
			};

			if (signal !== undefined) {
				item.onAbort = () => {
					if (item.started) {
						return;
					}
					this.removeQueuedItem(rootKey, queue, item);
					item.reject(new HostServiceCompileCoordinationError(
						"compile request cancelled while waiting behind an active same-root compile",
						"compile_cancelled",
					));
				};
				signal.addEventListener("abort", item.onAbort, { once: true });
			}

			queue.items.push(item);
			this.pump(rootKey, queue);
		});
	}

	resume(): void {
		this.stoppedError = undefined;
	}

	stop(error = new HostServiceCompileCoordinationError(
		"host service stopped while compile request was waiting behind an active same-root compile",
		"host_service_stopped",
	)): void {
		this.stoppedError = error;
		for (const [rootKey, queue] of this.queues) {
			const pending = queue.items.filter((item) => !item.started);
			queue.items = queue.items.filter((item) => item.started);
			for (const item of pending) {
				this.detachAbort(item);
				item.reject(error);
			}
			if (queue.items.length === 0) {
				this.queues.delete(rootKey);
			}
		}
	}

	activeRootCount(): number {
		return this.queues.size;
	}

	private queueFor(rootKey: string): RootCompileQueue {
		const existing = this.queues.get(rootKey);
		if (existing !== undefined) {
			return existing;
		}
		const created: RootCompileQueue = { items: [], running: false };
		this.queues.set(rootKey, created);
		return created;
	}

	private pump(rootKey: string, queue: RootCompileQueue): void {
		if (queue.running) {
			return;
		}
		const item = queue.items[0];
		if (item === undefined) {
			this.queues.delete(rootKey);
			return;
		}
		if (this.stoppedError !== undefined) {
			queue.items.shift();
			this.detachAbort(item);
			item.reject(this.stoppedError);
			this.pump(rootKey, queue);
			return;
		}

		queue.running = true;
		item.started = true;
		this.detachAbort(item);
		void item.operation()
			.then((value) => item.resolve(value))
			.catch((error) => item.reject(error))
			.finally(() => {
				queue.items.shift();
				queue.running = false;
				this.pump(rootKey, queue);
			});
	}

	private removeQueuedItem(rootKey: string, queue: RootCompileQueue, item: RootCompileQueueItem): void {
		const index = queue.items.indexOf(item);
		if (index >= 0) {
			queue.items.splice(index, 1);
		}
		this.detachAbort(item);
		if (!queue.running && queue.items.length === 0) {
			this.queues.delete(rootKey);
		}
	}

	private detachAbort(item: RootCompileQueueItem): void {
		if (item.signal !== undefined && item.onAbort !== undefined) {
			item.signal.removeEventListener("abort", item.onAbort);
			item.onAbort = undefined;
		}
	}
}
