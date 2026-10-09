// Storage tests against a real (in-memory) MongoDB: node test/store.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const S = require('../store');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'owlstore-'));
const bigState = () => {
  const users = {}, posts = [];
  for (let i = 0; i < 200; i++) users['u' + i] = { id: 'u' + i, handle: 'user' + i, name: 'User ' + i, followers: i, bio: 'x'.repeat(60) };
  for (let i = 0; i < 3000; i++) posts.push({ id: 'p' + i, authorId: 'u' + (i % 200), text: 'post number ' + i + ' ' + 'lorem ipsum '.repeat(10), ts: i, likedBy: ['u1', 'u2'], mentions: [] });
  return { users, posts, dms: { 'a~b': { id: 'a~b', msgs: [{ id: 'm1', text: 'hello ✨ 🦉' }] } }, botRel: { 'a|b': { score: 3, mem: [] } }, news: [], rumours: [] };
};

let mongod, uri;
t('file store: save/load/uploads behave like before (atomic state.json + uploads folder)', async () => {
  const dir = tmp(), st = S.createStore({ dir });
  assert.strictEqual(st.kind, 'file');
  assert.strictEqual(await st.load(), null);
  await st.save(JSON.stringify({ users: { a: 1 }, posts: [] }));
  assert.deepStrictEqual(await st.load(), { users: { a: 1 }, posts: [] });
  assert.ok(fs.existsSync(path.join(dir, 'state.json')) && !fs.existsSync(path.join(dir, 'state.json.tmp')));
  await st.saveUpload('p_1-avatar-x.webp', Buffer.from('RIFFxxxxWEBPdata'));
  const r = await st.readUpload('p_1-avatar-x.webp');
  assert.strictEqual(r.mime, 'image/webp'); assert.strictEqual(r.buf.toString(), 'RIFFxxxxWEBPdata');
  assert.strictEqual(await st.readUpload('../state.json'), null, 'path traversal is refused');
  await st.deleteUpload('p_1-avatar-x.webp'); await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(await st.readUpload('p_1-avatar-x.webp'), null);
});

t('mongo store: empty database loads null, then a full state round-trips exactly (unicode included)', async () => {
  const st = S.createStore({ uri: uri + 'owlround' });
  await st.init();
  assert.strictEqual(st.kind, 'mongo'); assert.match(st.describe, /owlround/);
  assert.strictEqual(await st.load(), null);
  const state = bigState();
  await st.save(JSON.stringify(state));
  assert.deepStrictEqual(await st.load(), state);
  await st.close();
  const again = S.createStore({ uri: uri + 'owlround' }); await again.init();
  assert.deepStrictEqual(await again.load(), state, 'a new connection (a restart) sees everything');
  await again.close();
});

t('mongo store: repeated saves replace the single state document', async () => {
  const st = S.createStore({ uri: uri + 'owlreplace' }); await st.init();
  for (let i = 0; i < 5; i++) await st.save(JSON.stringify({ users: {}, posts: [], n: i }));
  assert.strictEqual((await st.load()).n, 4);
  await st.close();
  const { MongoClient } = require('mongodb'); const c = await MongoClient.connect(uri);
  assert.strictEqual(await c.db('owlreplace').collection('state').countDocuments(), 1);
  await c.close();
});

t('mongo store: the state is stored compressed, well under the 16MB document limit', async () => {
  const st = S.createStore({ uri: uri + 'owlsize' }); await st.init();
  const json = JSON.stringify(bigState()); await st.save(json);
  const { MongoClient } = require('mongodb'); const c = await MongoClient.connect(uri);
  const doc = await c.db('owlsize').collection('state').findOne({ _id: 'state' });
  console.log(`   ${json.length} bytes of JSON -> ${doc.gz.buffer.length} bytes stored`);
  assert.ok(doc.gz.buffer.length < json.length / 4);
  await c.close(); await st.close();
});

t('mongo store: uploads live in GridFS, replace cleanly, and read back byte for byte', async () => {
  const st = S.createStore({ uri: uri + 'owlup' }); await st.init();
  const img = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(Array.from({ length: 400000 }, (_, i) => i % 251))]); // > one GridFS chunk
  await st.saveUpload('p_1-avatar-abc.webp', img);
  const r = await st.readUpload('p_1-avatar-abc.webp');
  assert.ok(r.buf.equals(img)); assert.strictEqual(r.mime, 'image/webp');
  await st.saveUpload('p_1-avatar-abc.webp', Buffer.from('second version'));
  assert.strictEqual((await st.readUpload('p_1-avatar-abc.webp')).buf.toString(), 'second version');
  assert.strictEqual(await st.readUpload('nope.webp'), null);
  assert.strictEqual(await st.readUpload('../x'), null);
  await st.deleteUpload('p_1-avatar-abc.webp');
  assert.strictEqual(await st.readUpload('p_1-avatar-abc.webp'), null);
  const { MongoClient } = require('mongodb'); const c = await MongoClient.connect(uri);
  assert.strictEqual(await c.db('owlup').collection('uploads.files').countDocuments(), 0, 'deleting removes the GridFS file');
  await c.close(); await st.close();
});

t('database name comes from the URI path, then MONGODB_DB, then "owlfeed"', () => {
  assert.strictEqual(S.dbNameFromUri('mongodb+srv://u:p@cluster0.abc.mongodb.net/mygame?retryWrites=true'), 'mygame');
  assert.strictEqual(S.dbNameFromUri('mongodb+srv://u:p@cluster0.abc.mongodb.net/?retryWrites=true', 'fromenv'), 'fromenv');
  assert.strictEqual(S.dbNameFromUri('mongodb://localhost:27017'), 'owlfeed');
});

t('first boot import: an existing data/state.json and its uploads are copied into the empty database once', async () => {
  const dir = tmp();
  const state = bigState(); fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.mkdirSync(path.join(dir, 'uploads')); fs.writeFileSync(path.join(dir, 'uploads', 'p_9-avatar-zz.webp'), Buffer.from('avatar bytes')); fs.writeFileSync(path.join(dir, 'uploads', '..evil'), 'x');
  const st = S.createStore({ uri: uri + 'owlimport' }); await st.init();
  assert.strictEqual(await st.load(), null);
  const res = await S.importFromDisk(st, dir);
  assert.deepStrictEqual(res, { posts: 3000, users: 200, uploads: 1 });
  assert.deepStrictEqual(await st.load(), state);
  assert.strictEqual((await st.readUpload('p_9-avatar-zz.webp')).buf.toString(), 'avatar bytes');
  assert.strictEqual(await S.importFromDisk(st, tmp()), null, 'nothing to import when there is no save on disk');
  await st.close();
});

(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
  let ok = 0;
  for (const [name, fn] of tests) {
    try { await fn(); ok++; console.log('ok -', name); }
    catch (e) { console.error('FAIL -', name, '\n  ', e.stack.split('\n').slice(0, 5).join('\n   ')); process.exitCode = 1; }
  }
  await mongod.stop();
  console.log(`\n${ok}/${tests.length} storage tests passed`);
  process.exit(process.exitCode || 0);
})();
