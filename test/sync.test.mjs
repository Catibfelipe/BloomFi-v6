// Sync rules. Run: node test/sync.test.mjs
import assert from 'node:assert/strict';
import {
  mergeSnapshots, sameSnapshot, snapshotHash, writeLocal, deriveSyncKey, newSalt, sealSnapshot, openSnapshot, saltOf,
} from '../src/lib/sync.js';

let n = 0;
const ok = (name) => { n++; console.log('  ✓', name); };
const snap = (txs = [], extra = {}) => ({ v: 1, stores: { transactions: txs, accounts: [], cards: [], budgets: [], goals: [], assets: [], connections: [], categories: [] }, tombstones: {}, settings: {}, ...extra });
const T = Date.now() - 3600000; // an hour ago: realistic times (very old deletions are forgotten)
const tx = (id, updatedAt, amount = 10) => ({ id, updatedAt: updatedAt && T + updatedAt, amount });

// newest version of a record wins, both sides keep what only they have
let m = mergeSnapshots(snap([tx('a', 1, 10), tx('b', 5, 20)]), snap([tx('a', 3, 99), tx('c', 2, 30)]));
const get = (s, id) => s.stores.transactions.find((x) => x.id === id);
assert.equal(get(m, 'a').amount, 99); assert.equal(get(m, 'b').amount, 20); assert.equal(get(m, 'c').amount, 30);
ok('newest edit wins; records from both devices are kept');

// deletions travel as tombstones, but a later edit survives an older deletion
m = mergeSnapshots(snap([tx('a', 1)], { tombstones: { 'transactions:b': T + 10 } }), snap([tx('a', 1), tx('b', 5), tx('c', 50)], { tombstones: { 'transactions:c': T + 20 } }));
assert.equal(get(m, 'b'), undefined); assert.ok(get(m, 'c')); assert.ok(get(m, 'a'));
assert.equal(m.tombstones['transactions:b'], T + 10);
ok('deleted on one device -> deleted on the other; edited after deletion -> kept');

// ties: both devices pick the same copy (no endless back and forth); remote wins when joining
const local = snap([tx('main', 0, 0)]), remote = snap([tx('main', 0, 1500)]);
assert.deepEqual(get(mergeSnapshots(local, remote), 'main'), get(mergeSnapshots(remote, local), 'main'));
ok('equal timestamps: both devices settle on the same copy');
const fresh = snap([tx('main', 1000, 0), tx('mine', 1)]);
const joined = mergeSnapshots(fresh, remote, { preferRemote: true });
assert.equal(get(joined, 'main').amount, 1500); assert.ok(get(joined, 'mine'));
ok('a joining device keeps its own records but takes the cloud copy on conflicts (e.g. the default account)');

// records the app makes by itself (updatedAt 0) never undo a deletion made on another device
m = mergeSnapshots(snap([{ id: 'rec_x_2026-10', updatedAt: 0, amount: 5 }]), snap([], { tombstones: { 'transactions:rec_x_2026-10': T } }));
assert.equal(get(m, 'rec_x_2026-10'), undefined);
ok('a recurring month or bank movement created again by another device stays deleted');

// very old deletions are forgotten (same window as the device)
m = mergeSnapshots(snap([], { tombstones: { 'transactions:old': Date.now() - 200 * 86400000, 'transactions:new': T } }), snap([]));
assert.deepEqual(Object.keys(m.tombstones), ['transactions:new']);
ok('deletions older than 180 days are dropped');

// settings: newest wins
m = mergeSnapshots(snap([], { settings: { name: 'Pai', at: 5 } }), snap([], { settings: { name: 'Felipe', at: 9 } }));
assert.equal(m.settings.name, 'Felipe');
m = mergeSnapshots(snap([], { settings: { name: 'Novo aparelho', at: 99 } }), snap([], { settings: { name: 'Felipe', at: 9 } }), { preferRemote: true });
assert.equal(m.settings.name, 'Felipe');
ok('profile settings follow the newest change (the cloud\'s when a device joins)');

assert.ok(sameSnapshot(snap([tx('a', 1), tx('b', 2)]), snap([tx('b', 2), tx('a', 1)])));
assert.ok(!sameSnapshot(snap([tx('a', 1)]), snap([tx('a', 2)])));
assert.equal(await snapshotHash(snap([tx('a', 1), { id: 'b', amount: 1, updatedAt: T }])), await snapshotHash(snap([{ updatedAt: T, amount: 1, id: 'b' }, tx('a', 1)])));
ok('change detection ignores order (of records and of fields)');

// writeLocal never overwrites what the user changed while the sync was running
{
  const mem = new Map([['a', tx('a', 1, 10)], ['b', tx('b', 1, 20)], ['c', tx('c', 1, 30)]]);
  let tombs = {};
  const fake = {
    get: async (s, id) => mem.get(id), all: async () => [...mem.values()],
    putMany: async (s, rows) => rows.forEach((r) => mem.set(r.id, r)),
    remove: async (s, id) => { mem.delete(id); },
    getTombstones: async () => tombs, setTombstones: async (t) => { tombs = t; },
  };
  const before = snap([...mem.values()]);
  // meanwhile, on this device: 'a' edited, 'b' deleted
  mem.set('a', tx('a', 50, 11)); mem.delete('b'); tombs = { 'transactions:b': T + 50 };
  const merged = snap([tx('a', 2, 99), tx('b', 2, 99), tx('d', 2, 40)], { tombstones: { 'transactions:z': T } });
  await writeLocal(fake, merged, before);
  assert.equal(mem.get('a').amount, 11); assert.equal(mem.get('b'), undefined); assert.equal(mem.get('d').amount, 40);
  assert.equal(mem.get('c'), undefined); // deleted by the merge (not touched here)
  assert.ok(tombs['transactions:b'] && tombs['transactions:z']);
  ok('edits and deletions made during a sync are kept for the next one');
}

// encryption round trip; wrong password fails
const salt = newSalt();
const key = await deriveSyncKey('senha muito boa', salt);
const data = await sealSnapshot(snap([tx('a', 1, 123.45)]), key, salt);
assert.ok(!data.includes('123.45'));
assert.equal(saltOf(data), salt);
const back = await openSnapshot(data, await deriveSyncKey('senha muito boa', salt));
assert.equal(get(back, 'a').amount, 123.45);
await assert.rejects(openSnapshot(data, await deriveSyncKey('senha errada!!', salt)), (e) => e.code === 'wrong_password');
ok('cloud copy is encrypted (gzip + AES-GCM); only the right password opens it');
{
  // a server flipping the format flags of the copy (e.g. "not compressed") is caught, not misread
  const box = JSON.parse(data);
  assert.equal(box.v, 2);
  await assert.rejects(openSnapshot(JSON.stringify({ ...box, gz: !box.gz }), key), (e) => e.code === 'wrong_password');
  await assert.rejects(openSnapshot(JSON.stringify({ ...box, v: 1 }), key), (e) => e.code === 'wrong_password');
  ok('the copy’s format flags are sealed with it: flipping them is detected');
}

// a shared goal: Ana added 100 on her phone while Bia added 250 on hers (each saw the old total)
{
  const g0 = { id: 'g1', title: 'Viagem', target: 5000, current: 1000, history: [{ date: '2026-10-01', amount: 1000 }] };
  const ana = { ...g0, current: 1100, history: [...g0.history, { date: '2026-10-15', amount: 100, h: 'ha' }], updatedAt: T + 100 };
  const bia = { ...g0, current: 1250, history: [...g0.history, { date: '2026-10-15', amount: 250, h: 'hb' }], updatedAt: T + 200 };
  const gs = (goals) => ({ ...snap(), stores: { ...snap().stores, goals } });
  const onAna = mergeSnapshots(gs([ana]), gs([bia])).stores.goals[0];
  const onBia = mergeSnapshots(gs([bia]), gs([ana])).stores.goals[0];
  assert.equal(onAna.current, 1350); assert.equal(onBia.current, 1350);
  assert.deepEqual(onAna.history.map((e) => e.h || '-'), ['-', 'ha', 'hb']);
  // merging again changes nothing, whichever copy each device holds
  assert.equal(mergeSnapshots(gs([onAna]), gs([bia])).stores.goals[0].current, 1350);
  assert.equal(mergeSnapshots(gs([onBia]), gs([onAna])).stores.goals[0].current, 1350);
  assert.equal(mergeSnapshots(gs([ana]), gs([onBia])).stores.goals[0].current, 1350);
  ok('a goal both sides added money to keeps every contribution (and merging again changes nothing)');
}

console.log(`\n${n} checks passed`);
