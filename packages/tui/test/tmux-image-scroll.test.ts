/**
 * Under tmux, images are DCS-passthrough-wrapped and pinned to an absolute screen row, because tmux
 * forwards a passthrough at parse time and cannot move a graphics placement afterwards. Scrolling the
 * transcript therefore leaves an image behind while the text moves under it; the main-screen renderer
 * re-places the visible images after a scroll. These tests drive a real renderer and inspect the
 * sequences it emits.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { renderImage, resetCapabilitiesCache } from "../src/terminal-image.ts";
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

class RecordingTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	take(): string {
		const written = this.writes.join("");
		this.writes = [];
		return written;
	}
}

class StaticContent implements Component {
	lines: string[] = [];

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

/** Build a document of `count` text lines with one kitty image at `imageRow`. */
function documentWithImage(count: number, imageRow: number, imageLine: string, imageRows: number): string[] {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) lines.push(`line ${i}`);
	lines[imageRow] = imageLine;
	for (let row = 1; row < imageRows; row++) lines[imageRow + row] = "";
	return lines;
}

describe("tmux image placement while scrolling", () => {
	it("re-places a scrolled image instead of leaving it on its old screen row", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const rendered = renderImage(
				Buffer.from("not-a-real-png").toString("base64"),
				{ widthPx: 40, heightPx: 20 },
				{ imageId: 4242, maxWidthCells: 8, maxHeightCells: 2 },
			);
			assert.ok(rendered, "kitty image should render inside tmux when passthrough is available");
			assert.ok(rendered.rows >= 1);

			const terminal = new RecordingTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const content = new StaticContent();
			tui.addChild(content);

			// First frame: a short document, the image sits near the top.
			content.lines = documentWithImage(4, 1, rendered.sequence, rendered.rows);
			tui.renderNow();
			terminal.take();

			// Second frame: append a document taller than the viewport, image in the last screenful.
			content.lines = documentWithImage(20, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			terminal.take();

			// Third frame: append three lines. The image is not re-rendered (it did not change), so only
			// the scroll handling can move it from screen row 8 to screen row 5.
			content.lines = documentWithImage(23, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			const output = terminal.take();

			const spans = passthroughSpans(output);
			const placementSpan = spans.find((span) => span.includes("a=d,d=a"));
			assert.ok(placementSpan, "scrolling should delete and re-place the visible placements");
			assert.ok(
				placementSpan.includes("\x1b[5;1H\x1b_Ga=p,q=2,") && placementSpan.includes(",i=4242"),
				`image should be re-placed on screen row 5, got: ${JSON.stringify(placementSpan)}`,
			);
			assert.ok(
				placementSpan.endsWith("\x1b[12;1H"),
				`the outer cursor should be restored to the last text row, got: ${JSON.stringify(placementSpan)}`,
			);
			// Placement-only: the payload must not be retransmitted on every scrolled frame.
			assert.ok(!placementSpan.includes("a=T"), "scrolling must not retransmit the image payload");
		});
	});

	it("clips an image that straddles the top edge instead of dropping it", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const rendered = renderImage(
				Buffer.from("not-a-real-png").toString("base64"),
				{ widthPx: 40, heightPx: 20 },
				{ imageId: 4242, maxWidthCells: 8, maxHeightCells: 2 },
			);
			assert.ok(rendered);
			assert.strictEqual(rendered.rows, 2);

			const terminal = new RecordingTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const content = new StaticContent();
			tui.addChild(content);

			content.lines = documentWithImage(20, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			terminal.take();

			// Scroll one row past the image's first line: only its bottom half is still on screen.
			content.lines = documentWithImage(28, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			const straddling = passthroughSpans(terminal.take()).find((span) => span.includes("a=d,d=a"));
			assert.ok(straddling, "the scrolled frame should re-place the visible images");
			assert.ok(
				straddling.includes("\x1b[1;1H\x1b_Ga=p,q=2,") &&
					straddling.includes("y=10,h=10,r=1") &&
					straddling.includes("i=4242"),
				`the visible bottom row should be cropped onto screen row 1, got: ${JSON.stringify(straddling)}`,
			);
			assert.ok(!straddling.includes("a=T"), "clipping must not retransmit the image payload");

			// One more row and the image is entirely above the viewport: no placement left at all.
			content.lines = documentWithImage(29, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			const gone = passthroughSpans(terminal.take()).find((span) => span.includes("a=d,d=a"));
			assert.ok(gone, "the scrolled frame should still reset the placements");
			assert.ok(!gone.includes("i=4242"), `a fully hidden image must not be placed, got: ${JSON.stringify(gone)}`);
		});
	});

	it("emits no placement passthrough when the viewport does not move", () => {
		withTmuxEnv(TMUX_KITTY_ENV, () => {
			const rendered = renderImage(
				Buffer.from("not-a-real-png").toString("base64"),
				{ widthPx: 40, heightPx: 20 },
				{ imageId: 77, maxWidthCells: 8, maxHeightCells: 2 },
			);
			assert.ok(rendered);

			const terminal = new RecordingTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const content = new StaticContent();
			tui.addChild(content);

			content.lines = documentWithImage(6, 1, rendered.sequence, rendered.rows);
			tui.renderNow();
			terminal.take();

			// Same number of lines, only a trailing text change: nothing scrolls.
			content.lines = documentWithImage(6, 1, rendered.sequence, rendered.rows);
			content.lines[5] = "changed";
			tui.renderNow();

			const spans = passthroughSpans(terminal.take());
			assert.ok(
				!spans.some((span) => span.includes("a=d,d=a")),
				"a frame that does not scroll must not touch the placements",
			);
		});
	});

	it("stays a plain render when tmux passthrough is unavailable", () => {
		withTmuxEnv({ TERM_PROGRAM: "ghostty", PI_IMAGE_PROTOCOL: "kitty" }, () => {
			const rendered = renderImage(
				Buffer.from("not-a-real-png").toString("base64"),
				{ widthPx: 40, heightPx: 20 },
				{ imageId: 99, maxWidthCells: 8, maxHeightCells: 2 },
			);
			assert.ok(rendered);

			const terminal = new RecordingTerminal(40, 12);
			const tui = new TuiMainScreen(terminal);
			const content = new StaticContent();
			tui.addChild(content);

			content.lines = documentWithImage(4, 1, rendered.sequence, rendered.rows);
			tui.renderNow();
			terminal.take();

			content.lines = documentWithImage(23, 15, rendered.sequence, rendered.rows);
			tui.renderNow();
			const output = terminal.take();

			assert.ok(!output.includes(PASSTHROUGH_PREFIX), "a direct terminal must not get passthroughs");
			assert.ok(!output.includes("a=d,d=a"), "a direct terminal scrolls images itself");
		});
	});
});
