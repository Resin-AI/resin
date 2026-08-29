#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * @typedef {Object} AdrMetadata
 * @property {string} file - Relative path to ADR file
 * @property {string} fullPath - Absolute path
 * @property {number} number - Parsed sequential integer
 * @property {string} numberStr - 4-digit zero-padded string
 * @property {string} slug - Kebab-case slug
 * @property {string} [title] - Title from H1
 * @property {string} [status] - Declared status
 * @property {string} [date] - Declared date
 * @property {string} [supersedes] - Referenced superseded ADR
 * @property {string} [supersededBy] - Referenced superseding ADR
 * @property {string[]} sections - H2 section headings
 * @property {string} content - Full raw markdown content
 */

/**
 * @typedef {Object} AdrViolation
 * @property {string} rule - Rule category (e.g., "SEQUENCE", "STATUS", "SECTION", "LINK", "GLOSSARY")
 * @property {string} file - Relative file path
 * @property {number} [line] - 1-based line number if applicable
 * @property {string} message - Description of the violation
 */

/**
 * @typedef {Object} VerificationResult
 * @property {boolean} valid - Whether all checks passed
 * @property {AdrViolation[]} violations - List of detected violations
 * @property {AdrMetadata[]} adrs - Parsed ADR records
 * @property {Record<string, any>} stats - Summary statistics
 */

export const VALID_STATUSES = ["proposed", "accepted", "superseded", "deprecated", "rejected"];

export const CANONICAL_TERMS = [
  "Gateway",
  "Observer",
  "Runtime",
  "Evolution Engine",
  "Candidate",
  "Tool Version",
  "Activation",
  "Canary",
  "Promotion",
  "Rollback",
  "Workspace Scope",
  "Device",
  "Capability Envelope",
];

export const REQUIRED_ARCHITECTURE_DOCS = ["overview.md", "boundaries.md", "glossary.md", "nfr.md"];

/**
 * Parse an ADR markdown file into structured metadata
 * @param {string} filePath - Absolute or relative path to ADR file
 * @param {string} rootDir - Monorepo root directory
 * @returns {AdrMetadata}
 */
export function parseAdr(filePath, rootDir = process.cwd()) {
  const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
  const relPath = path.relative(rootDir, fullPath);
  const fileName = path.basename(fullPath);
  const content = fs.readFileSync(fullPath, "utf-8");

  const match = fileName.match(/^([0-9]{4})-(.+)\.md$/);
  const numberStr = match ? match[1] : "0000";
  const number = Number.parseInt(numberStr, 10);
  const slug = match ? match[2] : fileName.replace(/\.md$/, "");

  let title = "";
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  let status = "";
  const statusMatch = content.match(/\*\*Status\*\*:\s*`?([a-zA-Z]+)`?/i);
  if (statusMatch) {
    status = statusMatch[1].trim().toLowerCase();
  }

  let date = "";
  const dateMatch = content.match(/\*\*Date\*\*:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  if (dateMatch) {
    date = dateMatch[1].trim();
  }

  let supersedes = "";
  const supersedesMatch = content.match(/\*\*Supersedes\*\*:\s*([^\n\r]+)/i);
  if (supersedesMatch) {
    supersedes = supersedesMatch[1].trim();
  }

  let supersededBy = "";
  const supersededByMatch = content.match(/\*\*Superseded by\*\*:\s*([^\n\r]+)/i);
  if (supersededByMatch) {
    supersededBy = supersededByMatch[1].trim();
  }

  const sections = [];
  const sectionRegex = /^##\s+(.+)$/gm;
  let sectionMatch;
  while (true) {
    sectionMatch = sectionRegex.exec(content);
    if (sectionMatch === null) break;
    sections.push(sectionMatch[1].trim());
  }

  return {
    file: relPath,
    fullPath,
    number,
    numberStr,
    slug,
    title,
    status,
    date,
    supersedes,
    supersededBy,
    sections,
    content,
  };
}

/**
 * Load excluded / reserved ADR numbers from repository-split.json if present
 * @param {string} rootDir
 * @returns {Set<number>}
 */
export function getExcludedAdrNumbers(rootDir = process.cwd()) {
  const splitConfigPath = path.resolve(rootDir, "repository-split.json");
  const excludedNumbers = new Set();
  if (!fs.existsSync(splitConfigPath)) {
    return excludedNumbers;
  }
  try {
    const config = JSON.parse(fs.readFileSync(splitConfigPath, "utf-8"));
    const privatePaths = [
      ...(Array.isArray(config.privatePaths) ? config.privatePaths : []),
      ...(Array.isArray(config.forbiddenPublicPatterns) ? config.forbiddenPublicPatterns : []),
    ];
    for (const p of privatePaths) {
      const match = p.match(/(?:^|\/)docs\/adr\/(\d{4})-[^/]+\.md$/);
      if (match) {
        excludedNumbers.add(Number.parseInt(match[1], 10));
      }
    }
  } catch {
    // If parsing fails, return empty set
  }
  return excludedNumbers;
}

/**
 * Validate sequential numbering of ADR files
 * @param {AdrMetadata[]} adrs
 * @param {string|Set<number>} [rootDirOrExcluded] - Monorepo root directory or pre-parsed excluded numbers Set
 * @returns {AdrViolation[] Offline}
 */
export function validateSequentialNumbering(adrs, rootDirOrExcluded = process.cwd()) {
  /** @type {AdrViolation[]} */
  const violations = [];

  if (adrs.length === 0) {
    violations.push({
      rule: "SEQUENCE",
      file: "docs/adr",
      message: "No ADR files found in docs/adr directory.",
    });
    return violations;
  }

  const excludedNumbers =
    rootDirOrExcluded instanceof Set
      ? rootDirOrExcluded
      : typeof rootDirOrExcluded === "string"
        ? getExcludedAdrNumbers(rootDirOrExcluded)
        : new Set();

  // Sort by parsed number
  const sorted = [...adrs].sort((a, b) => a.number - b.number);

  // Check starts at 1 (or 1 is reserved/excluded)
  if (sorted[0].number !== 1 && !excludedNumbers.has(1)) {
    violations.push({
      rule: "SEQUENCE",
      file: sorted[0].file,
      message: `First ADR must be 0001, but found ${sorted[0].numberStr}.`,
    });
  }

  const seenNumbers = new Set();
  let nextExpected = 1;

  for (let i = 0; i < sorted.length; i++) {
    const adr = sorted[i];

    // Check duplicate
    if (seenNumbers.has(adr.number)) {
      violations.push({
        rule: "SEQUENCE",
        file: adr.file,
        message: `Duplicate ADR number detected: ${adr.numberStr}.`,
      });
    }
    seenNumbers.add(adr.number);

    // Advance nextExpected past any excluded numbers before this ADR
    while (nextExpected < adr.number && excludedNumbers.has(nextExpected)) {
      nextExpected++;
    }

    // Check strictly sequential accounting for reserved private ADR numbers
    if (adr.number !== nextExpected) {
      violations.push({
        rule: "SEQUENCE",
        file: adr.file,
        message: `ADR sequence gap: expected 000${nextExpected}, but found ${adr.numberStr}.`,
      });
    }

    nextExpected = adr.number + 1;

    // Check filename format
    const baseName = path.basename(adr.file);
    if (!/^[0-9]{4}-[a-z0-9-]+\.md$/.test(baseName)) {
      violations.push({
        rule: "NAMING",
        file: adr.file,
        message: `Filename "${baseName}" does not match strict kebab-case format: ^[0-9]{4}-[a-z0-9-]+\\.md$`,
      });
    }
  }

  return violations;
}

/**
 * Validate markdown links in files
 * @param {string[]} filePaths - Absolute or relative file paths
 * @param {string} rootDir - Root workspace directory
 * @returns {AdrViolation[]}
 */
export function validateMarkdownLinks(filePaths, rootDir = process.cwd()) {
  /** @type {AdrViolation[]} */
  const violations = [];

  for (const filePath of filePaths) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
    const relPath = path.relative(rootDir, fullPath);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");

    let inFencedCodeBlock = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const rawLine = lines[lineNum];

      if (rawLine.trim().startsWith("```")) {
        inFencedCodeBlock = !inFencedCodeBlock;
        continue;
      }
      if (inFencedCodeBlock) continue;

      // Strip inline code blocks e.g. `[text](link)`
      const lineWithoutCode = rawLine.replace(/`[^`]+`/g, "");

      // Match markdown links [text](target) but not images ![alt](target)
      const linkRegex = /(?<!\!)\[([^\]]+)\]\(([^)]+)\)/g;

      let match;
      while (true) {
        match = linkRegex.exec(lineWithoutCode);
        if (match === null) break;
        const target = match[2].trim();

        // Ignore external URLs, mailto, or anchor-only links
        if (
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:") ||
          target.startsWith("#")
        ) {
          continue;
        }

        // Split anchor from file path
        const [targetPath, targetAnchor] = target.split("#");

        if (targetPath) {
          const resolvedTarget = path.resolve(path.dirname(fullPath), targetPath);
          if (!fs.existsSync(resolvedTarget)) {
            violations.push({
              rule: "LINK",
              file: relPath,
              line: lineNum + 1,
              message: `Broken relative link: "${target}" targets non-existent file "${path.relative(rootDir, resolvedTarget)}".`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Validate canonical terminology in glossary and docs
 * @param {string} glossaryPath - Path to glossary.md
 * @param {string[]} docFiles - List of document files to check
 * @param {string} rootDir - Root directory
 * @returns {AdrViolation[]}
 */
export function validateGlossaryTerms(glossaryPath, docFiles, rootDir = process.cwd()) {
  /** @type {AdrViolation[]} */
  const violations = [];
  const fullGlossary = path.isAbsolute(glossaryPath)
    ? glossaryPath
    : path.resolve(rootDir, glossaryPath);

  if (!fs.existsSync(fullGlossary)) {
    violations.push({
      rule: "GLOSSARY",
      file: path.relative(rootDir, fullGlossary),
      message: `Canonical glossary file missing at ${path.relative(rootDir, fullGlossary)}.`,
    });
    return violations;
  }

  const glossaryContent = fs.readFileSync(fullGlossary, "utf-8");

  for (const term of CANONICAL_TERMS) {
    // Check term is defined in glossary
    const termRegex = new RegExp(`###\\s+${term.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i");
    if (!termRegex.test(glossaryContent)) {
      violations.push({
        rule: "GLOSSARY",
        file: path.relative(rootDir, fullGlossary),
        message: `Canonical term "${term}" is not defined with a '### ${term}' heading in glossary.md.`,
      });
    }
  }

  return violations;
}

/**
 * Validate ADR metadata, sections, and statuses
 * @param {AdrMetadata[]} adrs
 * @returns {AdrViolation[]}
 */
export function validateAdrContent(adrs) {
  /** @type {AdrViolation[]} */
  const violations = [];

  for (const adr of adrs) {
    // 1. Status Check
    if (!adr.status) {
      violations.push({
        rule: "METADATA",
        file: adr.file,
        message: `Missing '**Status**:' declaration in header.`,
      });
    } else if (!VALID_STATUSES.includes(adr.status)) {
      violations.push({
        rule: "STATUS",
        file: adr.file,
        message: `Invalid status "${adr.status}". Must be one of: ${VALID_STATUSES.join(", ")}.`,
      });
    }

    // 2. Date Check
    if (!adr.date) {
      violations.push({
        rule: "METADATA",
        file: adr.file,
        message: `Missing '**Date**:' declaration (YYYY-MM-DD) in header.`,
      });
    }

    // 3. Title Check
    if (!adr.title) {
      violations.push({
        rule: "TITLE",
        file: adr.file,
        message: "Missing top-level H1 title (# ADR NNNN: ...).",
      });
    }

    // 4. Required Sections Check
    const hasContext = adr.sections.some((s) => /Context/i.test(s));
    const hasDecision = adr.sections.some((s) => /Decision/i.test(s));
    const hasConsequences = adr.sections.some((s) => /Consequences/i.test(s));

    if (!hasContext) {
      violations.push({
        rule: "SECTION",
        file: adr.file,
        message: `Missing required section '## Context and Problem Statement' (or '## Context').`,
      });
    }

    if (!hasDecision) {
      violations.push({
        rule: "SECTION",
        file: adr.file,
        message: `Missing required section '## Decision'.`,
      });
    }

    if (!hasConsequences) {
      violations.push({
        rule: "SECTION",
        file: adr.file,
        message: `Missing required section '## Consequences'.`,
      });
    }
  }

  return violations;
}

/**
 * Validate architecture directory files exist
 * @param {string} rootDir
 * @returns {AdrViolation[]}
 */
export function validateArchitectureDocs(rootDir = process.cwd()) {
  /** @type {AdrViolation[]} */
  const violations = [];
  const archDir = path.resolve(rootDir, "docs/architecture");

  if (!fs.existsSync(archDir)) {
    violations.push({
      rule: "STRUCTURE",
      file: "docs/architecture",
      message: "Architecture documentation directory missing: docs/architecture",
    });
    return violations;
  }

  for (const doc of REQUIRED_ARCHITECTURE_DOCS) {
    const docPath = path.resolve(archDir, doc);
    if (!fs.existsSync(docPath)) {
      violations.push({
        rule: "STRUCTURE",
        file: path.relative(rootDir, docPath),
        message: `Required architecture document missing: ${doc}`,
      });
    } else {
      const content = fs.readFileSync(docPath, "utf-8").trim();
      if (content.length < 50) {
        violations.push({
          rule: "CONTENT",
          file: path.relative(rootDir, docPath),
          message: `Architecture document "${doc}" is unexpectedly short or empty (${content.length} bytes).`,
        });
      }
    }
  }

  return violations;
}

/**
 * Main verification entrypoint
 * @param {string} [rootDir]
 * @returns {VerificationResult}
 */
export function verifyAdrs(rootDir = process.cwd()) {
  const adrDir = path.resolve(rootDir, "docs/adr");
  const archDir = path.resolve(rootDir, "docs/architecture");

  /** @type {AdrViolation[]} */
  const violations = [];

  if (!fs.existsSync(adrDir)) {
    return {
      valid: false,
      violations: [
        {
          rule: "STRUCTURE",
          file: "docs/adr",
          message: "ADR directory does not exist: docs/adr",
        },
      ],
      adrs: [],
      stats: { adrCount: 0, archDocCount: 0 },
    };
  }

  // Discover ADR files
  const adrFiles = fs
    .readdirSync(adrDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join("docs/adr", f));

  const parsedAdrs = adrFiles.map((f) => parseAdr(f, rootDir));

  // 1. Validate sequential numbering
  violations.push(...validateSequentialNumbering(parsedAdrs, rootDir));

  // 2. Validate ADR content & metadata
  violations.push(...validateAdrContent(parsedAdrs));

  // 3. Validate architecture docs
  violations.push(...validateArchitectureDocs(rootDir));

  // 4. Validate glossary terms
  const glossaryPath = path.resolve(archDir, "glossary.md");
  violations.push(...validateGlossaryTerms(glossaryPath, adrFiles, rootDir));

  // 5. Validate markdown links across all docs
  const archFiles = fs.existsSync(archDir)
    ? fs
        .readdirSync(archDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join("docs/architecture", f))
    : [];

  const allDocFiles = [...adrFiles, ...archFiles];
  violations.push(...validateMarkdownLinks(allDocFiles, rootDir));

  const valid = violations.length === 0;

  return {
    valid,
    violations,
    adrs: parsedAdrs,
    stats: {
      adrCount: parsedAdrs.length,
      archDocCount: archFiles.length,
      violationsCount: violations.length,
    },
  };
}

// CLI Execution
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  console.log("🔍 Verifying Architecture Decision Records (ADRs) and Documentation...\n");

  const result = verifyAdrs(process.cwd());

  console.log(
    `Discovered ${result.stats.adrCount} ADR(s) and ${result.stats.archDocCount} Architecture doc(s).`,
  );

  if (result.valid) {
    console.log(`\n✅ All ${result.stats.adrCount} ADRs and Architecture documents are valid!`);
    console.log("   - Strict sequential numbering verified (0001 -> ...)");
    console.log("   - Metadata, statuses, and required sections verified");
    console.log("   - Internal cross-links verified");
    console.log("   - Canonical glossary terminology verified\n");
    process.exit(0);
  } else {
    console.error(`\n❌ Found ${result.violations.length} ADR / Architecture violation(s):\n`);
    for (const v of result.violations) {
      const loc = v.line ? `${v.file}:${v.line}` : v.file;
      console.error(`  [${v.rule}] ${loc}`);
      console.error(`    ${v.message}\n`);
    }
    process.exit(1);
  }
}
