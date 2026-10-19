import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
function luminance(hex: string): number {
  const values = hex.match(/[\da-f]{2}/gi)!.map(value => Number.parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
const ratio = (left: string, right: string) => (Math.max(luminance(left), luminance(right)) + .05) / (Math.min(luminance(left), luminance(right)) + .05);

test("both theme focus tokens meet 3:1 against their actual canvas and paper surfaces", () => {
  for (const file of ["./tokens.css", "./ink.css"]) {
    const source = read(file);
    const value = (token: string) => source.match(new RegExp(`${token}:\\s*(#[\\da-f]+)`, "i"))![1];
    assert.ok(ratio(value("--focus"), value("--bg")) >= 3, file + " canvas");
    assert.ok(ratio(value("--focus"), value("--surface")) >= 3, file + " surface");
  }
});

test("shared radius tokens preserve default shapes while ink controls use ten pixels", () => {
  assert.match(read("./tokens.css"), /--radius-pill: 999px;/);
  assert.match(read("./tokens.css"), /--radius-control: 16px;/);
  assert.match(read("./ink.css"), /--radius-pill: 10px;/);
  assert.match(read("./ink.css"), /--radius-control: 10px;/);
  for (const file of ["s01-now/s01-now.css", "s04-plan/s04-plan.css", "s16-m-plan/s16-m-plan.css", "s17-m-auth/s17-m-auth.css", "s18-m-stillness/s18-m-stillness.css"]) {
    assert.doesNotMatch(read("../screens/" + file), /border-radius: (?:999|16)px;/, file);
  }
});

function elements(source: string) {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => { if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(file);
  return { file, result };
}

test("workspace judgment, material-name and next-step inputs have persistent wrapping labels", () => {
  const { file, result } = elements(read("../screens/s06-workspace/WorkspaceScreen.tsx"));
  for (const marker of ["data-flag-input", "data-material-name", "data-checkpoint-input"]) {
    const input = result.find(node => node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(file) === marker));
    assert.ok(input, marker);
    let parent: ts.Node | undefined = input.parent;
    while (parent && !(ts.isJsxElement(parent) && parent.openingElement.tagName.getText(file) === "label")) parent = parent.parent;
    assert.ok(parent, marker + " must remain within a persistent label");
  }
});

test("mobile scroll owner is a named keyboard-focusable region with inset visible focus", () => {
  const { file, result } = elements(read("../screens/mobile/MobileChrome.tsx"));
  const body = result.find(node => node.attributes.getText(file).includes('className="mchrome-body"'));
  assert.ok(body);
  assert.match(body.attributes.getText(file), /role="region"/);
  assert.match(body.attributes.getText(file), /aria-label=/);
  assert.match(body.attributes.getText(file), /tabIndex=\{0\}/);
  assert.match(read("../screens/mobile/mobile-chrome.css"), /\.mchrome-body:focus-visible\s*\{[^}]*outline-offset: -3px;/);
});

test("workspace source exposes mutually exclusive reading/editing and explicit save/cancel/retry controls", () => {
  const source = read("../screens/s06-workspace/WorkspaceScreen.tsx");
  assert.match(source, /!editingSections\[section.id\] && <p className="s06-body">/);
  assert.match(source, /!editingSections\[section.id\] \? <div className="s06-editor-actions">/);
  assert.match(source, /: <div className="s06-editor">/);
  for (const marker of ["data-section-edit-open", "data-section-edit-cancel", "data-section-save", "重试保存这一节", "取消编辑（保留未保存文字）"]) assert.ok(source.includes(marker), marker);
});
