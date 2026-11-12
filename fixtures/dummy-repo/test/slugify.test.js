import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercases and joins words with a dash", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("trims and collapses whitespace", () => {
  assert.equal(slugify("  Hello   World  "), "hello-world");
});

test("strips punctuation", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("collapses repeated dashes", () => {
  assert.equal(slugify("a -- b"), "a-b");
});
