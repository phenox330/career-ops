#!/usr/bin/env node

/**
 * cv-quality-check.mjs — post-generation QA for tailored CVs (user-layer tool)
 *
 * Two checks:
 *   1. Keyword coverage — % of the report's "## Keywords extracted" list
 *      actually present in the generated CV text (the thing modes/pdf.md
 *      step 18 promises but nothing measured until now).
 *   2. Banned-list lint — scans the CV text for voice-dna.md §3A dead
 *      vocabulary and §3B/3C/3D/3E dead phrases (advisory, English-centric).
 *
 * Usage:
 *   node cv-quality-check.mjs --report 004 [--json]
 *   node cv-quality-check.mjs --html output/cv-x.html [--keywords "a, b, c"] [--json]
 *
 * With --report, the HTML path is resolved from data/pdf-index.tsv and the
 * keyword list from reports/{NNN}-*.md. Checks the HTML source text (exact
 * source of the PDF, modulo ATS normalization which is re-applied here).
 * If `pdftotext` is installed and a PDF is in the manifest, the coverage is
 * ALSO verified against the real PDF extraction (what an ATS sees).
 *
 * NOTE: this file is user-created and NOT part of upstream career-ops —
 * update-system.mjs does not manage or overwrite it.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const flag = (name) => args.includes(`--${name}`);

const reportNum = opt('report');
let htmlPath = opt('html');
let keywordsArg = opt('keywords');
const asJson = flag('json');

if (!reportNum && !htmlPath) {
  console.error('Usage: node cv-quality-check.mjs --report NNN [--json]');
  console.error('       node cv-quality-check.mjs --html <file> [--keywords "a, b, c"] [--json]');
  process.exit(1);
}

// ---------- resolve inputs from manifest + report ----------
const normKey = (s) => String(s || '').trim().replace(/^0+(?=\d)/, '');
let pdfPath = null;
let reportPath = null;

if (reportNum) {
  const manifest = resolve(__dirname, 'data', 'pdf-index.tsv');
  if (existsSync(manifest)) {
    for (const line of readFileSync(manifest, 'utf-8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const f = line.split('\t');
      if (normKey(f[0]) === normKey(reportNum)) {
        pdfPath = f[1] ? resolve(__dirname, f[1]) : null;
        if (!htmlPath && f[2]) htmlPath = resolve(__dirname, f[2]);
      }
    }
  }
  const reportsDir = resolve(__dirname, 'reports');
  if (existsSync(reportsDir)) {
    const padded = String(normKey(reportNum)).padStart(3, '0');
    const hit = readdirSync(reportsDir).find((f) => f.startsWith(`${padded}-`) && f.endsWith('.md'));
    if (hit) reportPath = resolve(reportsDir, hit);
  }
  if (!reportPath) {
    console.error(`No report found in reports/ for number ${reportNum}`);
    process.exit(1);
  }
  if (!htmlPath || !existsSync(htmlPath)) {
    console.error(`No HTML found for report ${reportNum} (manifest: data/pdf-index.tsv). Pass --html explicitly.`);
    process.exit(1);
  }
}

// ---------- text extraction ----------
const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalize = (s) =>
  stripDiacritics(String(s).toLowerCase())
    .replace(/[—–]/g, '-')
    .replace(/[“”‘’]/g, "'")
    .replace(/[^a-z0-9ñç'&+./-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function htmlToText(html) {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ');
}

const htmlRaw = readFileSync(htmlPath, 'utf-8');
const htmlText = normalize(htmlToText(htmlRaw));

let pdfText = null;
if (pdfPath && existsSync(pdfPath)) {
  try {
    pdfText = normalize(execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf-8' }));
  } catch {
    pdfText = null; // pdftotext not installed or failed — HTML check still stands
  }
}

// ---------- 1. keyword coverage ----------
let keywords = [];
if (keywordsArg) {
  keywords = keywordsArg.split(',').map((k) => k.trim()).filter(Boolean);
} else if (reportPath) {
  const report = readFileSync(reportPath, 'utf-8');
  const m = report.match(/^## (?:Keywords extracted|Mots-clés extraits)\s*\n+([\s\S]*?)(?=\n## |\n---|$)/m);
  if (m) {
    keywords = m[1]
      .split('\n')[0] // first paragraph line is the comma list
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k && !k.startsWith('['));
  }
}

const coverage = keywords.map((kw) => {
  const needle = normalize(kw);
  return {
    keyword: kw,
    inHtml: needle.length > 0 && htmlText.includes(needle),
    inPdf: pdfText === null ? null : needle.length > 0 && pdfText.includes(needle),
  };
});
const covered = coverage.filter((c) => c.inHtml);
const coveragePct = keywords.length ? Math.round((covered.length / keywords.length) * 100) : null;

// ---------- 2. banned-list lint (voice-dna.md) ----------
let bannedWords = [];
let bannedPhrases = [];
const voicePath = resolve(__dirname, 'voice-dna.md');
if (existsSync(voicePath)) {
  const voice = readFileSync(voicePath, 'utf-8');
  const wordsSection = voice.match(/### 3A[\s\S]*?\n\n([\s\S]*?)\n\nAlso banned/);
  if (wordsSection) {
    bannedWords = wordsSection[1]
      .split(',')
      .map((w) => w.replace(/\([^)]*\)/g, '').trim().toLowerCase())
      .flatMap((w) => w.split('/'))
      .map((w) => w.trim())
      .filter((w) => w && /^[a-z][a-z -]*$/.test(w));
  }
  const phraseSections = voice.match(/### 3[B-E][\s\S]*?(?=### 3[C-F]|## 4)/g) || [];
  for (const section of phraseSections) {
    for (const q of section.matchAll(/"([^"\n]{4,60})"/g)) {
      const p = q[1].toLowerCase();
      if (!p.includes('[') && !p.includes('...')) bannedPhrases.push(p);
    }
  }
}
// Fallback minimal list (from modes/_shared.md) if voice-dna.md is absent
if (bannedWords.length === 0) {
  bannedWords = ['leveraged', 'spearheaded', 'synergies', 'seamless', 'cutting-edge', 'passionate about', 'results-oriented', 'proven track record'];
}

const wordHit = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
const violations = [
  ...bannedWords.filter((w) => wordHit(w).test(htmlText)).map((w) => ({ type: 'word', term: w })),
  ...bannedPhrases.filter((p) => htmlText.includes(normalize(p))).map((p) => ({ type: 'phrase', term: p })),
];

// ---------- output ----------
const result = {
  html: htmlPath,
  pdf: pdfPath,
  pdfVerified: pdfText !== null,
  report: reportPath,
  keywordCount: keywords.length,
  coveragePct,
  missing: coverage.filter((c) => !c.inHtml).map((c) => c.keyword),
  pdfMismatches: coverage.filter((c) => c.inHtml && c.inPdf === false).map((c) => c.keyword),
  bannedListSize: bannedWords.length + bannedPhrases.length,
  violations,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`CV quality check — ${htmlPath}`);
  if (keywords.length) {
    console.log(`\nKeyword coverage: ${coveragePct}% (${covered.length}/${keywords.length})${pdfText !== null ? ' — verified in PDF extraction too' : ' — HTML only (pdftotext unavailable)'}`);
    if (result.missing.length) console.log(`Missing: ${result.missing.join(', ')}`);
    if (result.pdfMismatches.length) console.log(`⚠️ In HTML but NOT in PDF extraction: ${result.pdfMismatches.join(', ')}`);
  } else {
    console.log('\nNo keywords found (no "## Keywords extracted" section and no --keywords).');
  }
  console.log(`\nBanned-list lint (${result.bannedListSize} terms from voice-dna.md): ${violations.length === 0 ? 'clean ✅' : ''}`);
  for (const v of violations) console.log(`  ⚠️ ${v.type}: "${v.term}"`);
}

process.exit(0);
