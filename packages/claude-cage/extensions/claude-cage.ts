import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCatalog, loadProfile, saveCatalog, type CageProfile } from "../src/profile.ts";
import { createCageProvider, parseModels, PROVIDER_ID } from "../src/provider.ts";
import { checkGuest, installGuest } from "../src/setup.ts";
import { isFatalConnectionError, isRecord } from "../src/transport.ts";

function diagnostic(error: unknown): string {
	return error instanceof Error ? error.message.slice(0, 800).replace(/[\x00-\x1f\x7f]/g, " ") : "Unknown failure";
}

function commandFailure(prefix: string, error: unknown) {
	if (isFatalConnectionError(error)) {
		return (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]/g, " ");
	}
	return `${prefix}: ${diagnostic(error)}`;
}

export default function claudeCage(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let profile: CageProfile | undefined;
	let profileError: string | undefined;
	try {
		profile = loadProfile(agentDir);
	} catch (error) {
		profileError = diagnostic(error);
	}
	let cached: ReturnType<typeof parseModels> = [];
	if (profile) {
		try { cached = parseModels(loadCatalog(agentDir, profile)); } catch { /* no usable local catalog */ }
	}
	const bridge = createCageProvider(profile, profileError, cached);
	let busy = false;
	pi.registerProvider(bridge.provider);

	pi.registerCommand("claude-cage-status", {
		description: "Check the configured Claude Cage guest; pass 'models' to discover its catalog",
		async handler(args, ctx) {
			const action = args.trim();
			if (action && action !== "models") {
				ctx.ui.notify("Usage: /claude-cage-status [models]", "warning");
				return;
			}
			if (!profile) {
				ctx.ui.notify(`${profileError}. Run /reload after editing the profile.`, "warning");
				return;
			}
			if (busy) {
				ctx.ui.notify("Another Claude Cage command is in progress.", "warning");
				return;
			}
			busy = true;
			try {
				if (action === "models") {
					const models = parseModels(await bridge.request({ op: "models" }, { signal: bridge.signal }));
					bridge.setModels(models);
					const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], allowNetwork: false, signal: bridge.signal });
					if (result.errors.has(PROVIDER_ID)) throw result.errors.get(PROVIDER_ID);
					bridge.signal.throwIfAborted();
					let warning = "";
					try { saveCatalog(agentDir, profile, models); } catch (error) { warning = ` ${diagnostic(error)}`; }
					ctx.ui.notify(`Claude Cage: ${models.length} models available in /model.${warning}`, warning ? "warning" : "info");
					return;
				}
				const status = await bridge.request({ op: "status" }, { signal: bridge.signal });
				if (!isRecord(status) || ![status.available, status.loggedIn, status.subscription].every((value) => typeof value === "boolean") ||
					(status.plan !== null && (typeof status.plan !== "string" || !/^[a-zA-Z0-9 _-]{1,48}$/.test(status.plan)))) {
					throw new Error("Invalid status from the Cage guest");
				}
				ctx.ui.notify(`Claude Cage: CLI ${status.available ? "available" : "missing"}; ` +
					`login ${status.loggedIn ? "present" : "missing"}; subscription ${status.subscription ? (status.plan ?? "present") : "not detected"}.`,
					status.available && status.loggedIn && status.subscription ? "info" : "warning");
			} catch (error) {
				if (!bridge.signal.aborted) ctx.ui.notify(commandFailure("Claude Cage", error), "error");
			} finally {
				busy = false;
			}
		},
	});

	pi.registerCommand("claude-cage-setup", {
		description: "Check and install the guest bridge in the configured Cage profile",
		async handler(args, ctx) {
			if (args.trim()) {
				ctx.ui.notify("Usage: /claude-cage-setup", "warning");
				return;
			}
			if (!profile) {
				ctx.ui.notify(`${profileError}. Run /reload after editing the profile.`, "warning");
				return;
			}
			if (!ctx.hasUI || !ctx.isIdle() || busy) {
				ctx.ui.notify("Claude Cage setup requires an idle session with confirmation UI.", "warning");
				return;
			}
			busy = true;
			try {
				await bridge.beginSetup();
				await checkGuest(profile, bridge.signal);
				const confirmed = await ctx.ui.confirm("Install or update the Claude Cage guest bridge?",
					`Profile: ${profile.config}\nService: ${profile.servicePath}\n` +
					"This downloads the pinned adapter and installs a session-owned stdio service. It does not log in or run a model.",
					{ signal: bridge.signal });
				if (!confirmed) return;
				if (!ctx.isIdle()) throw new Error("Wait for the current turn to finish before installing");
				await installGuest(profile, bridge.signal);
				ctx.ui.notify("Claude Cage guest bridge installed. Use /claude-cage-status to check it.", "info");
			} catch (error) {
				if (!bridge.signal.aborted) ctx.ui.notify(commandFailure("Claude Cage setup", error), "error");
			} finally {
				bridge.finishSetup();
				busy = false;
			}
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await bridge.shutdown();
		} catch (error) {
			ctx.ui.notify(`Could not close the Claude Cage session: ${diagnostic(error)}`, "warning");
		}
	});
}
