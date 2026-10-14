import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AccountState, PoolStatus } from "./enrollment.ts";

function marker(state: AccountState): string {
	if (state === "ready") return "●";
	if (state === "cooling") return "◒";
	if (state === "probing") return "◌";
	return "!";
}

function stateColor(state: AccountState): "success" | "warning" | "error" {
	if (state === "ready") return "success";
	if (state === "reauth") return "error";
	return "warning";
}

export function formatAccountStatusLine(account: PoolStatus["accounts"][number]): string {
	return `${account.label} ${account.detail}${account.isPreferred ? " ★首选" : ""}${account.isCurrent ? " ●本会话" : ""}`;
}

export class CodexPoolStatusWidget {
	private readonly theme: Theme;
	private status?: PoolStatus;
	private loading = true;
	private updateFailed = false;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	update(status: PoolStatus | undefined, options: { loading: boolean; updateFailed?: boolean }): void {
		this.status = status;
		this.loading = options.loading;
		this.updateFailed = options.updateFailed ?? false;
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const ready = this.status?.accounts.filter((account) => account.state === "ready").length ?? 0;
		const total = this.status?.accounts.length ?? 0;
		const lines = [truncateToWidth(`${this.theme.fg("accent", "◆ Codex 账号池")} ${total > 0 ? this.theme.fg("muted", `· ${ready}/${total} 可用`) : ""}`, width)];
		if (!this.status) {
			lines.push(truncateToWidth(`  ${this.theme.fg("warning", "◌")} ${this.theme.fg("muted", "正在读取账号池状态…")}`, width));
		} else if (!this.status.enabled) {
			lines.push(truncateToWidth(`  ${this.theme.fg("warning", this.status.summary)}`, width));
		}
		if (this.loading) lines.push(truncateToWidth(`  ${this.theme.fg("warning", "◌ 正在更新官网额度…")}`, width));
		else if (this.updateFailed) lines.push(truncateToWidth(`  ${this.theme.fg("warning", "官网额度更新失败，显示上次缓存")}`, width));
		for (const account of this.status?.accounts ?? []) {
			const color = stateColor(account.state);
			const base = `  ${this.theme.fg(color, marker(account.state))} ${this.theme.fg("accent", account.label)} ${this.theme.fg("text", account.detail)}`;
			const suffix = `${account.isPreferred ? ` ${this.theme.fg("accent", "★首选")}` : ""}${account.isCurrent ? ` ${this.theme.fg("accent", "●本会话")}` : ""}`;
			const baseWidth = Math.max(0, width - visibleWidth(suffix));
			lines.push(`${truncateToWidth(base, baseWidth)}${suffix}`);
		}
		return lines;
	}

	invalidate(): void {}
}
