import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DishwasherDocuments } from "../src/mcp/documents.js";

test("searches local documentation and preserves document and section metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-docs-"));
  try {
    await mkdir(path.join(directory, "manuals"));
    await writeFile(path.join(directory, "manuals", "care.md"), `# Care guide

General care instructions.

## Refill dishwasher salt

Open the salt container before the next cycle and refill it with dishwasher salt.

## Clean the filter

Remove and rinse the filter under running water.
`);
    await writeFile(
      path.join(directory, "programs.txt"),
      "Eco 50 uses less energy and may take longer.",
    );
    await writeFile(path.join(directory, "ignored.json"), "{\"secret\":true}");

    const documents = new DishwasherDocuments(directory);
    assert.deepEqual(await documents.listDocuments(), [
      "manuals/care.md",
      "programs.txt",
    ]);

    const matches = await documents.search("refill salt", 5);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].document, "manuals/care.md");
    assert.equal(matches[0].section, "Refill dishwasher salt");
    assert.match(matches[0].excerpt, /salt container/);

    const result = await documents.read(
      matches[0].document,
      matches[0].section,
      2_000,
    );
    assert.deepEqual(result, {
      document: "manuals/care.md",
      content: [{
        section: "Refill dishwasher salt",
        text: "Open the salt container before the next cycle and refill it with dishwasher salt.",
      }],
      truncated: false,
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("limits document reads and reports truncation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-docs-"));
  try {
    await writeFile(path.join(directory, "manual.txt"), "a".repeat(2_000));
    const documents = new DishwasherDocuments(directory);

    const result = await documents.read("manual.txt", undefined, 1_000);

    assert.equal(result.content[0].text.length, 1_000);
    assert.equal(result.truncated, true);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("reports missing, empty, and out-of-scope documentation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dishwasher-docs-"));
  try {
    await t.test("missing directory", async () => {
      const documents = new DishwasherDocuments(path.join(directory, "missing"));
      await assert.rejects(documents.listDocuments(), /does not exist/);
    });

    await t.test("no supported files", async () => {
      await writeFile(path.join(directory, "notes.json"), "{}");
      const documents = new DishwasherDocuments(directory);
      await assert.rejects(documents.listDocuments(), /No supported dishwasher documentation/);
    });

    await t.test("path outside configured directory", async () => {
      await writeFile(path.join(directory, "manual.md"), "# Manual\nSafe guidance.");
      const documents = new DishwasherDocuments(directory);
      await assert.rejects(
        documents.read("../private.txt"),
        /was not found/,
      );
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});
