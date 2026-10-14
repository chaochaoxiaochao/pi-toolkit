import type { AuthEvent, AuthInfoLink, AuthPrompt, OAuthDeviceCodeInfo, ProviderAuthInteraction } from "@earendil-works/pi-ai";

/**
 * One OAuth login inside pi's single editor slot.
 *
 * pi hands extensions one slot below the chat: `ui.select` puts the editor back when it closes,
 * so a selector opened while the login dialog is mounted takes the dialog down with it, and every
 * later auth step renders into a component nobody can see. The Codex flow hits exactly that, as it
 * asks for the login method first and shows the sign-in URL and the manual-code input afterwards.
 *
 * The slot therefore mounts the dialog lazily and steps out of it around every selector, and keeps
 * auth events in the order the provider emitted them.
 */

/** The part of pi's login dialog this module drives. */
export interface LoginDialog {
	/** Aborts when the user cancels inside the dialog. */
	readonly signal: AbortSignal;
	showAuth(url: string, instructions?: string): void;
	showDeviceCode(info: OAuthDeviceCodeInfo): void;
	showInfo(message: string, links?: readonly AuthInfoLink[]): void;
	showProgress(message: string): void;
	showWaiting(message: string): void;
	showManualInput(message: string): Promise<string>;
	showPrompt(message: string, placeholder?: string): Promise<string>;
}

export interface LoginSlotUi {
	/**
	 * Mounts a login dialog in the slot and reports it together with the callback that takes it
	 * down again. Resolves once the slot has been handed back.
	 */
	mount(register: (dialog: LoginDialog, close: () => void) => void): Promise<unknown>;
	/** Shows a selector in the same slot. Resolves to undefined when the user cancels. */
	select(message: string, options: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
}

const CANCELLED = "Login cancelled";

/** A prompt can lose its race, e.g. a manual code while the callback server wins. */
function withCancellation<T>(answer: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return answer;
	if (signal.aborted) return Promise.reject(new Error(CANCELLED));
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error(CANCELLED));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return Promise.race([answer, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

export class LoginSlot {
	private readonly aborter = new AbortController();
	private dialog: LoginDialog | undefined;
	private opening: Promise<LoginDialog> | undefined;
	private hide: (() => void) | undefined;
	private dismissed: Promise<unknown> = Promise.resolve();
	/** Serializes everything that needs the slot to itself. Never rejects. */
	private queue: Promise<void> = Promise.resolve();
	private readonly ui: LoginSlotUi;

	constructor(ui: LoginSlotUi) {
		this.ui = ui;
	}

	/** What `oauth.login()` is called with. */
	get interaction(): ProviderAuthInteraction {
		return {
			signal: this.aborter.signal,
			prompt: (request) => this.prompt(request),
			notify: (event) => this.notify(event),
		};
	}

	/** Gives the slot back once the login is over. */
	async close(): Promise<void> {
		await this.queue;
		await this.unmount();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const running = this.queue.then(task);
		this.queue = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}

	private open(): Promise<LoginDialog> {
		if (this.opening) return this.opening;
		let ready: (dialog: LoginDialog) => void = () => {};
		let failed: (error: unknown) => void = () => {};
		const shown = new Promise<LoginDialog>((resolve, reject) => {
			ready = resolve;
			failed = reject;
		});
		this.dismissed = this.ui
			.mount((dialog, close) => {
				// Cancelling inside the dialog cancels the login, the same key `/login` honours.
				dialog.signal.addEventListener("abort", () => this.aborter.abort(), { once: true });
				this.dialog = dialog;
				this.hide = close;
				ready(dialog);
			})
			.catch((error: unknown) => {
				failed(error);
			});
		this.opening = shown;
		return shown;
	}

	private async unmount(): Promise<void> {
		const hide = this.hide;
		const dismissed = this.dismissed;
		this.dialog = undefined;
		this.opening = undefined;
		this.hide = undefined;
		this.dismissed = Promise.resolve();
		hide?.();
		await dismissed;
	}

	private async prompt(request: AuthPrompt): Promise<string> {
		if (request.type === "select") return withCancellation(this.select(request), request.signal);
		// Wait for the events that arrived before this prompt, so the dialog reads in order.
		await this.queue;
		const dialog = await this.open();
		const answer =
			request.type === "manual_code" ? dialog.showManualInput(request.message) : dialog.showPrompt(request.message, request.placeholder);
		return withCancellation(answer, request.signal);
	}

	private select(request: AuthPrompt & { type: "select" }): Promise<string> {
		return this.enqueue(async () => {
			await this.unmount();
			const labels = request.options.map((option) => option.label);
			const chosen = await this.ui.select(request.message, labels, request.signal);
			const index = chosen === undefined ? -1 : labels.indexOf(chosen);
			if (index < 0) throw new Error(CANCELLED);
			return request.options[index].id;
		});
	}

	private notify(event: AuthEvent): void {
		void this.enqueue(async () => {
			const dialog = await this.open();
			if (event.type === "auth_url") dialog.showAuth(event.url, event.instructions);
			else if (event.type === "device_code") {
				dialog.showDeviceCode(event);
				dialog.showWaiting("等待浏览器完成授权…");
			} else if (event.type === "info") dialog.showInfo(event.message, event.links);
			else dialog.showProgress(event.message);
		}).catch(() => undefined);
	}
}
