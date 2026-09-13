import { test } from "node:test";
import assert from "node:assert/strict";
import {
	displayWidth,
	truncateToDisplayWidth,
} from "../src/display-width.ts";

// pi-tui is the host that enforces the width invariant. It is a peer dep,
// so resolve it defensively and skip the cross-checks when absent.
const tui = await import("@earendil-works/pi-tui").catch(() => undefined);
const visibleWidth = tui?.visibleWidth;

// ─── displayWidth: per-script basics ────────────────────────────────

test("displayWidth: ASCII is one column per character", () => {
	assert.equal(displayWidth(""), 0);
	assert.equal(displayWidth("abc"), 3);
	assert.equal(displayWidth("https://example.com/a?b=1"), 25);
});

test("displayWidth: Hiragana is two columns", () => {
	assert.equal(displayWidth("あ"), 2);
	assert.equal(displayWidth("ひらがな"), 8);
});

test("displayWidth: Katakana is two columns", () => {
	assert.equal(displayWidth("カ"), 2);
	assert.equal(displayWidth("カタカナ"), 8);
});

test("displayWidth: Kanji is two columns", () => {
	assert.equal(displayWidth("日"), 2);
	assert.equal(displayWidth("日本語"), 6);
});

test("displayWidth: Hangul is two columns", () => {
	assert.equal(displayWidth("한"), 2);
	assert.equal(displayWidth("한국어"), 6);
	// Hangul Jamo initial consonants (U+1100 band).
	assert.equal(displayWidth("\u1100"), 2);
});

test("displayWidth: fullwidth forms are two columns", () => {
	assert.equal(displayWidth("ａｂｃ"), 6);
	assert.equal(displayWidth("￥"), 2);
	assert.equal(displayWidth("～"), 2);
});

test("displayWidth: emoji are two columns", () => {
	assert.equal(displayWidth("🚀"), 2);
	assert.equal(displayWidth("🎉🔥"), 4);
	// BMP emoji-presentation code points that sit below the CJK band.
	assert.equal(displayWidth("⌚"), 2);
	assert.equal(displayWidth("⛄"), 2);
	assert.equal(displayWidth("✅"), 2);
	assert.equal(displayWidth("⭐"), 2);
});

test("displayWidth: mixed ASCII and CJK", () => {
	assert.equal(displayWidth("a日b中c한"), 9);
	assert.equal(
		displayWidth("aio-webfetch https://ja.wikipedia.org/wiki/日本語のページタイトル"),
		65,
	);
});

test("displayWidth: box drawing and Braille stay one column", () => {
	// Line-art must not be widened or bordered output over-truncates.
	assert.equal(displayWidth("─│┌┐└┘"), 6);
	assert.equal(displayWidth("⣾⣽⣻"), 3);
});

// ─── displayWidth: ANSI ────────────────────────────────────────────

test("displayWidth: ANSI escapes contribute zero width", () => {
	assert.equal(displayWidth("\x1b[31mabc\x1b[0m"), 3);
	assert.equal(displayWidth("\x1b[1m\x1b[38;5;208m日本語\x1b[0m"), 6);
	assert.equal(displayWidth("\x1b]0;window title\x07text"), 4);
});

// ─── truncateToDisplayWidth ────────────────────────────────────────

test("truncate: text under budget is returned unchanged", () => {
	assert.equal(truncateToDisplayWidth("abc", 10), "abc");
	assert.equal(truncateToDisplayWidth("日本語", 6), "日本語");
});

test("truncate: exact-width input is returned unchanged", () => {
	assert.equal(truncateToDisplayWidth("abcde", 5), "abcde");
	assert.equal(truncateToDisplayWidth("日本語", 6), "日本語");
});

test("truncate: one column over budget is cut with an ellipsis", () => {
	assert.equal(truncateToDisplayWidth("abcdef", 5), "abcd…");
	// 7 columns into a 6-column budget: only 5 fit alongside "…".
	assert.equal(truncateToDisplayWidth("日本語さ", 6), "日本…");
});

test("truncate: never splits a wide character", () => {
	// Budget 5 with "…" (1 col) leaves 4 columns = exactly two wide chars.
	const out = truncateToDisplayWidth("日本語", 5);
	assert.equal(out, "日本…");
	assert.equal(displayWidth(out), 5);
});

test("truncate: width 1 yields the ellipsis only", () => {
	assert.equal(truncateToDisplayWidth("abc", 1), "…");
	assert.equal(displayWidth(truncateToDisplayWidth("日本語", 1)), 1);
});

test("truncate: width <= 0 yields an empty string", () => {
	assert.equal(truncateToDisplayWidth("abc", 0), "");
	assert.equal(truncateToDisplayWidth("abc", -5), "");
	assert.equal(displayWidth(truncateToDisplayWidth("日本語", 0)), 0);
});

test("truncate: non-string input yields an empty string", () => {
	assert.equal(truncateToDisplayWidth(undefined, 10), "");
	assert.equal(truncateToDisplayWidth(null, 10), "");
	assert.equal(truncateToDisplayWidth(42, 10), "");
});

test("truncate: ellipsis wider than the width is dropped, not overflowed", () => {
	const out = truncateToDisplayWidth("abcdef", 1, "……");
	assert.equal(displayWidth(out), 1);
	assert.ok(!out.includes("……"));
	assert.equal(out, "a");
});

test("truncate: custom ellipsis is honoured", () => {
	assert.equal(truncateToDisplayWidth("abcdef", 5, ".."), "abc..");
	assert.equal(displayWidth(truncateToDisplayWidth("abcdef", 5, "..")), 5);
});

test("truncate: ANSI styling does not leak past the cut", () => {
	const out = truncateToDisplayWidth("\x1b[31mabcdef\x1b[0m", 5);
	assert.equal(displayWidth(out), 5);
	assert.ok(out.endsWith("\x1b[0m"), "expected a trailing reset");
	assert.ok(out.includes("\x1b[31m"), "expected the original colour to survive");
});

test("truncate: ANSI-only prefix is preserved without consuming width", () => {
	const out = truncateToDisplayWidth("\x1b[1m\x1b[38;5;33m日本語です", 5);
	assert.equal(displayWidth(out), 5);
	assert.ok(out.startsWith("\x1b[1m"));
});

test("truncate: output never contains a lone surrogate", () => {
	const inputs = ["🚀🎉🔥日本語", "a👨‍👩‍👧‍👧b", "🇯🇵🇺🇸"];
	for (const input of inputs) {
		for (let width = 1; width <= 20; width++) {
			const out = truncateToDisplayWidth(input, width);
			for (let i = 0; i < out.length; i++) {
				const code = out.charCodeAt(i);
				if (code >= 0xd800 && code <= 0xdbff) {
					const next = out.charCodeAt(i + 1);
					assert.ok(
						next >= 0xdc00 && next <= 0xdfff,
						`high surrogate not followed by low surrogate in ${JSON.stringify(out)} at ${i}`,
					);
					i++;
				} else {
					assert.ok(
						!(code >= 0xdc00 && code <= 0xdfff),
						`lone low surrogate in ${JSON.stringify(out)} at ${i}`,
					);
				}
			}
		}
	}
});

test("truncate: lone surrogate input does not throw or overflow", () => {
	const lone = `a${String.fromCharCode(0xd800)}b日本語`;
	for (const width of [1, 2, 3, 8, 40]) {
		const out = truncateToDisplayWidth(lone, width);
		assert.ok(displayWidth(out) <= width);
	}
});

// ─── combining marks (documented over-estimate) ────────────────────

test("combining marks count as one column (over-estimate, safe)", () => {
	// "e" + U+0301 COMBINING ACUTE: a grapheme-aware measurer says 1,
	// this helper says 2. Over-counting is the safe direction.
	assert.equal(displayWidth("é"), 2);
});

test("ZWJ emoji clusters are counted per code point (over-estimate, safe)", () => {
	const family = "👨‍👩‍👧‍👧";
	// 4 emoji (2 cols each) + 3 ZWJ (1 col each) = 11.
	assert.equal(displayWidth(family), 11);
});

// ─── property: the core invariant ──────────────────────────────────

const CORPUS = [
	"",
	"a",
	"plain ascii text of moderate length for truncation testing purposes",
	"https://example.com/very/long/path?query=value&other=thing#fragment",
	"日本語",
	"日本語のタイトルです",
	"aio-webfetch https://ja.wikipedia.org/wiki/日本語のページタイトル",
	"한국어 제목이 아주 길 경우의 테스트",
	"中文标题截断测试",
	"ひらがなとカタカナの混在",
	"ａｂｃ全角テスト",
	"🚀 emoji 🎉 mixed 🔥 content",
	"👨‍👩‍👧‍👧 ZWJ cluster",
	"e\u0301 combining accents",
	"\x1b[31mstyled 日本語\x1b[0m tail",
	"─".repeat(80),
	"混在 mixed 日本語 and ASCII and 🚀 and 全角ＡＢＣ",
];

test("invariant: displayWidth(truncate(s, W)) <= W for all corpus widths", () => {
	for (const s of CORPUS) {
		for (let width = 1; width <= 200; width++) {
			const out = truncateToDisplayWidth(s, width);
			assert.ok(
				displayWidth(out) <= width,
				`displayWidth overflow for ${JSON.stringify(s)} at W=${width}: ${displayWidth(out)} > ${width} (${JSON.stringify(out)})`,
			);
		}
	}
});

test("invariant: helper never under-measures pi-tui visibleWidth", { skip: !visibleWidth }, () => {
	// Safety direction: displayWidth(s) >= visibleWidth(s). If this ever
	// fails, fallback truncation could emit an over-width line and crash pi.
	for (const s of CORPUS) {
		assert.ok(
			displayWidth(s) >= visibleWidth(s),
			`under-measure for ${JSON.stringify(s)}: ${displayWidth(s)} < ${visibleWidth(s)}`,
		);
	}
});

test("invariant: sampled code points never under-measure pi-tui", { skip: !visibleWidth }, () => {
	// Sampled across the BMP + emoji planes to keep the suite fast.
	for (let cp = 0x20; cp <= 0x10ffff; cp += 97) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		const s = String.fromCodePoint(cp);
		assert.ok(
			displayWidth(s) >= visibleWidth(s),
			`under-measure for U+${cp.toString(16)}: ${displayWidth(s)} < ${visibleWidth(s)}`,
		);
	}
});

// ─── regression: the original crash ────────────────────────────────

const CRASH_INPUT =
	"aio-webfetch https://ja.wikipedia.org/wiki/日本語のページタイトル";

test("regression: the crash input defeats a .length guard", () => {
	// The bug: .length says it fits, display columns say it does not.
	assert.ok(
		CRASH_INPUT.length <= 60,
		`expected .length <= 60, got ${CRASH_INPUT.length}`,
	);
	assert.ok(
		displayWidth(CRASH_INPUT) > 60,
		`expected displayWidth > 60, got ${displayWidth(CRASH_INPUT)}`,
	);
});

test("regression: the old guard would emit an over-width line", () => {
	const width = 60;
	const old =
		CRASH_INPUT.length > width && width > 1
			? `${CRASH_INPUT.slice(0, width - 1)}…`
			: CRASH_INPUT;
	// Documents the pre-fix behaviour: no truncation happened at all.
	assert.equal(old, CRASH_INPUT);
	assert.ok(displayWidth(old) > width);
});

test("regression: the new helper truncates the crash input safely", () => {
	const inputWidth = displayWidth(CRASH_INPUT);
	for (const width of [20, 40, 60, 80, 179]) {
		const out = truncateToDisplayWidth(CRASH_INPUT, width);
		assert.ok(
			displayWidth(out) <= width,
			`W=${width}: ${displayWidth(out)} > ${width}`,
		);
		if (width < inputWidth) {
			assert.ok(out.endsWith("…"), `W=${width}: expected ellipsis`);
		} else {
			assert.equal(out, CRASH_INPUT, `W=${width}: fits, expect no change`);
		}
	}
});

// ─── integration: the real lazy fallback path ──────────────────────

test("lazy renderCall truncates a CJK URL within terminal width", async () => {
	const { registerLazyTools } = await import("../src/tools/lazy.ts");
	const tools = new Map();
	registerLazyTools(
		{
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
		},
		async () => {},
		Promise.resolve(),
	);

	const theme = {
		fg: (_color, value) => `\x1b[38;5;7m${value}\x1b[0m`,
		bold: (value) => `\x1b[1m${value}\x1b[0m`,
	};

	// renderCall runs before the lazy runtime loads, so this exercises
	// fallbackComponent — the exact path that used to crash.
	const tool = tools.get("aio-webfetch");
	assert.ok(tool, "aio-webfetch should be registered lazily");

	for (const width of [40, 60, 179]) {
		const component = tool.renderCall(
			{ url: "https://ja.wikipedia.org/wiki/日本語のページタイトル" },
			theme,
		);
		const lines = component.render(width);
		assert.equal(lines.length, 1);
		assert.ok(
			displayWidth(lines[0]) <= width,
			`W=${width}: fallback renderCall line is ${displayWidth(lines[0])} columns`,
		);
		if (visibleWidth) {
			assert.ok(
				visibleWidth(lines[0]) <= width,
				`W=${width}: pi-tui would throw on ${JSON.stringify(lines[0])}`,
			);
		}
	}
});

test("lazy renderCall truncates a CJK search query within terminal width", async () => {
	const { registerLazyTools } = await import("../src/tools/lazy.ts");
	const tools = new Map();
	registerLazyTools(
		{ registerTool(tool) { tools.set(tool.name, tool); } },
		async () => {},
		Promise.resolve(),
	);
	const theme = {
		fg: (_color, value) => `\x1b[38;5;7m${value}\x1b[0m`,
		bold: (value) => `\x1b[1m${value}\x1b[0m`,
	};
	const tool = tools.get("aio-websearch");
	for (const width of [40, 179]) {
		const lines = tool
			.renderCall({ query: "日本語の検索クエリでとても長いもの" }, theme)
			.render(width);
		assert.ok(displayWidth(lines[0]) <= width);
		if (visibleWidth) assert.ok(visibleWidth(lines[0]) <= width);
	}
});

// The host pads and wraps using its own measurement, so this assertion is
// made against pi-tui's `visibleWidth` — the value that actually decides
// whether the host throws. Skipped when the peer is not installed.
test("tui-compat Text never exceeds the requested width", { skip: !visibleWidth }, async () => {
	const { Text } = await import("../src/tools/tui-compat.ts");
	for (const text of CORPUS.filter((s) => s !== "")) {
		for (const width of [20, 40, 179]) {
			const lines = new Text(text, 0, 0).render(width);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= width,
					`W=${width}: ${JSON.stringify(text)} rendered ${JSON.stringify(line)}`,
				);
			}
		}
	}
});
