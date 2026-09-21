import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const csvPath = path.join(root, "test", "test_cases.csv");
const outerRootIndex = process.argv.indexOf("--outer-root");
if (outerRootIndex >= 0) {
  const value = process.argv[outerRootIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("INCOMPLETE\tCSV\t--outer-root requires a path");
    process.exit(1);
  }
  process.env.TOKENS_OUTER_ROOT = path.resolve(value);
}
const hostNodeIndex = process.argv.indexOf("--host-node");
if (hostNodeIndex >= 0) {
  const value = process.argv[hostNodeIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("INCOMPLETE\tCSV\t--host-node requires a path");
    process.exit(1);
  }
  process.env.TOKENS_HOST_NODE = path.resolve(value);
}
const columns = [
  "用例编号", "所属模块", "用例标题", "前置条件", "测试数据",
  "操作步骤", "预期结果", "优先级", "自动化状态", "对应测试",
];
const allowedStatuses = new Set(["已自动化", "部分自动化", "待自动化", "人工验收"]);

function parseCsv(input) {
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(source, name) {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function normalizeTestPath(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function parseJunit(xml, fallbackFile) {
  const results = new Map();
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const name = attribute(match[1], "name");
    const file = attribute(match[1], "file") ?? fallbackFile;
    if (!name || !file) continue;
    const body = match[2] ?? "";
    let status = "passed";
    let reason = "";
    if (/<failure\b|<error\b/.test(body)) {
      status = "failed";
      reason = decodeXml(body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
    } else if (/<skipped\b/.test(body)) {
      status = "incomplete";
      reason = "mapped test was skipped";
    }
    results.set(`${normalizeTestPath(file)} :: ${name}`, { status, reason });
  }
  return results;
}

function fail(message) {
  console.error(`INCOMPLETE\tCSV\t${message}`);
  process.exitCode = 1;
}

const parsed = parseCsv(await readFile(csvPath, "utf8"));
if (parsed.length === 0 || parsed[0].length !== columns.length || !columns.every((name, index) => parsed[0][index] === name)) {
  fail(`expected exact ${columns.length}-column header`);
  process.exit();
}

const cases = [];
const ids = new Set();
for (const [index, values] of parsed.slice(1).entries()) {
  const line = index + 2;
  if (values.length !== columns.length) {
    fail(`row ${line} has ${values.length} columns, expected ${columns.length}`);
    continue;
  }
  const entry = Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]]));
  if (!entry.用例编号 || ids.has(entry.用例编号)) {
    fail(`row ${line} has a missing or duplicate case ID: ${entry.用例编号}`);
    continue;
  }
  ids.add(entry.用例编号);
  if (!allowedStatuses.has(entry.自动化状态)) {
    fail(`${entry.用例编号} has invalid automation status: ${entry.自动化状态}`);
  }
  cases.push(entry);
}
if (process.exitCode) process.exit();

const testFiles = (await readdir(path.join(root, "test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(root, "test", name));
const testResults = new Map();
const executionIssues = [];
for (const file of testFiles) {
  const execution = spawnSync(process.execPath, ["--test", "--test-reporter=junit", file], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const [key, value] of parseJunit(execution.stdout ?? "", file)) testResults.set(key, value);
  if (execution.error) {
    executionIssues.push(execution.error.message);
  } else if (execution.status !== 0 && !/<failure\b|<error\b/.test(execution.stdout ?? "")) {
    executionIssues.push(`${normalizeTestPath(file)} exited ${execution.status}: ${(execution.stderr ?? "").trim().slice(0, 300)}`);
  }
}
const failures = [];

for (const entry of cases) {
  const mappings = entry.对应测试.split(" | ").map((value) => value.trim()).filter(Boolean);
  if (entry.自动化状态 !== "已自动化") {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: `automation status is ${entry.自动化状态}` });
    continue;
  }
  if (mappings.length === 0) {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: "no mapped test" });
    continue;
  }
  const mappedResults = mappings.map((mapping) => ({ mapping, result: testResults.get(mapping) }));
  const missing = mappedResults.find(({ result }) => result === undefined);
  if (missing) {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: `mapped test not found: ${missing.mapping}` });
    continue;
  }
  const failed = mappedResults.find(({ result }) => result.status !== "passed");
  if (failed) {
    failures.push({
      id: entry.用例编号,
      status: failed.result.status === "failed" ? "FAIL" : "INCOMPLETE",
      reason: `${failed.mapping}: ${failed.result.reason || failed.result.status}`,
    });
  }
}

for (const issue of executionIssues) {
  failures.push({ id: "TEST-RUNNER", status: "INCOMPLETE", reason: issue });
}

if (failures.length === 0) {
  console.log(`All ${cases.length} cases passed.`);
} else {
  for (const failure of failures) {
    console.error(`${failure.status}\t${failure.id}\t${failure.reason}`);
  }
  process.exitCode = 1;
}
