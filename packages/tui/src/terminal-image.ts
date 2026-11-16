import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { TerminalColorMode } from "./colors.ts";

export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	moveCursor?: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error fallbacks `false`.
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

/**
 * Terminal emulators known to implement the Kitty graphics protocol, matched against
 * tmux's `#{client_termname}` (the TERM of the terminal tmux is attached to, such as
 * `xterm-ghostty`). tmux rewrites TERM and TERM_PROGRAM inside a pane, so this and the
 * env vars the outer terminal leaks into the pane are the only hints available from
 * inside a pane.
 */
const KITTY_GRAPHICS_CLIENT_TERM = /ghostty|kitty|wezterm|rio/;

/**
 * Reads whether tmux will forward DCS passthrough sequences (`allow-passthrough`) and
 * which terminal it is attached to. Returns `undefined` when tmux cannot be queried.
 */
function probeTmuxPassthrough(): { allowed: boolean; clientTerm: string } | undefined {
	try {
		const output = execSync("tmux show -gv allow-passthrough \\; display-message -p '#{client_termname}'", {
			encoding: "utf8",
			timeout: 400,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const [setting = "", clientTerm = ""] = output.split("\n").map((line) => line.trim());
		return { allowed: setting === "on" || setting === "all", clientTerm };
	} catch {
		return undefined;
	}
}

/**
 * Checks whether image sequences can reach the outer terminal through tmux. tmux never
 * forwards raw Kitty APC / iTerm2 OSC 1337 sequences; it only passes them on when they are
 * wrapped in a DCS passthrough (`\x1bPtmux;...\x1b\\`) and `allow-passthrough` is enabled.
 * `PI_TMUX_IMAGES=1|0` overrides the probe.
 */
export function detectTmuxImagePassthrough(): boolean {
	const override = parseBooleanCapabilityOverride(process.env.PI_TMUX_IMAGES);
	if (override !== undefined) return override;

	const state = probeTmuxPassthrough();
	if (!state?.allowed) return false;
	if (KITTY_GRAPHICS_CLIENT_TERM.test(state.clientTerm.toLowerCase())) return true;

	// The client termname is the multiplexer's own TERM for nested sessions (tmux in tmux,
	// screen, ...), so fall back to env vars the outer terminal leaks into the pane.
	return Boolean(process.env.KITTY_WINDOW_ID || process.env.WEZTERM_PANE || process.env.GHOSTTY_RESOURCES_DIR);
}

function detectCapabilitiesFromEnvironment(
	tmuxForwardsHyperlink: () => boolean,
	tmuxForwardsImages: () => boolean,
): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	const isWindowsConsole = process.platform === "win32";

	// Emit OSC 8 hyperlinks only when tmux confirms it forwards, and images only when the
	// client terminal speaks the Kitty protocol and tmux forwards the passthrough wrapper
	// (see wrapImageSequencesForTmux).
	if (process.env.TMUX || term.startsWith("tmux")) {
		return {
			images: tmuxForwardsImages() ? "kitty" : null,
			trueColor: hasTrueColorHint,
			hyperlinks: tmuxForwardsHyperlink(),
		};
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	if (term.startsWith("screen")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	// Herdr forwards OSC 8 hyperlinks and supports the Kitty graphics protocol. Check it before
	// outer-terminal detection because variables like KITTY_WINDOW_ID can leak into its panes.
	if (termProgram === "herdr") {
		return { images: "kitty", trueColor: hasTrueColorHint, hyperlinks: true };
	}

	if (termProgram === "rex") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Orca supports Kitty graphics but only advertises it through ORCA_IMAGE_PROTOCOL. Require
	// both signals so Orca releases predating that advertisement keep the text fallback instead
	// of reserving image rows that nothing renders.
	if (termProgram === "orca" && process.env.ORCA_IMAGE_PROTOCOL === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp supports the Kitty graphics protocol and OSC 8 hyperlinks.
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	// Alacritty does not set TERM_PROGRAM. It sets TERM=alacritty when its terminfo entry is
	// installed (otherwise xterm-256color) and ALACRITTY_WINDOW_ID on Unix and macOS.
	const isAlacritty = termProgram === "alacritty" || term.startsWith("alacritty") || process.env.ALACRITTY_WINDOW_ID;
	if (isAlacritty || termProgram === "vscode" || termProgram === "zed") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (isWindowsConsole) {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

export function detectCapabilities(
	tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks,
	tmuxForwardsImages: () => boolean = detectTmuxImagePassthrough,
): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	const detected = detectCapabilitiesFromEnvironment(
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
		tmuxForwardsImages,
	);
	const imageProtocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
	const images =
		imageProtocol === "kitty" || imageProtocol === "iterm2"
			? imageProtocol
			: imageProtocol === "none" || imageProtocol === "0"
				? null
				: undefined;
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	return {
		...detected,
		...(images !== undefined ? { images } : {}),
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		cachedCapabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	return capabilities.trueColor ? "truecolor" : "256color";
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
	cachedTmuxImagePassthrough = undefined;
}

let cachedTmuxImagePassthrough: boolean | undefined;

/**
 * Whether the TUI must wrap image sequences in a tmux DCS passthrough. Memoized because it
 * runs `tmux` and is consulted on every terminal write.
 */
export function isTmuxImagePassthroughEnabled(): boolean {
	if (!(process.env.TMUX || process.env.TERM?.toLowerCase().startsWith("tmux"))) return false;
	if (!getCapabilities().images) return false;
	cachedTmuxImagePassthrough ??= detectTmuxImagePassthrough();
	return cachedTmuxImagePassthrough;
}

/** Override selected auto-detected capabilities. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.images === overrides.images &&
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
const TMUX_PASSTHROUGH_PREFIX = "\x1bPtmux;";
const TMUX_PASSTHROUGH_SUFFIX = "\x1b\\";
/** Safety valve: an image sequence this large is emitted unwrapped instead of held back. */
const MAX_PENDING_PASSTHROUGH_CHARS = 8 * 1024 * 1024;

/** Wrap a terminal sequence in a tmux DCS passthrough so tmux forwards it verbatim. */
export function wrapTmuxPassthrough(sequence: string): string {
	return `${TMUX_PASSTHROUGH_PREFIX}${sequence.replaceAll("\x1b", "\x1b\x1b")}${TMUX_PASSTHROUGH_SUFFIX}`;
}

/** Index just past the end of the image sequence starting at `start`, or undefined if incomplete. */
function findImageSequenceEnd(data: string, start: number): number | undefined {
	if (data.startsWith(KITTY_PREFIX, start)) {
		const stringTerminator = data.indexOf("\x1b\\", start + KITTY_PREFIX.length);
		return stringTerminator === -1 ? undefined : stringTerminator + 2;
	}
	// iTerm2 OSC 1337 file sequence: terminated by BEL or ST, whichever comes first.
	const bel = data.indexOf("\x07", start);
	const stringTerminator = data.indexOf("\x1b\\", start);
	if (bel === -1 && stringTerminator === -1) return undefined;
	if (stringTerminator === -1) return bel + 1;
	if (bel === -1) return stringTerminator + 2;
	return Math.min(bel + 1, stringTerminator + 2);
}

/**
 * Index just past the `\x1b\\` that terminates the passthrough starting at `start`, or undefined.
 * Inside a passthrough body every ESC is doubled, so `\x1b\x1b` has to be consumed as a unit:
 * a naive search for `\x1b\\` would stop at the second half of the terminator of the first
 * wrapped sequence and cut the body in half.
 */
function findPassthroughEnd(data: string, start: number): number | undefined {
	let index = start + TMUX_PASSTHROUGH_PREFIX.length;
	while (index < data.length) {
		if (data[index] !== "\x1b") {
			index += 1;
			continue;
		}
		if (data[index + 1] === "\x1b") {
			index += 2;
			continue;
		}
		if (data[index + 1] === "\\") return index + 2;
		index += 1;
	}
	return undefined;
}

export interface WrappedImageSequences {
	/** Data ready to write: every complete image sequence wrapped in a tmux passthrough. */
	output: string;
	/** Trailing fragment of an image sequence that continues in the next write. */
	pending: string;
}

/**
 * Cursor-position sequence a renderer emitted right before an image, optionally followed by
 * erase/attribute sequences. tmux forwards a passthrough at parse time, before it has repainted,
 * so the outer terminal's cursor is stale by however many rows the frame has not been flushed yet;
 * the renderers therefore anchor every image line with an absolute CUP and we repeat that CUP
 * inside the passthrough so the image lands where the frame says it does.
 */
const TRAILING_IMAGE_ANCHOR = /(\x1b\[\d+;\d+[Hf])((?:\x1b\[[\d;]*[KJm])*)$/;

function findTrailingImageAnchor(output: string): string | undefined {
	const tailStart = Math.max(0, output.length - 128);
	return TRAILING_IMAGE_ANCHOR.exec(output.slice(tailStart))?.[1];
}

/** Control block of a Kitty APC sequence, i.e. the part between `\x1b_G` and the first `;`. */
function kittySequenceControls(sequence: string): string | undefined {
	if (!sequence.startsWith(KITTY_PREFIX)) return undefined;
	const end = sequence.indexOf(";", KITTY_PREFIX.length);
	return end === -1 ? undefined : sequence.slice(KITTY_PREFIX.length, end);
}

const KITTY_ACTION = /(?:^|,)a=[^,]*/;
const KITTY_CHUNK_OPEN = /(?:^|,)m=1(?:,|$)/;
const KITTY_CHUNK_CLOSE = /(?:^|,)m=0(?:,|$)/;

/**
 * Rewrite the image sequences in one terminal write into tmux DCS passthroughs.
 *
 * tmux does not understand the Kitty graphics protocol or iTerm2 inline images and drops those
 * sequences; with `allow-passthrough` enabled it forwards everything inside `\x1bPtmux;...\x1b\\`
 * verbatim (ESC bytes doubled). Callers that split writes may cut an image sequence in half, so an
 * unterminated trailing sequence is returned as `pending` to be prepended to the next write.
 * Data that already carries a passthrough is passed through untouched. Every image sequence also
 * gets the renderer's absolute CUP anchor repeated inside its passthrough, since tmux forwards the
 * passthrough before it repaints (see {@link TRAILING_IMAGE_ANCHOR}).
 */
export function wrapImageSequencesForTmux(
	data: string,
	maxPendingChars: number = MAX_PENDING_PASSTHROUGH_CHARS,
): WrappedImageSequences {
	let output = "";
	let index = 0;
	let transmitAnchor: string | undefined;
	while (index < data.length) {
		const kitty = data.indexOf(KITTY_PREFIX, index);
		const iterm2 = data.indexOf(ITERM2_PREFIX, index);
		const passthrough = data.indexOf(TMUX_PASSTHROUGH_PREFIX, index);
		const start = Math.min(
			kitty === -1 ? Number.POSITIVE_INFINITY : kitty,
			iterm2 === -1 ? Number.POSITIVE_INFINITY : iterm2,
			passthrough === -1 ? Number.POSITIVE_INFINITY : passthrough,
		);
		if (start === Number.POSITIVE_INFINITY) {
			output += data.slice(index);
			break;
		}
		output += data.slice(index, start);

		// A caller (the main-screen renderer re-placing scrolled images) may build its own
		// passthrough. Copy such a span verbatim instead of wrapping the sequences inside it again.
		if (start === passthrough) {
			const end = findPassthroughEnd(data, start);
			if (end === undefined) {
				const tail = data.slice(start);
				if (tail.length > maxPendingChars) {
					output += tail;
					break;
				}
				return { output, pending: tail };
			}
			output += data.slice(start, end);
			index = end;
			continue;
		}

		const end = findImageSequenceEnd(data, start);
		if (end === undefined) {
			const tail = data.slice(start);
			if (tail.length > maxPendingChars) {
				output += tail;
				break;
			}
			return { output, pending: tail };
		}

		// tmux forwards each chunk of a chunked transmission as it parses it, interleaved with its own
		// repaints, so by the time the last chunk completes and the terminal displays the image the
		// outer cursor has moved away from the row the frame put it on. Remember the anchor of the
		// opening chunk and re-assert it before every continuation chunk (the payload only paints on
		// the closing one, but the cursor has to be right by then).
		const sequence = data.slice(start, end);
		const controls = kittySequenceControls(sequence);
		const anchor = findTrailingImageAnchor(output);
		if (controls !== undefined && KITTY_ACTION.test(controls) && KITTY_CHUNK_OPEN.test(controls)) {
			transmitAnchor = anchor;
		}
		const continuationAnchor = controls !== undefined && !KITTY_ACTION.test(controls) ? transmitAnchor : undefined;
		output += wrapTmuxPassthrough(`${anchor ?? continuationAnchor ?? ""}${sequence}`);
		if (controls !== undefined && KITTY_CHUNK_CLOSE.test(controls)) {
			transmitAnchor = undefined;
		}
		index = end;
	}
	return { output, pending: "" };
}

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have cursor-up prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		moveCursor?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/** Delete all visible Kitty placements while retaining their uploaded image data. */
export function deleteAllKittyPlacements(): string {
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [
		`inline=${options.inline !== false ? 1 : 0}`,
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}

export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	transmissionGeneration: number;
}

export interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	rows: number;
	sequence: string;
	replacementLine: string;
}

const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
let kittyTransmissionGeneration = 0;
// Tallest registered image. Bounds backward searches for image lines above a
// viewport: no image line further up than this can reach into it.
let maxKittyImageRows = 0;

export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyTransmissionGeneration += 1;
	maxKittyImageRows = Math.max(maxKittyImageRows, metadata.rows);
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

/** Return the row height of the tallest Kitty image registered so far. */
export function getMaxKittyImageRows(): number {
	return maxKittyImageRows;
}

function getRegisteredKittyImageMetadataFromControls(controls: string): RegisteredKittyImageMetadata | undefined {
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	return controls === undefined ? undefined : getRegisteredKittyImageMetadataFromControls(controls);
}

function getExplicitKittyImageRows(controls: string): number | undefined {
	const value = /(?:^|,)r=(\d+)(?:,|$)/.exec(controls)?.[1];
	if (value === undefined) return undefined;
	const rows = Number.parseInt(value, 10);
	return rows > 0 ? rows : undefined;
}

function getKittyImageRowsFromControls(controls: string, fallbackRows: number): number {
	return getExplicitKittyImageRows(controls) ?? fallbackRows;
}

export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!metadata) return undefined;
	return {
		imageId: metadata.imageId,
		columns: metadata.columns,
		rows: metadata.rows,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	"i",
	"p",
	"x",
	"y",
	"w",
	"h",
	"X",
	"Y",
	"c",
	"r",
	"C",
	"U",
	"z",
	"P",
	"Q",
	"H",
	"V",
]);

/** Read the number of rows covered by an image placement without scanning its payload. */
export function getKittyImagePlacementRows(line: string): number | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (controls === undefined) return undefined;
	const explicitRows = getExplicitKittyImageRows(controls);
	if (explicitRows !== undefined) return explicitRows;
	return getRegisteredKittyImageMetadataFromControls(controls)?.rows;
}

/** Which part of an image to show, in image rows counted from the top of the image. */
export interface KittyImageCrop {
	/** Rows scrolled out above the visible area. */
	hiddenRows: number;
	/** Rows to show, counted from the first visible one. */
	visibleRows: number;
}

/**
 * Source rectangle (pixels) and target row count for showing part of an image: the Kitty protocol
 * crops with `y`/`h` in pixels and scales the result into `r` rows.
 */
function kittyImageSourceCrop(
	metadata: KittyImageMetadata,
	hiddenRows: number,
	visibleRows: number,
): { y: number; h: number; r: number } | undefined {
	if (hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return undefined;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	return { y: sourceY, h: sourceHeight, r: croppedRows };
}

/**
 * Build a placement-only command for an image line emitted by {@link renderImage}.
 *
 * With `crop`, the placement shows only that part of the already-uploaded image: terminals honour a
 * source rectangle on a placement, so this clips an image without retransmitting its payload.
 */
export function getKittyImagePlacement(line: string, crop?: KittyImageCrop): KittyImagePlacement | undefined {
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!match) return undefined;
	const metadata = getRegisteredKittyImageMetadataFromControls(match[1]);
	if (!metadata) return undefined;
	const sourceCrop = crop ? kittyImageSourceCrop(metadata, crop.hiddenRows, crop.visibleRows) : undefined;
	if (crop && !sourceCrop) return undefined;

	let commandStart = match.index;
	let commandControls = match[1];
	let transmissionEnd: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		if (terminator === -1) return undefined;
		transmissionEnd = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		commandStart = transmissionEnd;
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		if (controlsEnd === -1) return undefined;
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	let controls = match[1]
		.split(",")
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	let rows = getKittyImageRowsFromControls(match[1], metadata.rows);
	if (sourceCrop) {
		controls = controls.filter((control) => !/^[yhr]=/.test(control));
		controls.push(`y=${sourceCrop.y}`, `h=${sourceCrop.h}`, `r=${sourceCrop.r}`);
		rows = sourceCrop.r;
	}
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	return {
		imageId: metadata.imageId,
		transmissionGeneration: metadata.transmissionGeneration,
		transmissionBytes: transmissionEnd - match.index,
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		rows,
		sequence,
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !match) return line;
	const sourceCrop = kittyImageSourceCrop(metadata, hiddenRows, visibleRows);
	if (!sourceCrop) return line;
	if (hiddenRows === 0 && sourceCrop.r === metadata.rows) return line;
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceCrop.y}`, `h=${sourceCrop.h}`, `r=${sourceCrop.r}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
	if (upperCount <= 1) return upperCount;

	const lowerCount = upperCount - 1;
	const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount);
	const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount);
	return lowerDistortion < upperDistortion ? lowerCount : upperCount;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
	optimizeAspectRatio = false,
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)));
	const heightRows = scaledHeightPx / cellDimensions.heightPx;
	let rows = Math.max(1, Math.ceil(heightRows));
	if (maxHeight !== undefined) {
		rows = Math.min(maxHeight, rows);
	}

	if (!optimizeAspectRatio) {
		return { columns, rows };
	}

	if (widthScale <= heightScale) {
		const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx);
		rows = chooseLessDistortedCellCount(rows, idealRows);
	} else {
		const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx);
		columns = chooseLessDistortedCellCount(columns, idealColumns);
	}

	return { columns, rows };
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	// Reduce Kitty's cell-aligned distortion without shrinking iTerm2 reservations.
	const size = calculateImageCellSize(
		imageDimensions,
		maxWidth,
		options.maxHeightCells,
		getCellDimensions(),
		caps.images === "kitty",
	);

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Shorten home-prefixed absolute paths to ~/... for compact display. */
function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

/**
 * Text fallback when the terminal cannot render inline images.
 * Absolute paths are shown shortened (~/...) and, when OSC 8 hyperlinks are
 * available, linked to file:// so the full path remains openable.
 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const display = shortenImagePath(filename);
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			parts.push(hyperlink(display, pathToFileURL(filename).href));
		} else {
			parts.push(display);
		}
	}
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
