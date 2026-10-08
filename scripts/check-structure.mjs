import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Enforce headless dependency direction and catch broken source/document paths.
const root = process.cwd();
const owners = {
  shared: [],
  engine: ['shared'],
  media: ['shared', 'engine'],
  service: ['shared', 'engine', 'media'],
  mcp: ['shared', 'engine', 'media', 'service'],
  gui: ['shared', 'engine', 'media', 'service', 'mcp'],
};
const guide = fs.readFileSync('FOLDER-STRUCTURE.md', 'utf8');
const documentedFolders = new Set();
for (const block of guide.matchAll(/```text\n([\s\S]*?)```/g)) {
  const lines = block[1].trimEnd().split('\n');
  if (!lines[0].startsWith('packages/')) continue;
  const stack = [lines[0].replace(/\/$/, '')];
  documentedFolders.add(stack[0]);
  for (const line of lines.slice(1)) {
    const match = line.match(/^( +)(\S+)/);
    if (!match) continue;
    const level = match[1].length / 2;
    stack[level] = `${stack[level - 1]}/${match[2].replace(/\/$/, '')}`;
    if (match[2].endsWith('/')) documentedFolders.add(stack[level]);
    else documentedFolders.add(path.posix.dirname(stack[level]));
  }
}
const files = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
  if (['node_modules', 'dist'].includes(item.name)) return [];
  const filename = path.join(directory, item.name);
  return item.isDirectory() ? files(filename) : [filename];
});
const dependencies = new Map();
let sourceCount = 0, linkCount = 0;

for (const [owner, permitted] of Object.entries(owners)) {
  assert(guide.includes(`packages/${owner}/`), `Document ${owner} in FOLDER-STRUCTURE.md`);
  const directory = `packages/${owner}`;
  const manifest = JSON.parse(fs.readFileSync(`${directory}/package.json`, 'utf8'));
  assert.equal(manifest.name, `@freemier/${owner}`);
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const local = Object.keys(declared).filter((name) => name.startsWith('@freemier/')).map((name) => name.slice(10));
  for (const dependency of local) assert(permitted.includes(dependency), `${owner} must not depend on ${dependency}`);
  dependencies.set(owner, local);
  const sources = [...files(`${directory}/src`), ...(owner === 'gui' ? files(`${directory}/desktop`) : [])];
  for (const filename of sources.filter((file) => /\.(ts|js|mjs|cjs)$/.test(file))) {
    assert(documentedFolders.has(path.dirname(filename).replaceAll('\\', '/')), `${filename}: update its folder in FOLDER-STRUCTURE.md`);
    sourceCount++;
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    function checkSpecifier(specifier) {
      if (specifier.startsWith('@freemier/')) {
        const name = specifier.split('/').slice(0, 2).join('/');
        assert(declared[name], `${filename}: declare ${name} in package.json`);
        assert(permitted.includes(name.slice(10)), `${filename}: invalid dependency ${name}`);
      }
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), specifier);
        assert([target, target.replace(/\.js$/, '.ts')].some((file) => fs.existsSync(file)), `${filename}: missing ${specifier}`);
        assert(target.startsWith(path.resolve(directory) + path.sep), `${filename}: use a package export for cross-package imports`);
      }
      if (owner !== 'gui') assert(specifier !== 'electron', `${filename}: Electron belongs in GUI`);
      if (['shared', 'engine', 'media', 'service'].includes(owner)) assert(!specifier.startsWith('@modelcontextprotocol/'), `${filename}: MCP transport belongs in MCP`);
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkSpecifier(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) checkSpecifier(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
function checkCycle(owner, stack = []) {
  assert(!stack.includes(owner), `Dependency cycle: ${[...stack, owner].join(' -> ')}`);
  for (const dependency of dependencies.get(owner)) checkCycle(dependency, [...stack, owner]);
}
for (const owner of dependencies.keys()) checkCycle(owner);

const docs = ['README.md', 'AGENTS.md', 'ROADMAP.md', 'FOLDER-STRUCTURE.md', ...files('docs').filter((file) => /(?:STATUS|CODE-GUIDE|PRESETS|PROJECT-FORMAT|RELEASE-READINESS)\.md$/.test(file)), ...files('assets').filter((file) => file.endsWith('.md')), ...Object.keys(owners).flatMap((owner) => files(`packages/${owner}/src`).filter((file) => file.endsWith('.md')))];
for (const filename of docs) {
  const contents = fs.readFileSync(filename, 'utf8');
  for (const match of contents.matchAll(/\]\(([^)\s]+)\)/g)) {
    const url = match[1];
    if (/^(?:https?:|mailto:|#)/.test(url)) continue;
    const target = path.resolve(path.dirname(filename), decodeURIComponent(url.split('#')[0]));
    assert(fs.existsSync(target), `${filename}: broken link ${url}`);
    linkCount++;
  }
}
console.log(`PASS: six package boundaries, no dependency cycles, ${sourceCount} source files and ${linkCount} local documentation links.`);
