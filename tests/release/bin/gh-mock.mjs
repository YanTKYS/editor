#!/usr/bin/env node
// テスト用の gh CLI のモック。publish.sh が使う `gh api` の呼び出しだけを、
// MOCK_GH_STATE の JSON ファイルを GitHub の状態とみなして再現する。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const statePath = process.env.MOCK_GH_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf-8'));
state.tags ??= {};
state.annotated ??= {};
state.releases ??= [];
state.nextId ??= 100;
state.calls ??= [];

const args = process.argv.slice(2);
if (args[0] !== 'api') fail(`未対応のコマンド: ${args.join(' ')}`);
let method = 'GET';
let path = '';
let input = null;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '-X') method = args[++i];
  else if (a === '-f' || a === '-F') {
    const [k, ...rest] = args[++i].split('=');
    let v = rest.join('=');
    if (a === '-F' && v.startsWith('@')) v = readFileSync(v.slice(1), 'utf-8');
    else if (a === '-F' && (v === 'true' || v === 'false')) v = v === 'true';
    fields[k] = v;
  } else if (a === '-H') i++;
  else if (a === '--input') input = readFileSync(args[++i]);
  else if (a === '--paginate') continue;
  else path = a;
}
const repo = process.env.GITHUB_REPOSITORY;
path = path.replace('https://uploads.github.com/', '').replace(`repos/${repo}/`, '');
const [route, query = ''] = path.split('?');
const params = new URLSearchParams(query);
state.calls.push(`${method} ${route}${params.get('name') ? `?name=${params.get('name')}` : ''}`);

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
function out(obj) {
  save();
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function fail(msg, code = 1) {
  if (statePath) save();
  process.stderr.write(`gh: ${msg}\n`);
  process.exit(code);
}
function findRelease(id) {
  return state.releases.find((r) => r.id === Number(id)) ?? fail('Not Found (HTTP 404)');
}
const failOn = (process.env.MOCK_FAIL ?? '').split(',');

let m;
if (method === 'GET' && (m = route.match(/^git\/ref\/tags\/(.+)$/))) {
  const tag = m[1];
  if (state.annotated[tag]) out({ object: { type: 'tag', sha: state.annotated[tag].tagObject } });
  if (!state.tags[tag]) fail('Not Found (HTTP 404)');
  out({ object: { type: 'commit', sha: state.tags[tag] } });
} else if (method === 'GET' && (m = route.match(/^git\/tags\/(.+)$/))) {
  const entry = Object.values(state.annotated).find((a) => a.tagObject === m[1]) ?? fail('Not Found (HTTP 404)');
  out({ object: { type: 'commit', sha: entry.commit } });
} else if (method === 'POST' && route === 'git/refs') {
  const tag = fields.ref.replace('refs/tags/', '');
  if (state.tags[tag] || state.annotated[tag]) fail('Reference already exists (HTTP 422)');
  state.tags[tag] = fields.sha;
  out({ ref: fields.ref });
} else if (method === 'GET' && route === 'releases') {
  out(state.releases.map(({ assets, ...r }) => r));
} else if (method === 'POST' && route === 'releases') {
  if (failOn.includes('create')) fail('Server Error (HTTP 500)');
  const r = { id: state.nextId++, tag_name: fields.tag_name, name: fields.name, body: fields.body, draft: fields.draft === true, assets: [] };
  state.releases.push(r);
  out(r);
} else if (method === 'POST' && (m = route.match(/^releases\/(\d+)\/assets$/))) {
  if (failOn.includes('upload')) fail('upload failed (HTTP 502)');
  const r = findRelease(m[1]);
  const name = params.get('name');
  if (r.assets.some((a) => a.name === name)) fail('already_exists (HTTP 422)');
  const asset = { id: state.nextId++, name, sha256: createHash('sha256').update(input).digest('hex') };
  r.assets.push(asset);
  out(asset);
} else if (method === 'GET' && (m = route.match(/^releases\/(\d+)\/assets$/))) {
  out(findRelease(m[1]).assets);
} else if (method === 'DELETE' && (m = route.match(/^releases\/assets\/(\d+)$/))) {
  if (failOn.includes('delete')) fail('Server Error (HTTP 500)');
  for (const r of state.releases) r.assets = r.assets.filter((a) => a.id !== Number(m[1]));
  out({});
} else if (method === 'PATCH' && (m = route.match(/^releases\/assets\/(\d+)$/))) {
  const r = state.releases.find((x) => x.assets.some((a) => a.id === Number(m[1])));
  // rename: すべての名前変更を失敗させる / rename-from:X: 現在の名前に X を含む資産の名前変更を失敗させる
  const current = r.assets.find((a) => a.id === Number(m[1])).name;
  const renameFails = failOn.some((f) => f === 'rename' || (f.startsWith('rename-from:') && current.includes(f.slice(12))));
  if (renameFails) fail('Server Error (HTTP 500)');
  if (r.assets.some((a) => a.name === fields.name && a.id !== Number(m[1]))) fail('already_exists (HTTP 422)');
  r.assets.find((a) => a.id === Number(m[1])).name = fields.name;
  out({});
} else if (method === 'PATCH' && (m = route.match(/^releases\/(\d+)$/))) {
  if (failOn.includes('edit')) fail('Server Error (HTTP 500)');
  const r = findRelease(m[1]);
  Object.assign(r, { name: fields.name, body: fields.body, draft: fields.draft === true });
  out(r);
} else if (method === 'GET' && (m = route.match(/^releases\/(\d+)$/))) {
  out({ html_url: `https://github.com/${repo}/releases/tag/${findRelease(m[1]).tag_name}` });
} else {
  fail(`未対応の API: ${method} ${route}`);
}
