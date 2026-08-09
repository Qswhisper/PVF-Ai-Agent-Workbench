"use strict";

const fs = require("fs");
const path = require("path");
const { readJson, timestamp, writeJson } = require("../lib/release-utils");
const { runtimePath } = require("../lib/runtime-state");

const rawArgs = process.argv.slice(2);
const rootIndex = rawArgs.indexOf("--root");
const workbenchRoot = rootIndex >= 0 ? path.resolve(rawArgs[rootIndex + 1]) : path.resolve(__dirname, "../../..");
const args = rawArgs.filter((item, index) => item !== "--root" && rawArgs[index - 1] !== "--root");
const command = args[0] || "list";
const suitePath = path.join(workbenchRoot, "evals", "agent", "suite.json");

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function matches(text, pattern) {
  return new RegExp(pattern, "is").test(text);
}

function firstMatch(text, patterns) {
  let found = null;
  for (const pattern of patterns || []) {
    const match = new RegExp(pattern, "is").exec(text);
    if (match && (!found || match.index < found.index)) {
      found = { pattern, index: match.index, text: match[0] };
    }
  }
  return found;
}

function evaluateBeginnerPresentation(testCase, response) {
  const rule = testCase.beginnerPresentation;
  if (!rule) return { enabled: false, ok: true, checks: [] };

  const leadMaxChars = Number.isInteger(rule.leadMaxChars) && rule.leadMaxChars > 0 ? rule.leadMaxChars : 220;
  const paragraphBreak = response.search(/\r?\n\s*\r?\n/);
  const leadEnd = paragraphBreak >= 0 ? Math.min(paragraphBreak, leadMaxChars) : leadMaxChars;
  const lead = response.slice(0, leadEnd);
  const leadJargonHits = (rule.leadForbiddenPatterns || [])
    .map((pattern) => ({ pattern, matched: firstMatch(lead, [pattern]) }))
    .filter((item) => item.matched);
  const checks = [
    {
      id: "plain-language-lead",
      ok: leadJargonHits.length === 0,
      leadMaxChars,
      hits: leadJargonHits,
    },
  ];

  if (rule.requireHeadingBeforeTechnicalTerms === true) {
    const firstTechnicalTerm = firstMatch(response, rule.technicalTermPatterns || []);
    const firstDetailsHeading = firstMatch(response, rule.technicalDetailsHeadingPatterns || []);
    checks.push({
      id: "technical-details-progressive-disclosure",
      ok:
        firstTechnicalTerm === null ||
        (firstDetailsHeading !== null && firstDetailsHeading.index < firstTechnicalTerm.index),
      firstTechnicalTerm,
      firstDetailsHeading,
    });
  }

  return {
    enabled: true,
    ok: checks.every((check) => check.ok),
    lead,
    checks,
  };
}

function evaluateResponses(suite, responsesDir) {
  const cases = [];
  for (const testCase of suite.cases) {
    const responsePath = path.join(responsesDir, testCase.responseFile);
    const response = fs.existsSync(responsePath) ? fs.readFileSync(responsePath, "utf8") : "";
    const required = (testCase.requiredGroups || []).map((group) => {
      const matchedPattern = (group.patterns || []).find((pattern) => matches(response, pattern)) || null;
      const allPatterns = group.allPatterns || [];
      const matchedAllPatterns = allPatterns.length > 0 && allPatterns.every((pattern) => matches(response, pattern));
      return {
        id: group.id,
        ok: Boolean(matchedPattern) || matchedAllPatterns,
        matchedPattern,
        matchedAllPatterns: matchedAllPatterns ? allPatterns : [],
      };
    });
    const forbidden = (testCase.forbiddenPatterns || []).map((pattern) => ({
      pattern,
      matched: matches(response, pattern),
    }));
    const requiredPassed = required.filter((item) => item.ok).length;
    const requiredTotal = required.length;
    const forbiddenHits = forbidden.filter((item) => item.matched).length;
    const presentation = evaluateBeginnerPresentation(testCase, response);
    const presentationPassed = presentation.checks.filter((item) => item.ok).length;
    const presentationTotal = presentation.checks.length;
    const scoredPassed = requiredPassed + presentationPassed;
    const scoredTotal = requiredTotal + presentationTotal;
    const score = scoredTotal === 0 ? 1 : scoredPassed / scoredTotal;
    const ok = response.length > 0 && score === 1 && forbiddenHits === 0 && presentation.ok;
    cases.push({
      id: testCase.id,
      title: testCase.title,
      responsePath,
      responsePresent: response.length > 0,
      score,
      ok,
      required,
      presentation,
      forbiddenHits: forbidden.filter((item) => item.matched),
    });
  }
  const averageScore = cases.length === 0 ? 0 : cases.reduce((sum, item) => sum + item.score, 0) / cases.length;
  return {
    suiteId: suite.suiteId,
    suiteVersion: suite.version,
    responsesDir,
    summary: {
      ok: cases.every((item) => item.ok) && averageScore >= suite.minimumAverageScore,
      caseCount: cases.length,
      passedCases: cases.filter((item) => item.ok).length,
      failedCases: cases.filter((item) => !item.ok).length,
      averageScore,
      minimumAverageScore: suite.minimumAverageScore,
    },
    cases,
  };
}

function checkRun(suite, responsesDir, outRoot) {
  const evaluation = evaluateResponses(suite, responsesDir);
  const reportPath = path.join(outRoot, "AGENT-EVAL-REPORT.json");
  const report = {
    schemaVersion: "1.0",
    phase: "agent-eval",
    generatedAt: new Date().toISOString(),
    reportPath,
    ...evaluation,
  };
  writeJson(reportPath, report);
  return report;
}

function scaffold(suite, outRoot) {
  const responsesDir = path.join(outRoot, "responses");
  fs.mkdirSync(responsesDir, { recursive: true });
  const promptLines = ["# PVF Agent Eval Prompts", ""];
  for (const testCase of suite.cases) {
    promptLines.push(`## ${testCase.id}`, "", testCase.prompt, "", `回答文件：\`${testCase.responseFile}\``, "");
    const responsePath = path.join(responsesDir, testCase.responseFile);
    if (!fs.existsSync(responsePath)) fs.writeFileSync(responsePath, "", "utf8");
  }
  fs.writeFileSync(path.join(outRoot, "PROMPTS.md"), `${promptLines.join("\n")}\n`, "utf8");
  return { ok: true, outRoot, responsesDir, caseCount: suite.cases.length };
}

function main() {
  const suite = readJson(suitePath);
  if (command === "list") {
    process.stdout.write(`${JSON.stringify({ suiteId: suite.suiteId, version: suite.version, cases: suite.cases.map(({ id, title, prompt, responseFile }) => ({ id, title, prompt, responseFile })) }, null, 2)}\n`);
    return;
  }
  if (command === "scaffold") {
    const outRoot = path.resolve(option("--out", runtimePath(workbenchRoot, "agent-eval-runs", timestamp(), "scaffold")));
    process.stdout.write(`${JSON.stringify(scaffold(suite, outRoot), null, 2)}\n`);
    return;
  }
  if (command === "check") {
    const responses = option("--responses");
    if (!responses) throw new Error("check requires --responses <dir>.");
    const responsesDir = path.resolve(responses);
    const outRoot = path.resolve(option("--out", runtimePath(workbenchRoot, "agent-eval-runs", timestamp(), "check")));
    const report = checkRun(suite, responsesDir, outRoot);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.ok) process.exitCode = 1;
    return;
  }
  if (command === "self-test") {
    const outRoot = path.resolve(option("--out", runtimePath(workbenchRoot, "agent-eval-runs", timestamp(), "self-test")));
    const pass = checkRun(suite, path.join(workbenchRoot, "evals", "agent", "fixtures", "pass"), path.join(outRoot, "pass"));
    const fail = checkRun(suite, path.join(workbenchRoot, "evals", "agent", "fixtures", "fail"), path.join(outRoot, "fail"));
    const unorderedRoot = path.join(outRoot, "unordered-all-patterns");
    const unorderedResponses = path.join(unorderedRoot, "responses");
    fs.mkdirSync(unorderedResponses, { recursive: true });
    fs.writeFileSync(
      path.join(unorderedResponses, "unordered.md"),
      "approval code is retained; the manifest is bound after dry-run.\n",
      "utf8",
    );
    const unordered = evaluateResponses(
      {
        suiteId: "agent-eval-all-patterns-self-test",
        version: "1.0",
        minimumAverageScore: 1,
        cases: [
          {
            id: "unordered-all-patterns",
            title: "allPatterns order independence",
            responseFile: "unordered.md",
            requiredGroups: [
              {
                id: "binding",
                patterns: ["never-match"],
                allPatterns: ["dry.?run", "manifest", "approval code", "bound"],
              },
            ],
            forbiddenPatterns: [],
          },
        ],
      },
      unorderedResponses,
    );
    const beginnerRoot = path.join(outRoot, "beginner-presentation");
    const beginnerResponses = path.join(beginnerRoot, "responses");
    fs.mkdirSync(beginnerResponses, { recursive: true });
    const beginnerRule = {
      leadMaxChars: 80,
      leadForbiddenPatterns: ["dry.?run", "ASCII", "manifest"],
      technicalTermPatterns: ["dry.?run", "ASCII", "manifest"],
      technicalDetailsHeadingPatterns: ["技术详情"],
      requireHeadingBeforeTechnicalTerms: true,
    };
    const beginnerSuite = {
      suiteId: "agent-eval-beginner-presentation-self-test",
      version: "1.0",
      minimumAverageScore: 1,
      cases: [
        {
          id: "beginner-presentation",
          title: "beginner progressive disclosure",
          responseFile: "beginner.md",
          requiredGroups: [{ id: "plain-result", patterns: ["可以安全修改"] }],
          forbiddenPatterns: [],
          beginnerPresentation: beginnerRule,
        },
      ],
    };
    fs.writeFileSync(
      path.join(beginnerResponses, "beginner.md"),
      "可以安全修改。工作台会先检查，再生成独立文件。\n\n技术详情：内部会执行 dry-run 并保存 manifest。\n",
      "utf8",
    );
    const beginnerAccepted = evaluateResponses(beginnerSuite, beginnerResponses);
    fs.writeFileSync(
      path.join(beginnerResponses, "beginner.md"),
      "dry-run 和 manifest 都通过，所以可以安全修改。\n",
      "utf8",
    );
    const beginnerRejected = evaluateResponses(beginnerSuite, beginnerResponses);
    const report = {
      schemaVersion: "1.0",
      phase: "agent-eval-self-test",
      generatedAt: new Date().toISOString(),
      reportPath: path.join(outRoot, "AGENT-EVAL-SELF-TEST.json"),
      summary: {
        ok:
          pass.summary.ok === true &&
          fail.summary.ok === false &&
          unordered.summary.ok === true &&
          beginnerAccepted.summary.ok === true &&
          beginnerRejected.summary.ok === false,
        passFixtureAccepted: pass.summary.ok,
        failFixtureRejected: !fail.summary.ok,
        unorderedAllPatternsAccepted: unordered.summary.ok,
        beginnerProgressiveDisclosureAccepted: beginnerAccepted.summary.ok,
        beginnerJargonLeadRejected: !beginnerRejected.summary.ok,
      },
      passReportPath: pass.reportPath,
      failReportPath: fail.reportPath,
    };
    writeJson(report.reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: workbench.bat eval <list|scaffold|check|self-test>");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
