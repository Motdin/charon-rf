import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)');
const ins = db.prepare('INSERT INTO t(a) VALUES (?)');
const r = ins.run('hello');
console.log('run result', r, typeof r.lastInsertRowid);
const row = db.prepare('SELECT * FROM t WHERE id = ?').get(Number(r.lastInsertRowid));
console.log('row', row);
const je = db.prepare("SELECT json_extract('{\"passed\":1}', '$.passed') as p").get();
console.log('json_extract', je);
const all = db.prepare('SELECT * FROM t').all();
console.log('all', all);
console.log('node:sqlite compatible');
