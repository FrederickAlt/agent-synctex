export type HarnessId = "claude" | "codex" | "cline" | "pi" | "opencode";
export type HarnessSelection = HarnessId | "auto" | "all";
export type InstallScope = "project" | "user";

export interface InstallerContext {
	cwd: string;
	scope: InstallScope;
	dryRun: boolean;
	yes: boolean;
	noHooks: boolean;
	stdout: Pick<NodeJS.WritableStream, "write">;
	stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface HarnessDetection {
	id: HarnessId;
	detected: boolean;
	reason?: string;
}

export interface InstallChange {
	path?: string;
	description: string;
}

export interface DoctorFinding {
	harness: HarnessId;
	level: "ok" | "warning" | "error";
	message: string;
}

export interface HarnessAdapter {
	readonly id: HarnessId;
	detect(ctx: InstallerContext): Promise<HarnessDetection> | HarnessDetection;
	installMcp(ctx: InstallerContext): Promise<InstallChange[]> | InstallChange[];
	installHooks(ctx: InstallerContext): Promise<InstallChange[]> | InstallChange[];
	uninstall(ctx: InstallerContext): Promise<InstallChange[]> | InstallChange[];
	doctor(ctx: InstallerContext): Promise<DoctorFinding[]> | DoctorFinding[];
}
