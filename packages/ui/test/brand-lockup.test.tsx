// Brand lockup contract: the product name is real text with an exact,
// decorative pi/plugin mark beside it; the runtime byline appears only when
// a surface asks for hierarchy.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BrandLockup } from "../src/brand/BrandLockup.tsx";
import { OmpMark } from "../src/brand/OmpMark.tsx";

describe("BrandLockup", () => {
	it("names the product as visible text", () => {
		const markup = renderToStaticMarkup(<BrandLockup />);
		expect(markup).toContain("T4 Code");
	});

	it("keeps the mark decorative so the name is announced once", () => {
		const markup = renderToStaticMarkup(<BrandLockup />);
		expect(markup).toContain('aria-hidden="true"');
		expect(markup).not.toContain("<title>");
	});

	it("shows the runtime byline only when asked", () => {
		expect(renderToStaticMarkup(<BrandLockup />)).not.toContain("Powered by Oh My Pi");
		expect(renderToStaticMarkup(<BrandLockup byline size="lg" />)).toContain(
			"Powered by Oh My Pi",
		);
	});

	it("never says the retired product name", () => {
		for (const markup of [
			renderToStaticMarkup(<BrandLockup />),
			renderToStaticMarkup(<BrandLockup byline size="lg" />),
		]) {
			expect(markup).not.toContain("Command Center");
		}
	});
});

describe("OmpMark geometry", () => {
	it("keeps the exact upstream pi/plugin geometry", () => {
		const markup = renderToStaticMarkup(<OmpMark />);
		// Upstream assets/icon.svg rects, verbatim coordinates.
		expect(markup).toContain('viewBox="0 0 120 90"');
		for (const rect of [
			'x="10" y="8"', // horizontal bar
			'x="25" y="20"', // left leg
			'x="75" y="20"', // right leg
			'x="71" y="55"', // plugin connector
		]) {
			expect(markup, `rect ${rect}`).toContain(rect);
		}
	});

	it("stays accessible by default and decorative on request", () => {
		expect(renderToStaticMarkup(<OmpMark />)).toContain("<title>Oh My Pi</title>");
		expect(renderToStaticMarkup(<OmpMark title={null} />)).toContain('aria-hidden="true"');
	});
});
