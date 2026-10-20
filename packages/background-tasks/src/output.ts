import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type TruncationResult } from "@earendil-works/pi-coding-agent";

const PROGRAM_BYTES = 1024 * 1024;
export type LogWrite = (fd: number, data: Buffer) => number;

export interface OutputView {
	text: string;
	output: string;
	truncated: boolean;
	truncation: TruncationResult;
}

/** Owns one log. Reads are range-limited even when the on-disk log is large. */
export class TaskLog {
	readonly path: string;
	bytes = 0;
	private fd: number;
	private closed = false;
	private readonly write: LogWrite;
	private decoder = new TextDecoder();
	private decodedBytes = 0;
	private lines = 0;
	private openLine = false;
	private lastLineBytes = 0;

	constructor(path: string, write: LogWrite = (fd, data) => writeSync(fd, data)) {
		this.path = path;
		this.write = write;
		this.fd = openSync(path, "wx", 0o600);
	}

	append(data: Buffer): void {
		if (this.closed) throw new Error("Log is closed");
		let offset = 0;
		while (offset < data.length) {
			const remaining = data.subarray(offset);
			const count = this.write(this.fd, remaining);
			if (!Number.isInteger(count) || count <= 0 || count > remaining.length) throw new Error("Log write made invalid progress");
			this.bytes += count;
			this.countText(this.decoder.decode(remaining.subarray(0, count), { stream: true }));
			offset += count;
		}
	}

	finish(): void {
		if (this.closed) return;
		this.closed = true;
		try { this.countText(this.decoder.decode()); }
		finally { closeSync(this.fd); }
	}

	read(): OutputView {
		const fd = openSync(this.path, "r");
		try {
			// Keep a bounded working window comparable to Bash's rolling tail. This
			// preserves an oversized last line that ends with a newline before trimming.
			const start = Math.max(0, this.bytes - DEFAULT_MAX_BYTES * 4 - 4);
			const tail = this.range(fd, start, this.bytes - start);
			let first = 0;
			while (first < tail.length && (tail[first] & 0xc0) === 0x80) first++;
			let snapshot = new TextDecoder().decode(tail.subarray(first), { stream: !this.closed });
			if (start > 0) {
				const previous = this.range(fd, start - 1, 1)[0];
				if (first > 0 || previous !== 0x0a) {
					const newline = snapshot.indexOf("\n");
					if (newline !== -1) snapshot = snapshot.slice(newline + 1);
				}
			}
			const truncation = truncateTail(snapshot);
			const totalLines = this.lines + (this.openLine ? 1 : 0);
			truncation.truncated = totalLines > DEFAULT_MAX_LINES || this.decodedBytes > DEFAULT_MAX_BYTES;
			truncation.truncatedBy = truncation.truncated
				? (truncation.truncatedBy ?? (this.decodedBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines")) : null;
			truncation.totalLines = totalLines;
			truncation.totalBytes = this.decodedBytes;
			let text = truncation.content || "(no output)";
			if (truncation.truncated) {
				const end = totalLines;
				const begin = end - truncation.outputLines + 1;
				const detail = truncation.lastLinePartial
					? `last ${formatSize(truncation.outputBytes)} of line ${end} (line is ${formatSize(this.lastLineBytes)})`
					: `lines ${begin}-${end} of ${end}${truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ""}`;
				text += `\n\n[Showing ${detail}. Full output: ${this.path}]`;
			}
			const program = this.readProgram(fd);
			return { text, output: program.content, truncated: program.truncated, truncation };
		} finally { closeSync(fd); }
	}

	private readProgram(fd: number): { content: string; truncated: boolean } {
		if (this.bytes <= PROGRAM_BYTES) {
			return { content: new TextDecoder().decode(this.range(fd, 0, this.bytes), { stream: !this.closed }), truncated: false };
		}
		const half = PROGRAM_BYTES / 2;
		const head = this.range(fd, 0, half);
		const tail = this.range(fd, this.bytes - half, half);
		const headText = new TextDecoder().decode(head, { stream: true });
		let first = 0;
		while (first < tail.length && (tail[first] & 0xc0) === 0x80) first++;
		const tailText = new TextDecoder().decode(tail.subarray(first), { stream: !this.closed });
		return { content: `${headText}\n\n[... ${this.bytes - PROGRAM_BYTES} bytes omitted ...]\n\n${tailText}`, truncated: true };
	}

	private range(fd: number, position: number, length: number): Buffer {
		const data = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const count = readSync(fd, data, offset, length - offset, position + offset);
			if (count === 0) throw new Error("Log changed unexpectedly while reading");
			offset += count;
		}
		return data;
	}

	private countText(text: string): void {
		this.decodedBytes += Buffer.byteLength(text);
		const last = text.lastIndexOf("\n");
		if (last === -1) {
			if (text.length) this.openLine = true;
			this.lastLineBytes += Buffer.byteLength(text);
		} else {
			for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) this.lines++;
			this.lastLineBytes = Buffer.byteLength(text.slice(last + 1));
			this.openLine = last < text.length - 1;
		}
	}
}
