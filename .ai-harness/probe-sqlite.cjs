
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
try {
  db.exec("CREATE VIRTUAL TABLE t USING fts5(chunk_id UNINDEXED, memory_id UNINDEXED, text)");
  db.prepare("INSERT INTO t (chunk_id, memory_id, text) VALUES (?, ?, ?)").run('c1', 'm1', 'hello world sentinel');
  const rows = db.prepare("SELECT chunk_id, memory_id, rank FROM t WHERE t MATCH ?").all('"hello world"');
  console.log('FTS5_OK', JSON.stringify(rows));
  db.exec("PRAGMA journal_mode = WAL");
  const jm = db.prepare("PRAGMA journal_mode").get();
  console.log('JOURNAL', JSON.stringify(jm));
} catch (e) {
  console.log('FTS5_FAIL', e.message);
}
db.close();
