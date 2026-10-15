import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  END_MARK,
  START_MARK,
  fromBase64,
  parseRepo,
  projectsSection,
  replaceSection,
  summarize,
  toBase64,
} from "../readme.ts";

test("repository addresses are read, and anything else is refused", () => {
  assert.deepEqual(parseRepo("https://github.com/octocat/hello-world"), {
    owner: "octocat",
    repo: "hello-world",
  });
  assert.deepEqual(parseRepo("https://github.com/octocat/hello.git/"), {
    owner: "octocat",
    repo: "hello",
  });
  assert.deepEqual(parseRepo("https://github.com/octocat/hello/tree/main/src"), {
    owner: "octocat",
    repo: "hello",
  });
  assert.equal(parseRepo("http://github.com/octocat/hello"), null);
  assert.equal(parseRepo("https://evil.test/octocat/hello"), null);
  assert.equal(parseRepo("https://github.com/octocat"), null);
  assert.equal(parseRepo("not a url"), null);
});

test("the section lists projects and keeps its markers", () => {
  const section = projectsSection(
    [
      { title: "Maps [beta]", tagline: "Offline maps", url: "https://example.com/maps" },
      { title: "Notes", tagline: null, url: null },
    ],
    "Hackathon projects",
    "Bogey",
  );
  assert.ok(section.startsWith(START_MARK) && section.endsWith(END_MARK));
  assert.match(section, /- \[Maps beta\]\(https:\/\/example.com\/maps\) - Offline maps/);
  assert.match(section, /\n- Notes\n/);
});

test("a section replaces the old one and leaves the rest alone", () => {
  const first = replaceSection("# Hi\n\nAbout me.\n", `${START_MARK}\none\n${END_MARK}`);
  assert.equal(first, `# Hi\n\nAbout me.\n\n${START_MARK}\none\n${END_MARK}\n`);
  const second = replaceSection(first + "\nBye.\n", `${START_MARK}\ntwo\n${END_MARK}`);
  assert.equal(second, `# Hi\n\nAbout me.\n\n${START_MARK}\ntwo\n${END_MARK}\n\nBye.\n`);
  assert.equal(
    replaceSection("", `${START_MARK}\nx\n${END_MARK}`),
    `${START_MARK}\nx\n${END_MARK}\n`,
  );
});

test("text survives base64, including non-Latin characters", () => {
  const text = "héllo — 世界 🚀";
  assert.equal(fromBase64(toBase64(text)), text);
  assert.equal(fromBase64("aGVs\nbG8="), "hello");
});

test("a summary is the first real paragraph, as plain text", () => {
  const readme = [
    "# Project",
    "",
    "[![build](https://x/y.svg)](https://x)",
    "",
    "<p align=center>logo</p>",
    "",
    "A **fast** tool for [mapping](https://x) things.\nSecond line.",
    "",
    "## Install",
  ].join("\n");
  assert.equal(summarize(readme), "A fast tool for mapping things. Second line.");
  assert.equal(summarize("# Only a heading"), "");
  assert.equal(summarize("word ".repeat(100), 20).length, 20);
});
