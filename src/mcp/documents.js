import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".pdf", ".txt"]);
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_CHARACTERS = 12_000;

export class DishwasherDocuments {
  constructor(root = process.env.DISHWASHER_DOCUMENTS_DIR || "docs/dishwasher") {
    this.root = path.resolve(root);
  }

  async search(query, limit = 5) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      throw new Error("Documentation search query must not be empty.");
    }
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const documents = await this.listDocuments();
    const matches = [];

    for (const document of documents) {
      const sections = await this.loadSections(document);
      for (const section of sections) {
        const searchable = `${section.title}\n${section.text}`.toLocaleLowerCase();
        if (!terms.every((term) => searchable.includes(term))) {
          continue;
        }
        matches.push({
          document,
          section: section.title,
          score: terms.reduce((score, term) => score + countOccurrences(searchable, term), 0),
          excerpt: excerptAroundMatch(section.text, terms),
        });
      }
    }

    return matches
      .sort((left, right) => right.score - left.score
        || left.document.localeCompare(right.document)
        || left.section.localeCompare(right.section))
      .slice(0, limit)
      .map(({ score, ...match }) => match);
  }

  async read(document, section, maxCharacters = DEFAULT_MAX_CHARACTERS) {
    const relativePath = normalizeDocumentPath(document);
    const documents = await this.listDocuments();
    if (!documents.includes(relativePath)) {
      throw new Error(
        `Documentation file "${relativePath}" was not found in ${this.root}.`,
      );
    }
    const sections = await this.loadSections(relativePath);
    const selected = section
      ? sections.filter((item) => item.title === section)
      : sections;
    if (selected.length === 0) {
      throw new Error(
        `Section "${section}" was not found in documentation file "${relativePath}".`,
      );
    }

    let remaining = maxCharacters;
    const content = [];
    for (const item of selected) {
      if (remaining <= 0) {
        break;
      }
      const text = item.text.slice(0, remaining);
      content.push({ section: item.title, text });
      remaining -= text.length;
    }
    return {
      document: relativePath,
      content,
      truncated: selected.some((item, index) => content[index]?.text.length < item.text.length)
        || content.length < selected.length,
    };
  }

  async listDocuments() {
    let rootStats;
    try {
      rootStats = await stat(this.root);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(
          `Dishwasher documentation directory does not exist: ${this.root}. `
          + "Create it or set DISHWASHER_DOCUMENTS_DIR.",
          { cause: error },
        );
      }
      throw new Error(`Unable to access dishwasher documentation directory: ${this.root}.`, {
        cause: error,
      });
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`Dishwasher documentation path is not a directory: ${this.root}.`);
    }

    const documents = [];
    await collectDocuments(this.root, this.root, documents);
    if (documents.length === 0) {
      throw new Error(
        `No supported dishwasher documentation was found in ${this.root}. `
        + "Add a .md, .markdown, .txt, or .pdf file.",
      );
    }
    return documents.sort();
  }

  async loadSections(relativePath) {
    const filePath = resolveInsideRoot(this.root, relativePath);
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_DOCUMENT_BYTES) {
      throw new Error(
        `Documentation file "${relativePath}" exceeds the 25 MB size limit.`,
      );
    }

    const extension = path.extname(relativePath).toLowerCase();
    if (extension === ".pdf") {
      return loadPdfSections(filePath);
    }
    const text = await readFile(filePath, "utf8");
    return extension === ".md" || extension === ".markdown"
      ? splitMarkdownSections(text)
      : [{ title: "Document", text: text.trim() }];
  }
}

async function collectDocuments(root, directory, documents) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Unable to read dishwasher documentation directory: ${directory}.`, {
      cause: error,
    });
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectDocuments(root, entryPath, documents);
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      documents.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
}

async function loadPdfSections(filePath) {
  const parser = new PDFParse({ data: await readFile(filePath) });
  try {
    const result = await parser.getText();
    return result.pages.map((page) => ({
      title: `Page ${page.num}`,
      text: page.text.trim(),
    }));
  } catch (error) {
    throw new Error(`Unable to extract text from PDF documentation: ${filePath}.`, {
      cause: error,
    });
  } finally {
    await parser.destroy();
  }
}

function splitMarkdownSections(text) {
  const sections = [];
  let title = "Document";
  let lines = [];
  const flush = () => {
    const content = lines.join("\n").trim();
    if (content) {
      sections.push({ title, text: content });
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[2];
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections.length > 0 ? sections : [{ title: "Document", text: "" }];
}

function normalizeDocumentPath(document) {
  if (typeof document !== "string" || !document.trim()) {
    throw new Error("Documentation file name must not be empty.");
  }
  return document.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function resolveInsideRoot(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Documentation file must be inside DISHWASHER_DOCUMENTS_DIR.");
  }
  return resolved;
}

function countOccurrences(text, term) {
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(term, position)) !== -1) {
    count += 1;
    position += term.length;
  }
  return count;
}

function excerptAroundMatch(text, terms) {
  const normalized = text.toLocaleLowerCase();
  const positions = terms
    .map((term) => normalized.indexOf(term))
    .filter((position) => position >= 0);
  const position = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, position - 180);
  const end = Math.min(text.length, position + 420);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
