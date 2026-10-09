// Persistence: local files (default, exactly as before) or MongoDB when MONGODB_URI is set.
//  - the whole game state is one document (gzip'd JSON) so a save is a single atomic write
//  - uploaded avatars/banners go to GridFS and are served from /uploads/<file>
//  - importFromDisk() migrates an existing data/state.json (and its uploads) into an empty database, once
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIME = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const mimeOf = name => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const safeName = n => /^[\w.\-]{1,120}$/.test(String(n)) && !String(n).includes('..');

function createFileStore({ dir, log = () => {} }) {
  const stateFile = path.join(dir, 'state.json'), upDir = path.join(dir, 'uploads');
  return {
    kind: 'file', describe: stateFile,
    async init() {},
    async load() {
      try { if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
      catch (e) { log('[owl] state load failed, starting fresh: ' + e.message); }
      return null;
    },
    async save(json) { fs.mkdirSync(dir, { recursive: true }); const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, json); fs.renameSync(tmp, stateFile); },
    async saveUpload(name, buf) { fs.mkdirSync(upDir, { recursive: true }); fs.writeFileSync(path.join(upDir, name), buf); },
    async readUpload(name) { if (!safeName(name)) return null; const f = path.join(upDir, name); return fs.existsSync(f) ? { buf: fs.readFileSync(f), mime: mimeOf(name) } : null; },
    async deleteUpload(name) { if (safeName(name)) fs.unlink(path.join(upDir, name), () => {}); },
    async close() {}
  };
}

// db name from the URI path (mongodb+srv://u:p@cluster/owlfeed?...), else MONGODB_DB, else "owlfeed"
function dbNameFromUri(uri, fallback) {
  try { const p = new URL(uri).pathname.replace(/^\//, ''); if (p) return decodeURIComponent(p); } catch (_) {}
  return fallback || 'owlfeed';
}

function createMongoStore({ uri, dbName, log = () => {} }) {
  const { MongoClient, GridFSBucket, Binary } = require('mongodb');
  let client = null, db = null, bucket = null;
  const name = dbNameFromUri(uri, dbName);
  return {
    kind: 'mongo', describe: `MongoDB database "${name}"`,
    async init() {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000, retryWrites: true });
      await client.connect();
      db = client.db(name);
      bucket = new GridFSBucket(db, { bucketName: 'uploads' });
    },
    async load() {
      const doc = await db.collection('state').findOne({ _id: 'state' });
      if (!doc || !doc.gz) return null;
      return JSON.parse(zlib.gunzipSync(Buffer.from(doc.gz.buffer)).toString('utf8'));
    },
    async save(json) {
      const gz = zlib.gzipSync(Buffer.from(json), { level: 6 });
      if (gz.length > 15 * 1024 * 1024) throw new Error('game state is too big for one MongoDB document (' + gz.length + ' bytes)');
      await db.collection('state').updateOne({ _id: 'state' }, { $set: { gz: new Binary(gz), bytes: json.length, updatedAt: new Date() } }, { upsert: true });
    },
    async saveUpload(fileName, buf) {
      await this.deleteUpload(fileName);
      await new Promise((resolve, reject) => {
        const s = bucket.openUploadStream(fileName, { metadata: { mime: mimeOf(fileName) } });
        s.on('error', reject); s.on('finish', resolve); s.end(buf);
      });
    },
    async readUpload(fileName) {
      if (!safeName(fileName)) return null;
      const f = await bucket.find({ filename: fileName }).limit(1).next();
      if (!f) return null;
      const chunks = [];
      for await (const c of bucket.openDownloadStream(f._id)) chunks.push(c);
      return { buf: Buffer.concat(chunks), mime: (f.metadata && f.metadata.mime) || mimeOf(fileName) };
    },
    async deleteUpload(fileName) { for await (const f of bucket.find({ filename: fileName })) await bucket.delete(f._id); },
    async close() { if (client) await client.close(); }
  };
}

function createStore({ uri, dir, dbName, log }) {
  return uri ? createMongoStore({ uri, dbName, log }) : createFileStore({ dir, log });
}

// first boot on MongoDB with an old save on disk: copy the state and every uploaded image across
async function importFromDisk(store, dir) {
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const st = JSON.parse(raw);
  await store.save(raw);
  let uploads = 0;
  const up = path.join(dir, 'uploads');
  if (fs.existsSync(up)) for (const f of fs.readdirSync(up)) if (safeName(f)) { await store.saveUpload(f, fs.readFileSync(path.join(up, f))); uploads++; }
  return { posts: (st.posts || []).length, users: Object.keys(st.users || {}).length, uploads };
}

module.exports = { createStore, createFileStore, createMongoStore, importFromDisk, dbNameFromUri, mimeOf, safeName };
