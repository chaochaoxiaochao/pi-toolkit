import assert from "node:assert/strict";

import { LoginSlot } from "../src/login-slot.ts";

/**
 * The bug this guards: pi gives extensions one slot below the chat, and closing a selector puts
 * the editor back there. A dialog mounted before the selector is therefore gone afterwards, and
 * the Codex flow asks for the login method first, so the sign-in URL and the manual-code input
 * would render into a component nobody can see.
 */

/** A slot that records every dialog call together with whether that dialog was still mounted. */
function fakeUi(answers) {
	const dialogs = [];
	const selects = [];
	const calls = [];
	const record = (dialog, name, detail) => calls.push({ name, detail, visible: dialog.live });
	return {
		dialogs,
		selects,
		calls,
		ui: {
			mount: (register) =>
				new Promise((resolve) => {
					const state = { live: true };
					dialogs.push(state);
					register(
						{
							signal: new AbortController().signal,
							showAuth: (url) => record(state, "auth", url),
							showDeviceCode: (info) => record(state, "device_code", info.userCode),
							showInfo: (message) => record(state, "info", message),
							showProgress: (message) => record(state, "progress", message),
							showWaiting: (message) => record(state, "waiting", message),
							showManualInput: async (message) => {
								record(state, "manual_code", message);
								return answers.shift();
							},
							showPrompt: async (message) => {
								record(state, "prompt", message);
								return answers.shift();
							},
						},
						() => {
							state.live = false;
							resolve(undefined);
						},
					);
				}),
			select: async (message, options) => {
				selects.push({ message, visible: dialogs.filter((dialog) => dialog.live).length });
				return options[answers.shift()];
			},
		},
	};
}

const LOGIN_METHOD = {
	type: "select",
	message: "选择登录方式",
	options: [
		{ id: "browser", label: "浏览器登录" },
		{ id: "device", label: "设备码登录" },
	],
};

// ---------------------------------------------------------------------------
// The Codex order: pick a method, then show the URL, then take the pasted code.
// ---------------------------------------------------------------------------
{
	const { ui, dialogs, selects, calls } = fakeUi([0, "pasted-code"]);
	const slot = new LoginSlot(ui);
	const interaction = slot.interaction;

	assert.equal(await interaction.prompt(LOGIN_METHOD), "browser");
	assert.deepEqual(selects, [{ message: "选择登录方式", visible: 0 }], "no dialog is mounted while a selector owns the slot");

	interaction.notify({ type: "auth_url", url: "https://login.invalid/authorize", instructions: "在浏览器中完成" });
	assert.equal(await interaction.prompt({ type: "manual_code", message: "粘贴回调代码" }), "pasted-code");

	assert.deepEqual(
		calls.map((call) => call.name),
		["auth", "manual_code"],
		"the steps after the selector reach the dialog in order",
	);
	for (const call of calls) assert.ok(call.visible, `${call.name} rendered into a dialog the user can see`);
	assert.equal(dialogs.length, 1, "one dialog is enough once the selector is out of the way");

	await slot.close();
	assert.deepEqual(dialogs.map((dialog) => dialog.live), [false], "closing the login gives the slot back");
}

// ---------------------------------------------------------------------------
// A selector in the middle of a login re-mounts the dialog instead of losing it.
// ---------------------------------------------------------------------------
{
	const { ui, dialogs, selects, calls } = fakeUi([1, "device-done"]);
	const slot = new LoginSlot(ui);
	const interaction = slot.interaction;

	interaction.notify({ type: "progress", message: "正在准备授权…" });
	assert.equal(await interaction.prompt(LOGIN_METHOD), "device");
	assert.deepEqual(selects, [{ message: "选择登录方式", visible: 0 }], "the dialog steps aside for the selector");

	interaction.notify({ type: "device_code", userCode: "ABCD-EFGH", verificationUri: "https://login.invalid/device" });
	assert.equal(await interaction.prompt({ type: "manual_code", message: "粘贴回调代码" }), "device-done");

	assert.deepEqual(
		calls.map((call) => call.name),
		["progress", "device_code", "waiting", "manual_code"],
		"events keep the order the provider emitted them in",
	);
	for (const call of calls) assert.ok(call.visible, `${call.name} rendered into a dialog the user can see`);
	assert.equal(dialogs.length, 2, "the dialog is mounted again after the selector took the slot");

	await slot.close();
	assert.deepEqual(dialogs.map((dialog) => dialog.live), [false, false]);
}

// ---------------------------------------------------------------------------
// Backing out of the selector cancels the login rather than hanging on the slot.
// ---------------------------------------------------------------------------
{
	const { ui, dialogs } = fakeUi([undefined]);
	const slot = new LoginSlot(ui);
	await assert.rejects(() => slot.interaction.prompt(LOGIN_METHOD), /Login cancelled/);
	await slot.close();
	assert.deepEqual(dialogs, [], "a cancelled method choice never opens a dialog");
}

console.log("Login slot tests passed");
