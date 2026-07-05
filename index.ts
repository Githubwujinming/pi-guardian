import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGuardPaneTool } from "./guard-pane.js";
import { registerRespondTool } from "./respond.js";
import { registerGuardTool } from "./guard.js";
import { reconstructState } from "./state.js";

export default function (pi: ExtensionAPI): void {
	registerGuardPaneTool(pi);
	registerRespondTool(pi);
	registerGuardTool(pi);

	const handleSessionEvent = async (
		_event: unknown,
		ctx: { sessionManager: { getBranch(): Iterable<unknown> } },
	) => {
		reconstructState(ctx);
	};

	pi.on("session_start", handleSessionEvent);
	pi.on("session_tree", handleSessionEvent);

	pi.on("session_start", async () => {
		try {
			await pi.exec("herdr", ["list"], { timeout: 3000 });
		} catch {
			console.warn(
				"[pi-guardian] Warning: @ogulcancelik/pi-herdr not detected. Install with: pi install npm:@ogulcancelik/pi-herdr",
			);
		}
	});
}
