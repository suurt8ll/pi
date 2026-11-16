/**
 * A Kitty placement outlives the process that drew it: the terminal keeps painting it at the screen row
 * it was anchored to, and once the shell prompt scrolls the transcript that row lands above the pane.
 * tmux cannot clear it (under a passthrough the image lives in the outer terminal), so the leftover
 * stays behind as a fragment clipped at the pane's top-left corner. The main screen therefore has to
 * delete the images it placed when it hands the terminal back — by id, so that the passthrough does not
 * also delete other panes' images.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	isTmuxImagePassthroughEnabled,
	renderImage,
	resetCapabilitiesCache,
	wrapImageSequencesForTmux,
} from "../src/terminal-image.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const PASSTHROUGH_PREFIX = "\x1bPtmux;";
const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"PI_IMAGE_PROTOCOL",
	"PI_TMUX_IMAGES",
] as const;

const TMUX_KITTY_ENV: Record<string, string> = {
	TMUX: "/tmp/tmux-1000/default,1,0",
	TERM: "tmux-256color",
	PI_IMAGE_PROTOCOL: "kitty",
	PI_TMUX_IMAGES: "1",
};

const DIRECT_KITTY_ENV: Record<string, string> = {
	TERM_PROGRAM: "ghostty",
	PI_IMAGE_PROTOCOL: "kitty",
};

function withTmuxEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetCapabilitiesCache();
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		resetCapabilitiesCache();
	}
}

/** Un-double the ESC bytes the way tmux's passthrough parser does, one span per passthrough. */
function passthroughSpans(data: string): string[] {
	const spans: string[] = [];
	let index = 0;
	for (;;) {
		const start = data.indexOf(PASSTHROUGH_PREFIX, index);
		if (start === -1) return spans;
		let position = start + PASSTHROUGH_PREFIX.length;
		let body = "";
		let terminated = false;
		while (position < data.length) {
			const char = data[position];
			if (char === "\x1b") {
				if (data[position + 1] === "\x1b") {
					body += "\x1b";
					position += 2;
					continue;
				}
				if (data[position + 1] === "\\") {
					position += 2;
					terminated = true;
					break;
				}
			}
			body += char;
			position += 1;
		}
		spans.push(body);
		if (!terminated) return spans;
		index = position;
	}
}

/**
 * Records writes and mirrors `ProcessTerminal.write()`: image sequences are wrapped into tmux passthroughs at that
 * single choke point, which is where the renderer's raw deletes reach the outer terminal from.
 */
class RecordingTerminal extends VirtualTerminal {
	private writes: string[] = [];
	private pending = "";

	override write(data: string): void {
		if (isTmuxImagePassthroughEnabled()) {
			const wrapped = wrapImageSequencesForTmux(this.pending + data);
			this.pending = wrapped.pending;
			data = wrapped.output;
		}
		this.writes.push(data);
		super.write(data);
	}

	take(): string {
		const written = this.writes.join("");
		this.writes = [];
		return written;
	}

	/** Half-written image sequence still waiting for the rest of its write; must be empty at exit. */
	get pendingPassthrough(): string {
		return this.pending;
	}
}

class StaticContent implements Component {
	lines: string[] = [];

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** Render one frame containing a kitty image with id `imageId`, then stop the TUI and return the stop output. */
function stopAfterRenderingImage(imageId: number, preserveScreen = false): string {
	const rendered = renderImage(
		Buffer.from("not-a-real-png").toString("base64"),
		{ widthPx: 40, heightPx: 20 },
		{ imageId, maxWidthCells: 8, maxHeightCells: 2 },
	);
	assert.ok(rendered, "kitty image should render");

	const terminal = new RecordingTerminal(40, 12);
	const tui = new TuiMainScreen(terminal);
	const content = new StaticContent();
	tui.addChild(content);

	content.lines = ["line 0", rendered.sequence, "line 2", "line 3"];
	tui.renderNow();
	assert.ok(terminal.take().includes("\x1b_G"), "the frame should place the image");

	tui.stop({ preserveScreen });
	assert.strictEqual(terminal.pendingPassthrough, "", "the delete must be one complete passthrough");
	return terminal.take();
}

describe("main-screen image cleanup on exit", () => {
	it("deletes the placed images through the tmux passthrough", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const output = stopAfterRenderingImage(4242);

			const span = passthroughSpans(output).find((candidate) => candidate.includes("a=d,d=I"));
			assert.ok(span, `exit should delete the images it placed, got: ${JSON.stringify(output)}`);
			assert.ok(span.includes("i=4242"), `the delete must name the placed image id, got: ${JSON.stringify(span)}`);

			const deleteAt = output.indexOf(PASSTHROUGH_PREFIX);
			const lastLineFeed = output.lastIndexOf("\r\n");
			assert.ok(deleteAt !== -1 && deleteAt < lastLineFeed, "the delete should precede the final line break");
		});
	});

	it("deletes the placed images directly when tmux is not in the way", () => {
		withTmuxEnv(DIRECT_KITTY_ENV, () => {
			const output = stopAfterRenderingImage(4242);

			assert.ok(
				output.includes("\x1b_Ga=d,d=I,i=4242,q=2\x1b\\"),
				`a direct terminal should get the raw delete, got: ${JSON.stringify(output)}`,
			);
			assert.ok(!output.includes(PASSTHROUGH_PREFIX), "a direct terminal must not get passthroughs");
		});
	});

	it("still deletes on a mode switch, where the incoming renderer retransmits", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const span = passthroughSpans(stopAfterRenderingImage(4242, true)).find((candidate) =>
				candidate.includes("a=d,d=I"),
			);
			assert.ok(span, "a preserved screen must not keep the old renderer's placements alive");
			assert.ok(span.includes("i=4242"));
		});
	});

	it("emits no graphics sequence at all when nothing was placed", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const terminal = new RecordingTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const content = new StaticContent();
			tui.addChild(content);

			content.lines = ["line 0", "line 1"];
			tui.renderNow();
			terminal.take();

			tui.stop();
			const output = terminal.take();
			assert.ok(
				!output.includes("\x1b_G"),
				`a text-only transcript must not emit graphics, got: ${JSON.stringify(output)}`,
			);
			assert.ok(output.includes("\r\n"), "the transcript should still be terminated");
		});
	});
});
