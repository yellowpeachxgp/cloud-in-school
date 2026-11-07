import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../apps/console/src/main.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../apps/console/public/static/xpeach-sdk.css", import.meta.url), "utf8");
const styles = ["liquid-glass", "flutter-m3", "fresh-breeze", "cream-pastel"];

test("saved style parser retains all four styles and rejects unknown values", () => {
  const expression = source.match(/var uiStyle = (.+);/)[1];
  for (const savedStyle of [...styles, null, "unknown"]) {
    assert.equal(vm.runInNewContext(expression, { savedStyle }), styles.includes(savedStyle) ? savedStyle : "liquid-glass");
  }
});

test("both style switchers cycle through every style repeatedly", () => {
  const switches = [...source.matchAll(/var styles = \[[^;]+;\s*var next = [^;]+;/g)];
  assert.equal(switches.length, 2);
  for (const [code] of switches) {
    const context = { cur: "liquid-glass" };
    for (let i = 1; i <= 8; i++) {
      vm.runInNewContext(code, context);
      assert.equal(context.next, styles[i % styles.length]);
      context.cur = context.next;
    }
  }
});

test("new styles cannot override dark surfaces with light colors", () => {
  for (const style of styles.slice(2)) {
    assert.ok(css.includes('[data-ui-style="' + style + '"]:not([data-theme="dark"]) {'));
    const dark = css.match(new RegExp('\\[data-theme="dark"\\]\\[data-ui-style="' + style + '"\\] \\{([^}]+)\\}'))[1];
    assert.doesNotMatch(dark, /--xp-(?:bg|surface|text):/);
  }
  // WCAG contrast for inherited primary and secondary text on dark cards.
  function luminance(hex) {
    const rgb = hex.match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  const darkTokens = css.match(/\[data-theme="dark"\] \{([^}]+)\}/)[1];
  const token = name => darkTokens.match(new RegExp("--xp-" + name + ": #([a-f0-9]{6})"))[1];
  for (const text of ["text", "text-secondary", "text-muted"]) {
    assert.ok((luminance(token(text)) + .05) / (luminance(token("surface")) + .05) >= 4.5);
  }
});
