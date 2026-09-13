// ─── Display-column measurement for fallback rendering ───────────────
//
// `pi-tui` throws when a rendered line is wider than the terminal:
//
//   Rendered line N exceeds terminal width (visibleWidth(line) > width)
//
// Fallback renderers must therefore truncate by *display columns*, not by
// `String.length` (UTF-16 code units). A CJK ideograph is 1 code unit but
// 2 terminal columns, so a `.length` guard silently passes over-wide text
// straight through to the host, which crashes.
//
// This module is deliberately dependency-free (no `pi-tui`, no project
// imports) so both the lazy tool shim and the `Text` compatibility layer
// can use it without pulling either dependency graph.
//
// SAFETY CONTRACT
//   The measurement is a *conservative over-estimate*. It is required only
//   that `displayWidth(s) >= visibleWidth(s)` for every input, so a line
//   that fits here also fits under the host's own measurement. It is NOT a
//   clone of `pi-tui`'s width table. Known intentional differences:
//     * Combining marks (e.g. U+0301) count as 1 column; a grapheme-aware
//       measurer counts 0.
//     * ZWJ emoji clusters (family/flag sequences) count as the sum of
//       their parts; a grapheme-aware measurer counts one cluster.
//     * Scripts above U+2E80 that the host renders narrow (Bamum, Lisu,
//       unassigned planes 3-13, …) count as 2 columns.
//   Every difference errs wide. Over-truncation is cosmetic; under-counting
//   crashes the host.
//
//   ANSI escape sequences are recognised and counted as zero width. If a
//   truncation cuts through styled text, a reset is appended so colour
//   cannot bleed onto the following line.
//
//   Iteration is by Unicode code point, so surrogate pairs are never
//   split; lone surrogates decode to U+FFFD instead of producing malformed
//   output.

/**
 * Two-column ranges.
 *
 * `WIDE_EMOJI_SYMBOLS` lists the BMP emoji-presentation code points below
 * U+2E80 that terminals render double-width. That band is otherwise full
 * of single-width material (box drawing, block elements, Braille, most
 * dingbats), so it cannot be collapsed into a blanket rule without
 * visibly over-truncating line-art.
 *
 * Everything from U+2E80 upward is treated as wide. That is coarser than
 * strictly necessary but errs in the safe direction and keeps the table
 * stable when the host widens its own ranges.
 */
const WIDE_EMOJI_SYMBOLS: ReadonlyArray<readonly [number, number]> = [
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2630, 0x2637],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x268a, 0x268f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
];

/** CJK / fullwidth / Hangul Jamo band lower bound. */
const WIDE_FROM = 0x1100;
const WIDE_JAMO_TO = 0x115f;
const WIDE_CJK_FROM = 0x2e80;

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>) {
	for (let i = 0; i < ranges.length; i++) {
		if (cp >= ranges[i][0] && cp <= ranges[i][1]) return true;
	}
	return false;
}

/**
 * Display width of one code point in terminal columns.
 *
 * Control characters and zero-width formatting code points are counted as
 * 1 column. That over-counts (a real terminal shows 0) but keeps the
 * branch cheap and errs safe.
 */
function codePointWidth(cp: number): number {
	if (cp >= WIDE_CJK_FROM) return 2;
	if (cp >= WIDE_FROM && cp <= WIDE_JAMO_TO) return 2;
	if (inRanges(cp, WIDE_EMOJI_SYMBOLS)) return 2;
	return 1;
}

/** Split-and-keep pattern: capture group 1 holds each escape sequence. */
const ANSI_SPLIT =
	/(\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;

/**
 * Estimated terminal display width of `text`, in columns.
 *
 * ANSI escape sequences contribute 0. See the module header for the
 * over-estimate contract.
 */
export function displayWidth(text: string): number {
	if (typeof text !== "string" || text === "") return 0;
	const parts = text.split(ANSI_SPLIT);
	let width = 0;
	for (let i = 0; i < parts.length; i++) {
		// Odd indices are captured ANSI escapes: zero width.
		if (i % 2 === 1) continue;
		const chunk = parts[i];
		if (!chunk) continue;
		for (const ch of chunk) width += codePointWidth(ch.codePointAt(0) ?? 0xfffd);
	}
	return width;
}

/**
 * Truncate `text` so that `displayWidth(result) <= width`.
 *
 * `ellipsis` is appended when the text is cut. If the ellipsis alone is
 * wider than `width`, it is dropped and the text is hard-cut instead, so
 * the invariant holds for any positive width.
 *
 * ANSI escapes emitted before the cut are preserved (zero width); if any
 * SGR sequence opened a style, a reset is appended to the result.
 */
export function truncateToDisplayWidth(
	text: string,
	width: number,
	ellipsis = "…",
): string {
	if (typeof text !== "string" || text === "") return "";
	if (!Number.isFinite(width) || width <= 0) return "";
	if (displayWidth(text) <= width) return text;

	const ellipsisWidth = displayWidth(ellipsis);
	// When the ellipsis cannot fit, fall back to a plain column cut.
	const limit = ellipsisWidth <= width ? width - ellipsisWidth : width;

	const parts = text.split(ANSI_SPLIT);
	let out = "";
	let used = 0;
	let styled = false;
	let done = false;

	for (let i = 0; i < parts.length && !done; i++) {
		const part = parts[i];
		if (!part) continue;
		if (i % 2 === 1) {
			// ANSI escape: zero width, keep it.
			out += part;
			if (part.endsWith("m")) styled = true;
			continue;
		}
		for (const ch of part) {
			const cw = codePointWidth(ch.codePointAt(0) ?? 0xfffd);
			// Stop at the first code point that will not fit rather than
			// skipping it and keeping later narrow characters.
			if (used + cw > limit) {
				done = true;
				break;
			}
			out += ch;
			used += cw;
		}
	}

	if (ellipsisWidth <= width) out += ellipsis;
	if (styled) out += "\x1b[0m";
	return out;
}
