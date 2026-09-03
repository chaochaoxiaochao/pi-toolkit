import assert from "node:assert/strict";
import { clampBtwScrollTop, getBtwPageScrollSize } from "../btw-scroll.ts";

assert.equal(getBtwPageScrollSize(18), 18, "page scrolling uses the transcript viewport height");
assert.equal(getBtwPageScrollSize(8.9), 8, "page scrolling uses a whole number of lines");
assert.equal(getBtwPageScrollSize(0), 1, "page scrolling always moves at least one line");

assert.equal(clampBtwScrollTop(-3, 20, 8), 0, "scroll top clamps at the start");
assert.equal(clampBtwScrollTop(4, 20, 8), 4, "scroll top remains inside the range");
assert.equal(clampBtwScrollTop(99, 20, 8), 12, "scroll top clamps at the end");
assert.equal(clampBtwScrollTop(5, 4, 8), 0, "short content cannot scroll");
assert.equal(clampBtwScrollTop(Number.NaN, 20, 8), 0, "invalid scroll input falls back to the start");

console.log("BTW history scrolling tests passed");
