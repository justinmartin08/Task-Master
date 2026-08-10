/* =====================================================================
   Task Master — script.js
   Vanilla JS, single file. No build step. Namespaced modules under TM.
   Supabase (auth, friends, help, presence, realtime sync) + CryptoJS
   (AES-256 localStorage encryption) + raw IndexedDB (attachments).

   Structure:
     TM.Config  TM.Utils  TM.Crypto  TM.Storage  TM.IDB
     TM.Recurse TM.Tasks  TM.Templates TM.Export
     TM.Calendar TM.Views TM.Friends TM.Help TM.Presence
     TM.Sync TM.Notify TM.Auth TM.UI TM.App
   ===================================================================== */
(function () {
  'use strict';

  var TM = (window.TM = window.TM || {});

  /* ============================= TM.Config ============================= */
  TM.Config = {
    url: (window.SUPABASE_URL || '').trim(),
    anonKey: (window.SUPABASE_ANON_KEY || '').trim(),
    salt: window.TM_CRYPTO_SALT || 'tm-salt',
    MAX_ATTACH_PER_TASK: 5 * 1024 * 1024,   // 5 MB per task
    PURGE_MS: 7 * 24 * 60 * 60 * 1000,      // 7 days
    HORIZON_DAYS: 60,                       // recurrence materialization horizon
    EXPORT_MAX_BYTES: 25 * 1024 * 1024,     // export size guard
    QUOTA_WARN_RATIO: 0.8,
    LS_PREFIX: 'tm.v1.'
  };
  Object.defineProperty(TM.Config, 'demo', {
    get: function () { return !this.url || !this.anonKey; },
    enumerable: true
  });

  /* ============================= TM.Utils ============================= */
  TM.Utils = (function () {
    function uid(prefix) {
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }
    function escapeHTML(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function toISO(d) {
      var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + dd;
    }
    function parseISO(iso) { // local-timezone date parse
      if (!iso) return null;
      var p = String(iso).split('-').map(Number);
      if (p.length !== 3 || p.some(isNaN)) return null;
      return new Date(p[0], p[1] - 1, p[2]);
    }
    function todayISO() { return toISO(new Date()); }
    function addDaysISO(iso, days) {
      var d = parseISO(iso);
      if (!d) return null;
      d.setDate(d.getDate() + days);
      return toISO(d);
    }
    function fmtDate(iso) {
      var d = parseISO(iso);
      if (!d) return '';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function fmtBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }
    function fmtDuration(ms) {
      if (ms < 0) ms = 0;
      var d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
      if (d > 0) return d + 'd ' + h + 'h';
      var m = Math.floor((ms % 3600000) / 60000);
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    }
    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
    function debounce(fn, ms) {
      var t;
      return function () {
        var a = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, a); }, ms);
      };
    }
    function isValidURL(s) {
      try { var u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
      catch (e) { return false; }
    }
    function dayStartMs(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    return { uid: uid, escapeHTML: escapeHTML, toISO: toISO, parseISO: parseISO, todayISO: todayISO, addDaysISO: addDaysISO, fmtDate: fmtDate, fmtBytes: fmtBytes, fmtDuration: fmtDuration, clone: clone, debounce: debounce, isValidURL: isValidURL, dayStartMs: dayStartMs };
  })();

  /* ============================= TM.Crypto ============================= */
  TM.Crypto = (function () {
    function keyFor(uid, url) {
      return CryptoJS.SHA256(uid + '|' + url + '|' + TM.Config.salt).toString();
    }
    function encrypt(obj, uid) {
      try {
        var key = keyFor(uid, TM.Config.url);
        var json = JSON.stringify(obj);
        var ct = CryptoJS.AES.encrypt(json, key).toString();
        return 'ENC:' + ct;
      } catch (e) { return null; }
    }
    function decrypt(str, uid) {
      if (str == null) return null;
      if (typeof str === 'string' && str.slice(0, 4) === 'ENC:') {
        try {
          var key = keyFor(uid, TM.Config.url);
          var pt = CryptoJS.AES.decrypt(str.slice(4), key).toString(CryptoJS.enc.Utf8);
          if (!pt) return null;
          return JSON.parse(pt);
        } catch (e) { return null; }
      }
      try { return JSON.parse(str); } catch (e) { return null; } // legacy plaintext path
    }
    return { encrypt: encrypt, decrypt: decrypt, keyFor: keyFor };
  })();

  /* ============================= TM.Storage ============================= */
  TM.Storage = (function () {
    function bucket(uid) { return TM.Config.LS_PREFIX + uid + '.'; }
    function get(uid, key, fallback) {
      try {
        var raw = localStorage.getItem(bucket(uid) + key);
        if (raw == null) return fallback;
        var v = TM.Crypto.decrypt(raw, uid);
        return v == null ? fallback : v;
      } catch (e) { return fallback; }
    }
    function set(uid, key, value) {
      try {
        var raw = TM.Crypto.encrypt(value, uid);
        localStorage.setItem(bucket(uid) + key, raw || JSON.stringify(value));
        return true;
      } catch (e) { return false; }
    }
    function remove(uid, key) {
      try { localStorage.removeItem(bucket(uid) + key); } catch (e) {}
    }
    function wipeUser(uid) {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(bucket(uid)) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    }
    return { get: get, set: set, remove: remove, wipeUser: wipeUser };
  })();

  /* ============================= TM.IDB ============================= */
  TM.IDB = (function () {
    var DB_NAME = 'tm_idb', STORE = 'attachments', dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise(function (resolve, reject) {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IDB open failed')); };
      });
      return dbPromise;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, mode);
          var done = false;
          try { fn(t.objectStore(STORE), t); } catch (e) { reject(e); return; }
          t.oncomplete = function () { if (!done) { done = true; resolve(); } };
          t.onerror = function () { if (!done) { done = true; reject(t.error); } };
          t.onabort = function () { if (!done) { done = true; reject(t.error || new Error('aborted')); } };
        });
      });
    }
    function putBlob(rec) {
      return tx('readwrite', function (store) { store.put(rec); });
    }
    function getBlob(id) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(STORE, 'readonly');
          var req = t.objectStore(STORE).get(id);
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
    function deleteBlob(id) {
      return tx('readwrite', function (store) { store.delete(id); });
    }
    function estimate() {
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().catch(function () { return null; });
      }
      return Promise.resolve(null);
    }
    function wipeAll() {
      return open().then(function (db) {
        return new Promise(function (resolve) {
          var t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).clear();
          t.oncomplete = resolve;
          t.onerror = resolve;
        });
      });
    }
    return { putBlob: putBlob, getBlob: getBlob, deleteBlob: deleteBlob, estimate: estimate, wipeAll: wipeAll };
  })();

  /* ============================= TM.Recurse ============================= */
  TM.Recurse = (function () {
    var U = TM.Utils;
    function nextOccurrence(startISO, freq, n) {
      var d = U.parseISO(startISO);
      if (!d) return null;
      switch (freq) {
        case 'daily': d.setDate(d.getDate() + n); break;
        case 'weekly': d.setDate(d.getDate() + 7 * n); break;
        case 'biweekly': d.setDate(d.getDate() + 14 * n); break;
        case 'monthly': d.setMonth(d.getMonth() + n); break;
        default: return null;
      }
      return U.toISO(d);
    }
    function horizonISO() { return U.addDaysISO(U.todayISO(), TM.Config.HORIZON_DAYS); }
    function validFreq(f) { return f === 'daily' || f === 'weekly' || f === 'biweekly' || f === 'monthly'; }
    function instanceDue(series, i) { return nextOccurrence(series.start, series.freq, i); }
    function fmtRule(series) {
      if (!series || !series.freq || series.freq === 'none') return '';
      var names = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' };
      return names[series.freq] || series.freq;
    }
    function buildInstance(series, i) {
      var due = instanceDue(series, i);
      return {
        id: U.uid('inst'),
        title: series.title,
        subject: series.subject,
        priority: series.priority,
        due: due,
        completed: false,
        completedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attachments: [],
        seriesId: series.seriesId,
        instanceIdx: i,
        instanceOverrides: null,
        origin: 'recurring'
      };
    }
    function applyOverrides(task, overrides) {
      if (!overrides) return task;
      ['title', 'due', 'subject', 'priority'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) task[k] = overrides[k];
      });
      return task;
    }
    return { nextOccurrence: nextOccurrence, horizonISO: horizonISO, validFreq: validFreq, instanceDue: instanceDue, fmtRule: fmtRule, buildInstance: buildInstance, applyOverrides: applyOverrides };
  })();

  /* ============================= TM.Tasks ============================= */
  TM.Tasks = (function () {
    var U = TM.Utils;
    var SERIES_KEY = 'series', TASKS_KEY = 'tasks', DIRTY_KEY = 'dirty';

    function ctxUid() { return TM.Auth && TM.Auth.uid ? TM.Auth.uid() : null; }

    function loadTasks() {
      var uid = ctxUid();
      if (!uid) return [];
      var arr = TM.Storage.get(uid, TASKS_KEY, []);
      return Array.isArray(arr) ? arr : [];
    }
    function saveTasks(list) {
      var uid = ctxUid();
      if (uid) TM.Storage.set(uid, TASKS_KEY, list);
    }
    function loadSeries() {
      var uid = ctxUid();
      if (!uid) return {};
      var s = TM.Storage.get(uid, SERIES_KEY, {});
      return (s && typeof s === 'object') ? s : {};
    }
    function saveSeries(map) {
      var uid = ctxUid();
      if (uid) TM.Storage.set(uid, SERIES_KEY, map);
    }
    function isDirty(id) {
      var uid = ctxUid(); if (!uid) return false;
      var d = TM.Storage.get(uid, DIRTY_KEY, []);
      return Array.isArray(d) && d.indexOf(id) !== -1;
    }
    function markDirty(id, onOff) {
      var uid = ctxUid(); if (!uid) return;
      var d = TM.Storage.get(uid, DIRTY_KEY, []);
      if (!Array.isArray(d)) d = [];
      var i = d.indexOf(id);
      if (onOff && i === -1) d.push(id);
      if (!onOff && i !== -1) { d.splice(i, 1); d.sort(); }
      TM.Storage.set(uid, DIRTY_KEY, d);
    }
    function allDirty() {
      var uid = ctxUid(); if (!uid) return [];
      var d = TM.Storage.get(uid, DIRTY_KEY, []);
      return Array.isArray(d) ? d : [];
    }

    function normalize(t) {
      if (!t) return null;
      if (typeof t.title !== 'string' || !t.title.trim()) return null;
      if (t.due && !U.parseISO(t.due)) t.due = null;
      if (t.priority !== 'high' && t.priority !== 'medium' && t.priority !== 'low') t.priority = 'medium';
      t.title = t.title.slice(0, 200);
      t.subject = (t.subject && String(t.subject).slice(0, 64)) || null;
      t.attachments = Array.isArray(t.attachments) ? t.attachments : [];
      t.id = t.id || U.uid('t');
      t.createdAt = t.createdAt || Date.now();
      t.updatedAt = t.updatedAt || Date.now();
      return t;
    }

    function find(id) {
      var list = loadTasks();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return { task: list[i], list: list, idx: i };
      return null;
    }

    function upsert(task) {
      task = normalize(task);
      if (!task) throw new Error('Invalid task');
      task.updatedAt = Date.now();
      var f = find(task.id);
      var list = loadTasks();
      if (f) { list[f.idx] = task; } else { list.push(task); }
      saveTasks(list);
      markDirty(task.id, true);
      if (TM.Sync && TM.Sync.pushOne) TM.Sync.pushOne(task);
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
      return task;
    }

    function remove(id, skipBlobs) {
      var f = find(id);
      if (!f) return false;
      var task = f.task;
      f.list.splice(f.idx, 1);
      saveTasks(f.list);
      markDirty(id, true);
      if (!skipBlobs) removeBlobs(task);
      if (TM.Sync && TM.Sync.pushOne) TM.Sync.pushOne({ id: id, _deleted: true, updatedAt: Date.now() });
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
      return true;
    }

    function removeBlobs(task) {
      (task.attachments || []).forEach(function (a) {
        if (a.kind === 'file' && a.blobId) {
          TM.IDB.deleteBlob(a.blobId).catch(function () {});
        }
      });
    }

    function setCompleted(id, completed) {
      var f = find(id);
      if (!f) return null;
      f.task.completed = !!completed;
      f.task.updatedAt = Date.now();
      if (completed) f.task.completedAt = Date.now(); else f.task.completedAt = null;
      saveTasks(f.list);
      markDirty(id, true);
      if (TM.Sync && TM.Sync.pushOne) TM.Sync.pushOne(f.task);
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
      return f.task;
    }

    function purgeSweep(now) {
      now = now || Date.now();
      var list = loadTasks(), changed = false;
      var survivors = list.filter(function (t) {
        if (t.completed && t.completedAt && now - t.completedAt >= TM.Config.PURGE_MS) {
          removeBlobs(t); changed = true; return false;
        }
        return true;
      });
      if (changed) { saveTasks(survivors); if (TM.Views && TM.Views.refresh) TM.Views.refresh(); }
      return changed;
    }

    function createSeries(opts) {
      var series = {
        seriesId: U.uid('series'),
        title: String(opts.title || '').trim().slice(0, 200),
        subject: opts.subject || null,
        priority: opts.priority || 'medium',
        freq: TM.Recurse.validFreq(opts.freq) ? opts.freq : 'weekly',
        count: Math.min(Math.max(parseInt(opts.count, 10) || 10, 1), 365),
        start: opts.start || U.todayISO(),
        updatedAt: Date.now(),
        createdAt: Date.now()
      };
      if (!U.parseISO(series.start)) series.start = U.todayISO();
      var meta = loadSeries();
      meta[series.seriesId] = series;
      saveSeries(meta);
      materializeSeries(series.seriesId, true);
      if (TM.Sync && TM.Sync.pushSeries) TM.Sync.pushSeries(series);
      return series;
    }

    function materializeSeries(seriesId, force) {
      var meta = loadSeries();
      var series = meta[seriesId];
      if (!series) return;
      var list = loadTasks();
      var existingByIdx = {};
      var keep = [];
      list.forEach(function (t) {
        if (t.seriesId === seriesId) { if (typeof t.instanceIdx === 'number') existingByIdx[t.instanceIdx] = t; }
        else keep.push(t);
      });
      var n = series.count || 0;
      var out = [];
      for (var i = 0; i < n; i++) {
        var due = TM.Recurse.instanceDue(series, i);
        if (!due) continue;
        if (due > TM.Recurse.horizonISO() && !existingByIdx[i]) break;
        if (existingByIdx[i]) {
          var inst = TM.Recurse.buildInstance(series, i);
          var prev = existingByIdx[i];
          inst.id = prev.id;
          inst.completed = prev.completed;
          inst.completedAt = prev.completedAt;
          inst.createdAt = prev.createdAt;
          inst.updatedAt = prev.updatedAt;
          inst.attachments = prev.attachments || [];
          inst.instanceOverrides = prev.instanceOverrides || null;
          TM.Recurse.applyOverrides(inst, inst.instanceOverrides);
          out.push(inst);
        } else {
          out.push(TM.Recurse.buildInstance(series, i));
        }
      }
      saveTasks(keep.concat(out));
    }

    function recomputeSeries(seriesId) {
      materializeSeries(seriesId, true);
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
    }

    function editSeriesBase(seriesId, patch) {
      var meta = loadSeries();
      var series = meta[seriesId];
      if (!series) return false;
      ['title', 'subject', 'priority'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) series[k] = patch[k] == null ? null : patch[k];
      });
      series.updatedAt = Date.now();
      saveSeries(meta);
      materializeSeries(seriesId, true);
      if (TM.Sync && TM.Sync.pushSeries) TM.Sync.pushSeries(series);
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
      return true;
    }

    function deleteSeries(seriesId) {
      var list = loadTasks();
      var survivors = [];
      list.forEach(function (t) {
        if (t.seriesId === seriesId) removeBlobs(t); else survivors.push(t);
      });
      saveTasks(survivors);
      var meta = loadSeries();
      delete meta[seriesId];
      saveSeries(meta);
      markDirty(seriesId, true);
      if (TM.Sync && TM.Sync.pushOne) TM.Sync.pushOne({ id: seriesId, _deletedSeries: true, updatedAt: Date.now() });
      if (TM.Views && TM.Views.refresh) TM.Views.refresh();
      return true;
    }

    function editInstance(task, patch) {
      task = normalize(Object.assign({}, task, patch));
      var overrides = task.instanceOverrides || {};
      ['title', 'due', 'subject', 'priority'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) overrides[k] = patch[k];
      });
      task.instanceOverrides = overrides;
      return upsert(task);
    }

    function attachCount(taskId) {
      var f = find(taskId);
      if (!f) return { bytes: 0, files: 0, links: 0, notes: 0 };
      var sum = 0, files = 0, links = 0, notes = 0;
      (f.task.attachments || []).forEach(function (a) {
        sum += a.size || 0;
        if (a.kind === 'file') files++; else if (a.kind === 'link') links++; else if (a.kind === 'note') notes++;
      });
      return { bytes: sum, files: files, links: links, notes: notes };
    }

    return {
      loadTasks: loadTasks, saveTasks: saveTasks, loadSeries: loadSeries, saveSeries: saveSeries,
      normalize: normalize, find: find, upsert: upsert, remove: remove, removeBlobs: removeBlobs,
      setCompleted: setCompleted, purgeSweep: purgeSweep,
      createSeries: createSeries, materializeSeries: materializeSeries, recomputeSeries: recomputeSeries,
      editSeriesBase: editSeriesBase, deleteSeries: deleteSeries, editInstance: editInstance,
      isDirty: isDirty, markDirty: markDirty, allDirty: allDirty, attachCount: attachCount
    };
  })();

  /* ============================= TM.Templates ============================= */
  TM.Templates = (function () {
    var KEY = 'templates';
    var DEFAULTS = [
      { name: 'Weekly Math Homework', subject: 'Math', priority: 'medium', freq: 'weekly' },
      { name: 'Weekly Reading Log', subject: 'English', priority: 'medium', freq: 'weekly' },
      { name: 'Daily Vocab Practice', subject: 'English', priority: 'low', freq: 'daily' }
    ];
    function uid() { return TM.Auth && TM.Auth.uid ? TM.Auth.uid() : null; }
    function load() {
      var u = uid();
      if (!u) return [];
      var arr = TM.Storage.get(u, KEY, null);
      if (!arr) { TM.Storage.set(u, KEY, DEFAULTS); return DEFAULTS.slice(); }
      return Array.isArray(arr) ? arr : [];
    }
    function save(list) {
      var u = uid();
      if (u) TM.Storage.set(u, KEY, list);
    }
    function add(name, subject, priority, freq) {
      var l = load();
      l.push({ name: String(name || '').trim().slice(0, 80), subject: subject || null, priority: priority || 'medium', freq: freq || 'none' });
      save(l);
      return l;
    }
    function removeByName(name) {
      save(load().filter(function (t) { return t.name !== name; }));
    }
    function resolveDue(freq) {
      if (freq === 'daily') return TM.Utils.addDaysISO(TM.Utils.todayISO(), 1);
      if (freq === 'weekly') return TM.Utils.addDaysISO(TM.Utils.todayISO(), 7);
      if (freq === 'biweekly') return TM.Utils.addDaysISO(TM.Utils.todayISO(), 14);
      if (freq === 'monthly') return TM.Utils.addDaysISO(TM.Utils.todayISO(), 30);
      return null;
    }
    return { load: load, save: save, add: add, removeByName: removeByName, resolveDue: resolveDue };
  })();

  /* ============================= TM.Export ============================= */
  TM.Export = (function () {
    var U = TM.Utils;
    var lastBackupAt = 0;

    function exportableTasks() {
      var list = TM.Tasks.loadTasks();
      var cutoff = Date.now() - TM.Config.PURGE_MS;
      return list.filter(function (t) {
        if (!t.completed) return true;
        return t.completedAt && t.completedAt >= cutoff;
      });
    }
    function guardSize(str) {
      var bytes = new Blob([str]).size;
      if (bytes > TM.Config.EXPORT_MAX_BYTES) {
        throw new Error('Export exceeds the ' + U.fmtBytes(TM.Config.EXPORT_MAX_BYTES) + ' size limit. Delete some completed tasks or export in smaller parts.');
      }
      if (performance && performance.memory) {
        var used = performance.memory.usedJSHeapSize, total = performance.memory.jsHeapSizeLimit;
        if (total && used / total > 0.8) {
          throw new Error('Browser memory usage is above 80%. Close other tabs, then retry.');
        }
      }
      return bytes;
    }
    function rowsForCSV() {
      var rows = [['ID', 'Title', 'Subject', 'Priority', 'Due', 'Status', 'Completed At', 'Series ID', 'Attachments']];
      exportableTasks().forEach(function (t) {
        rows.push([
          t.id, t.title, t.subject || '', t.priority, t.due || '',
          t.completed ? 'completed' : 'active',
          t.completedAt ? new Date(t.completedAt).toISOString() : '',
          t.seriesId || '',
          (t.attachments || []).map(function (a) { return a.kind + ':' + a.name; }).join('; ')
        ]);
      });
      return rows;
    }
    function csvEscape(v) {
      v = String(v == null ? '' : v);
      if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    }
    function exportCSV() {
      try {
        var body = rowsForCSV().map(function (r) { return r.map(csvEscape).join(','); }).join('\r\n');
        guardSize(body);
        downloadBlob(new Blob(['\ufeff' + body], { type: 'text/csv;charset=utf-8' }), 'task-master-export-' + U.todayISO() + '.csv');
        TM.Notify.toast('CSV export complete. Includes completed tasks in the 7-day window.', 'ok');
      } catch (e) { TM.Notify.toast(e.message, 'danger'); }
    }
    function exportJSON() {
      try {
        var payload = {
          app: 'task-master', version: 1, exportedAt: new Date().toISOString(),
          tasks: exportableTasks(), series: TM.Tasks.loadSeries(), templates: TM.Templates.load()
        };
        var str = JSON.stringify(payload, null, 2);
        guardSize(str);
        downloadBlob(new Blob([str], { type: 'application/json' }), 'task-master-export-' + U.todayISO() + '.json');
        TM.Notify.toast('JSON export complete.', 'ok');
      } catch (e) { TM.Notify.toast(e.message, 'danger'); }
    }
    function encryptedBackup() {
      try {
        var uid = TM.Auth.uid();
        var payload = {
          app: 'task-master', kind: 'encrypted-backup', version: 1, exportedAt: new Date().toISOString(),
          tasks: TM.Tasks.loadTasks(), series: TM.Tasks.loadSeries(), templates: TM.Templates.load()
        };
        var enc = TM.Crypto.encrypt(payload, uid);
        if (!enc) { TM.Notify.toast('Could not encrypt backup.', 'danger'); return false; }
        downloadBlob(new Blob([enc], { type: 'application/octet-stream' }), 'task-master-backup-' + U.todayISO() + '.enc');
        lastBackupAt = Date.now();
        return true;
      } catch (e) {
        TM.Notify.toast('Backup failed: ' + e.message, 'danger');
        return false;
      }
    }
    function downloadBlob(blob, name) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    return { exportCSV: exportCSV, exportJSON: exportJSON, encryptedBackup: encryptedBackup, exportableTasks: exportableTasks, guardSize: guardSize, rowsForCSV: rowsForCSV, lastBackupAt: lastBackupAt };
  })();

  /* ============================= TM.Notify ============================= */
  TM.Notify = (function () {
    var KEY = 'notifications', UNREAD_KEY = 'unread';
    function load(uid) { return TM.Storage.get(uid, KEY, []); }
    function save(uid, list) { TM.Storage.set(uid, KEY, list); }
    function loadRead(uid) { var r = TM.Storage.get(uid, UNREAD_KEY, {}); return r && typeof r === 'object' ? r : {}; }
    function saveRead(uid, m) { TM.Storage.set(uid, UNREAD_KEY, m); }
    function add(text, opts) {
      opts = opts || {};
      var uid = TM.Auth.uid(); if (!uid) return;
      var list = load(uid);
      var n = { id: TM.Utils.uid('n'), text: String(text), ts: Date.now(), type: opts.type || 'info', taskId: opts.taskId || null };
      list.unshift(n);
      if (list.length > 200) list.length = 200;
      save(uid, list);
      var read = loadRead(uid);
      read[n.id] = false;
      saveRead(uid, read);
      if (TM.UI && TM.UI.updateNotifyBadge) TM.UI.updateNotifyBadge();
      if (opts.browser !== false) browserNotify(String(text));
    }
    function markAllRead() {
      var uid = TM.Auth.uid(); if (!uid) return;
      var list = load(uid); var read = loadRead(uid);
      list.forEach(function (n) { read[n.id] = true; });
      saveRead(uid, read);
      if (TM.UI && TM.UI.updateNotifyBadge) TM.UI.updateNotifyBadge();
    }
    function unreadCount() {
      var uid = TM.Auth.uid(); if (!uid) return 0;
      var read = loadRead(uid);
      return Object.keys(read).filter(function (k) { return read[k] === false; }).length;
    }
    function browserSupported() { return 'Notification' in window; }
    function browserPermission() { return browserSupported() ? Notification.permission : 'denied'; }
    function requestBrowserPermission() {
      if (!browserSupported()) return Promise.resolve(false);
      if (Notification.permission === 'granted') return Promise.resolve(true);
      return Notification.requestPermission().then(function (p) { return p === 'granted'; });
    }
    function browserNotify(text) {
      try {
        var uid = TM.Auth.uid(); if (!uid) return;
        var settings = TM.Storage.get(uid, 'settings', {}) || {};
        if (!settings.browserNotif) return;
        if (!browserSupported() || Notification.permission !== 'granted') return;
        var n = new Notification('Task Master', { body: text });
        setTimeout(function () { try { n.close(); } catch (e) {} }, 8000);
      } catch (e) { /* in-app only */ }
    }
    function toast(text, type) {
      var host = document.getElementById('toast-host');
      if (!host) return;
      var el = document.createElement('div');
      el.className = 'toast' + (type ? ' ' + type : '');
      var sp = document.createElement('span');
      sp.textContent = text;
      var btn = document.createElement('button');
      btn.className = 'toast-x';
      btn.setAttribute('aria-label', 'Dismiss');
      btn.textContent = '\u00d7';
      btn.addEventListener('click', function () { el.remove(); });
      el.appendChild(sp); el.appendChild(btn);
      host.appendChild(el);
      setTimeout(function () {
        el.style.opacity = '0';
        el.style.transition = 'opacity .3s';
        setTimeout(function () { el.remove(); }, 320);
      }, 5200);
      while (host.children.length > 4) host.firstChild.remove();
    }
    function dueReminderCheck() {
      var uid = TM.Auth.uid(); if (!uid) return;
      var settings = TM.Storage.get(uid, 'settings', {}) || {};
      var last = settings.dueReminderDate || '';
      var today = TM.Utils.todayISO();
      if (last === today) return;
      var tasks = TM.Tasks.loadTasks();
      var dueToday = tasks.filter(function (t) { return !t.completed && t.due === today; });
      if (dueToday.length) {
        var names = dueToday.slice(0, 3).map(function (t) { return t.title; }).join(', ');
        add('You have ' + dueToday.length + ' task' + (dueToday.length > 1 ? 's' : '') + ' due today: ' + names, { browser: true });
      }
      settings.dueReminderDate = today;
      TM.Storage.set(uid, 'settings', settings);
    }
    return {
      add: add, load: load, loadRead: loadRead, markAllRead: markAllRead, unreadCount: unreadCount,
      browserSupported: browserSupported, browserPermission: browserPermission,
      requestBrowserPermission: requestBrowserPermission, browserNotify: browserNotify,
      toast: toast, dueReminderCheck: dueReminderCheck
    };
  })();

  /* ============================= TM.Calendar ============================= */
  TM.Calendar = (function () {
    var U = TM.Utils;
    var monthOffset = 0, weekOffset = 0, mode = 'month';
    var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MONTH_LIMIT = 1, WEEK_LIMIT = 4;

    function baseMonthDate() {
      var d = new Date();
      d.setMonth(d.getMonth() + monthOffset);
      return d;
    }
    function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
    function tasksByDue(list) {
      var map = {};
      list.forEach(function (t) { if (t.due) { (map[t.due] = map[t.due] || []).push(t); } });
      return map;
    }
    function renderMonth() {
      var cal = document.getElementById('cal-month');
      if (!cal) return;
      var base = baseMonthDate();
      var first = firstOfMonth(base);
      var days = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
      var map = tasksByDue(TM.Tasks.loadTasks());
      var html = [];
      DOW.forEach(function (x) { html.push('<div class="cal-dow">' + x + '</div>'); });
      var lead = first.getDay();
      var start = new Date(first); start.setDate(start.getDate() - lead);
      var today = U.todayISO();
      for (var i = 0; i < 42; i++) {
        var c = new Date(start); c.setDate(start.getDate() + i);
        var iso = U.toISO(c);
        var inMonth = c.getMonth() === base.getMonth();
        var cls = 'cal-day' + (inMonth ? '' : ' outside') + (iso === today ? ' today' : '');
        var cell = '<div class="' + cls + '"><span class="cal-day-num">' + c.getDate() + '</span>';
        if (map[iso]) {
          map[iso].slice(0, 4).forEach(function (t) {
            var extra = t.completed ? ' completed' : (t.due < today ? ' overdue' : '');
            cell += '<div class="cal-task pri-' + (t.priority || 'medium') + extra + '" data-taskid="' + t.id + '">' + U.escapeHTML(t.title) + '</div>';
          });
          if (map[iso].length > 4) cell += '<span class="cal-day-more">+' + (map[iso].length - 4) + ' more</span>';
        }
        cell += '</div>';
        html.push(cell);
      }
      cal.innerHTML = html.join('');
      bindCalTasks(cal);
    }
    function renderWeek() {
      var cal = document.getElementById('cal-week');
      if (!cal) return;
      var monday = new Date();
      var d = monday.getDay();
      monday.setDate(monday.getDate() - ((d + 6) % 7) + weekOffset * 7);
      var map = tasksByDue(TM.Tasks.loadTasks());
      var today = U.todayISO();
      var html = [];
      DOW.forEach(function (x) { html.push('<div class="cal-dow">' + x + '</div>'); });
      for (var i = 0; i < 7; i++) {
        var c = new Date(monday); c.setDate(monday.getDate() + i);
        var iso = U.toISO(c);
        var cls = 'cal-day' + (iso === today ? ' today' : '');
        var cell = '<div class="' + cls + '"><span class="cal-day-num">' + c.getDate() + '</span>';
        if (map[iso]) {
          map[iso].forEach(function (t) {
            var extra = t.completed ? ' completed' : (t.due < today ? ' overdue' : '');
            cell += '<div class="cal-task pri-' + (t.priority || 'medium') + extra + '" data-taskid="' + t.id + '">' + U.escapeHTML(t.title) + '</div>';
          });
        }
        cell += '</div>';
        html.push(cell);
      }
      cal.innerHTML = html.join('');
      bindCalTasks(cal);
    }
    function bindCalTasks(cal) {
      cal.querySelectorAll('.cal-task').forEach(function (el) {
        el.addEventListener('click', function () {
          var id = el.getAttribute('data-taskid');
          if (id && TM.UI.openTaskById) TM.UI.openTaskById(id);
        });
      });
    }
    function renderHeader() {
      var label = document.getElementById('cal-label');
      if (!label) return;
      if (mode === 'month') {
        var base = baseMonthDate();
        label.textContent = base.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      } else {
        var monday = new Date();
        var d = monday.getDay();
        monday.setDate(monday.getDate() - ((d + 6) % 7) + weekOffset * 7);
        var sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
        label.textContent = monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' \u2013 ' + sunday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
    }
    function setMode(m) {
      mode = m === 'week' ? 'week' : 'month';
      document.getElementById('cal-month').hidden = mode !== 'month';
      document.getElementById('cal-week').hidden = mode !== 'week';
      document.querySelectorAll('[data-cal]').forEach(function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-cal') === mode);
      });
      render();
    }
    function render() {
      renderHeader();
      if (mode === 'month') renderMonth(); else renderWeek();
    }
    function move(delta) {
      if (mode === 'month') {
        var nm = monthOffset + delta;
        if (Math.abs(nm) > MONTH_LIMIT) return;
        monthOffset = nm;
      } else {
        var nw = weekOffset + delta;
        if (Math.abs(nw) > WEEK_LIMIT) return;
        weekOffset = nw;
      }
      render();
    }
    function goToday() { monthOffset = 0; weekOffset = 0; render(); }
    return { render: render, setMode: setMode, move: move, goToday: goToday };
  })();

  /* ============================= TM.Views ============================= */
  TM.Views = (function () {
    var U = TM.Utils;
    var currentView = 'list';

    function filters() {
      return {
        subject: document.getElementById('filter-subject') ? document.getElementById('filter-subject').value : '',
        priority: document.getElementById('filter-priority') ? document.getElementById('filter-priority').value : '',
        status: document.getElementById('filter-status') ? document.getElementById('filter-status').value : ''
      };
    }
    function applyFilters(list) {
      var f = filters();
      var searchEl = document.getElementById('search-input');
      var q = (searchEl ? searchEl.value : '').trim().toLowerCase();
      return list.filter(function (t) {
        if (f.subject && t.subject !== f.subject) return false;
        if (f.priority && t.priority !== f.priority) return false;
        if (f.status === 'active' && t.completed) return false;
        if (f.status === 'completed' && !t.completed) return false;
        if (f.status === 'overdue' && !(!t.completed && t.due && t.due < U.todayISO())) return false;
        if (q) {
          var titleMatch = t.title && t.title.toLowerCase().indexOf(q) !== -1;
          var subjMatch = t.subject && t.subject.toLowerCase().indexOf(q) !== -1;
          if (!titleMatch && !subjMatch) return false;
        }
        return true;
      });
    }
    function sorted() {
      var s = document.getElementById('sort-mode').value;
      var list = TM.Tasks.loadTasks().slice();
      var rank = { high: 0, medium: 1, low: 2 };
      list.sort(function (a, b) {
        switch (s) {
          case 'dueAsc':
            if (!a.due && !b.due) return 0;
            if (!a.due) return 1; if (!b.due) return -1;
            return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
          case 'dueDesc':
            if (!a.due && !b.due) return 0;
            if (!a.due) return 1; if (!b.due) return -1;
            return a.due > b.due ? -1 : a.due < b.due ? 1 : 0;
          case 'priorityDesc': return rank[a.priority] - rank[b.priority];
          case 'priorityAsc': return rank[b.priority] - rank[a.priority];
          case 'titleAsc': return a.title.localeCompare(b.title);
          case 'createdDesc': return b.createdAt - a.createdAt;
        }
        return 0;
      });
      return list;
    }
    function overdueOf(t) { return !t.completed && t.due && t.due < U.todayISO(); }
    function dueSoonOf(t) { return !t.completed && t.due && t.due >= U.todayISO() && t.due <= U.addDaysISO(U.todayISO(), 7); }
    function classesFor(t) {
      var c = ['task'];
      c.push('pri-' + (t.priority || 'medium'));
      if (t.completed) c.push('completed');
      else if (overdueOf(t)) c.push('overdue');
      else if (dueSoonOf(t)) c.push('due-soon');
      return c.join(' ');
    }
    function pill(t) {
      var p = [];
      if (t.subject) p.push('<span class="m-subject">' + U.escapeHTML(t.subject) + '</span>');
      if (t.due) {
        var dueCls = t.completed ? 'm-done' : overdueOf(t) ? 'm-past' : dueSoonOf(t) ? 'm-soon' : '';
        var dueLbl = t.completed ? 'Done ' : overdueOf(t) ? 'Past due ' : 'Due ';
        p.push('<span class="' + dueCls + '">' + dueLbl + U.fmtDate(t.due) + '</span>');
      }
      var n = (t.attachments && t.attachments.length) || 0;
      if (n) p.push('<span>' + n + ' attachment' + (n > 1 ? 's' : '') + '</span>');
      if (t.seriesId) {
        var meta = TM.Tasks.loadSeries()[t.seriesId];
        var rule = (meta && TM.Recurse && TM.Recurse.fmtRule) ? TM.Recurse.fmtRule(meta) : '';
        if (rule) p.push('<span>Repeats ' + U.escapeHTML(rule) + '</span>');
      }
      return p.join('<span class="m-sep" aria-hidden="true">\u00b7</span>');
    }
    function taskItemHTML(t) {
      var drag = '';
      if (t.completed && t.completedAt) {
        var left = t.completedAt + TM.Config.PURGE_MS - Date.now();
        if (left > 0) drag = '<span class="task-purge-countdown">Clears in ' + U.fmtDuration(left) + '</span>';
      }
      var dotCls = t.completed ? ' dot-done' : overdueOf(t) ? ' dot-past' : dueSoonOf(t) ? ' dot-soon' : '';
      var editSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
      var helpSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
      var deleteSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      var detailRows = '';
      if (t.priority !== 'medium' || t.seriesId || (t.attachments && t.attachments.length)) {
        var prLabel = { high: 'High', medium: 'Medium', low: 'Low' }[t.priority] || 'Medium';
        detailRows += '<div class="task-dl-row"><span class="task-dl">Priority</span><span class="task-dv">' + prLabel + '</span></div>';
        if (t.seriesId) {
          var meta = TM.Tasks.loadSeries()[t.seriesId];
          var rule = (meta && TM.Recurse && TM.Recurse.fmtRule) ? TM.Recurse.fmtRule(meta) : '';
          detailRows += '<div class="task-dl-row"><span class="task-dl">Repeats</span><span class="task-dv">' + U.escapeHTML(rule || '') + '</span></div>';
        }
        if (t.attachments && t.attachments.length) {
          var names = t.attachments.map(function (a) { return U.escapeHTML(a.name || a.url || a.text || ''); }).join(', ');
          detailRows += '<div class="task-dl-row"><span class="task-dl">Attachments</span><span class="task-dv">' + names + '</span></div>';
        }
      }
      var detailsBlock = detailRows ? '<div class="task-details">' + detailRows + '</div>' : '';

      return '<li class="' + classesFor(t) + '" data-id="' + t.id + '">' +
        '<span class="task-status-dot' + dotCls + '" aria-hidden="true"></span>' +
        '<input type="checkbox" class="task-check" data-action="toggle" ' + (t.completed ? 'checked' : '') + ' aria-label="Mark complete" />' +
        '<div class="task-main">' +
          '<span class="task-title">' + U.escapeHTML(t.title) + '</span>' +
          '<span class="task-meta">' + pill(t) + '</span>' +
          (drag ? drag : '') +
          detailsBlock +
        '</div>' +
        '<span class="task-actions">' +
          '<button class="icon-btn btn-sm" data-action="edit" title="Edit" aria-label="Edit">' + editSvg + '</button>' +
          '<button class="icon-btn btn-sm" data-action="help" title="Ask friends for help" aria-label="Ask for help">' + helpSvg + '</button>' +
          '<button class="icon-btn btn-sm" data-action="delete" title="Delete" aria-label="Delete">' + deleteSvg + '</button>' +
        '</span></li>';
    }
    function renderList() {
      var listEl = document.getElementById('task-list');
      var empty = document.getElementById('list-empty');
      var tasks = applyFilters(sorted());
      if (!tasks.length) {
        listEl.innerHTML = '';
        empty.hidden = false;
        var all = TM.Tasks.loadTasks();
        var title = empty.querySelector('.empty-title');
        var sub = empty.querySelector('.empty-sub');
        var tplWrap = empty.querySelector('.empty-tpl-links');
        var newBtn = empty.querySelector('.empty-new-btn');
        if (newBtn) newBtn.hidden = false;
        if (!all.length) {
          title.textContent = 'No tasks yet';
          sub.textContent = 'Add your first one, or start from a suggestion below.';
          var tpls = TM.Templates.load().slice(0, 3);
          tplWrap.innerHTML = tpls.map(function (t) {
            return '<button type="button" class="empty-tpl" data-tpl="' + U.escapeHTML(t.name) + '">' + U.escapeHTML(t.name) + '</button>';
          }).join('');
          tplWrap.hidden = !tpls.length;
        } else if (all.every(function (t) { return t.completed; })) {
          title.textContent = 'You\u2019re all caught up';
          sub.textContent = 'Nothing left on your plate right now.';
          tplWrap.hidden = true;
        } else {
          title.textContent = 'No tasks match';
          sub.textContent = 'Try easing a filter or two \u2014 everything will still be here.';
          tplWrap.hidden = true;
        }
      } else {
        empty.hidden = true;
        listEl.innerHTML = tasks.map(taskItemHTML).join('');
      }
    }
    function groupKey(t, mode) {
      var today = U.todayISO();
      switch (mode) {
        case 'subject': return t.subject || 'No subject';
        case 'priority': return { high: 'High', medium: 'Medium', low: 'Low' }[t.priority] || 'Medium';
        case 'due':
          if (!t.due) return 'No due date';
          if (overdueOf(t)) return 'Past due';
          if (t.due === today) return 'Today';
          if (t.due < U.addDaysISO(today, 7)) return 'This week';
          if (t.due < U.addDaysISO(today, 30)) return 'This month';
          return 'Later';
        case 'status': return t.completed ? 'Completed' : (overdueOf(t) ? 'Past due' : 'Active');
      }
      return 'Other';
    }
    var GROUP_ORDER = { High: 0, Medium: 1, Low: 2, 'Past due': 0, Today: 1, 'This week': 2, 'This month': 3, Later: 4, Active: 0, Completed: 1, Other: 6 };
    function renderGroup() {
      var container = document.getElementById('group-container');
      var mode = document.getElementById('group-mode').value;
      var tasks = applyFilters(sorted());
      var groups = {};
      tasks.forEach(function (t) {
        var k = groupKey(t, mode);
        (groups[k] = groups[k] || []).push(t);
      });
      var keys = Object.keys(groups).sort(function (a, b) {
        var ia = GROUP_ORDER[a], ib = GROUP_ORDER[b];
        if (ia != null && ib != null && ia !== ib) return ia - ib;
        return a.localeCompare(b);
      });
      var html = '';
      keys.forEach(function (k) {
        html += '<div class="group-section"><h4>' + U.escapeHTML(k) + ' (' + groups[k].length + ')</h4><ul class="task-list">' +
          groups[k].map(taskItemHTML).join('') + '</ul></div>';
      });
      container.innerHTML = html || '<p class="empty">No tasks match.</p>';
    }
    function metrics() {
      var tasks = TM.Tasks.loadTasks();
      var total = tasks.length;
      var completed = tasks.filter(function (t) { return t.completed; }).length;
      var today = U.todayISO();
      var upcoming = tasks.filter(function (t) { return !t.completed && t.due && t.due >= today && t.due <= U.addDaysISO(today, 7); }).length;
      var overdue = tasks.filter(function (t) { return overdueOf(t); }).length;
      var pct = total ? Math.round(completed / total * 100) : 0;
      return { total: total, completed: completed, upcoming: upcoming, overdue: overdue, pct: pct };
    }
    function renderDashboardBar() {
      var m = metrics();
      var tasks = TM.Tasks.loadTasks();
      var quiet = tasks.length === 0;
      var banner = document.getElementById('kpi-empty-banner');
      if (banner) {
        banner.hidden = !quiet;
        if (quiet) {
          banner.querySelector('.kpi-empty-title').textContent = 'You\u2019re all caught up';
          banner.querySelector('.kpi-empty-sub').textContent = 'Nothing on your plate right now \u2014 the space is yours.';
        }
      }
      document.querySelectorAll('#dashboard-bar .kpi-card').forEach(function (c) { c.hidden = quiet; });
      var compEl = document.getElementById('m-completion');
      if (compEl) compEl.textContent = m.pct + '%';
      var barEl = document.getElementById('m-completion-bar');
      if (barEl) barEl.style.width = m.pct + '%';
      var upEl = document.getElementById('m-upcoming');
      if (upEl) upEl.textContent = m.upcoming;
      var od = document.getElementById('m-overdue');
      if (od) {
        od.textContent = m.overdue;
        od.className = 'kpi-val' + (m.overdue ? ' kpi-val-danger' : '');
      }
      var totEl = document.getElementById('m-total');
      if (totEl) totEl.textContent = m.total;
      var donut = document.getElementById('donut-completion');
      if (donut) donut.style.setProperty('--pct', m.pct);
      var donutNum = document.getElementById('donut-num');
      if (donutNum) donutNum.textContent = m.pct + '%';
      var dashUp = document.getElementById('dash-upcoming');
      if (dashUp) dashUp.textContent = m.upcoming;
      var dashOd = document.getElementById('dash-overdue');
      if (dashOd) dashOd.textContent = m.overdue;
      var tasks = TM.Tasks.loadTasks();
      var bySub = {};
      tasks.forEach(function (t) { var k = t.subject || 'No subject'; bySub[k] = (bySub[k] || 0) + 1; });
      var dashSubs = document.getElementById('dash-subjects');
      if (dashSubs) {
        dashSubs.innerHTML = Object.keys(bySub).sort().map(function (k) {
          return '<li><span>' + U.escapeHTML(k) + '</span><span>' + bySub[k] + '</span></li>';
        }).join('');
      }
      var byPri = { high: 0, medium: 0, low: 0 };
      tasks.forEach(function (t) { byPri[t.priority || 'medium']++; });
      var dashPri = document.getElementById('dash-priority');
      if (dashPri) {
        dashPri.innerHTML = ['high', 'medium', 'low'].map(function (k) {
          return '<li><span>' + k.charAt(0).toUpperCase() + k.slice(1) + '</span><span>' + byPri[k] + '</span></li>';
        }).join('');
      }
      var dayList = [];
      var today = U.todayISO();
      for (var i = 0; i < 14; i++) {
        var iso = U.addDaysISO(today, i);
        var n = tasks.filter(function (t) { return !t.completed && t.due === iso; }).length;
        if (n) dayList.push('<li><span>' + U.fmtDate(iso) + '</span><span>' + n + '</span></li>');
      }
      var dashDay = document.getElementById('dash-day');
      if (dashDay) dashDay.innerHTML = dayList.join('') || '<li><span>Nothing due</span><span>0</span></li>';
    }
    function populateSubjectFilter() {
      var sel = document.getElementById('filter-subject');
      if (!sel) return;
      var current = sel.value;
      var subs = {};
      TM.Tasks.loadTasks().forEach(function (t) { if (t.subject) subs[t.subject] = 1; });
      TM.Templates.load().forEach(function (t) { if (t.subject) subs[t.subject] = 1; });
      var html = '<option value="">All</option>';
      Object.keys(subs).sort().forEach(function (s) { html += '<option value="' + U.escapeHTML(s) + '">' + U.escapeHTML(s) + '</option>'; });
      sel.innerHTML = html;
      sel.value = current;
      var dl = document.getElementById('subject-list');
      if (dl) {
        dl.innerHTML = Object.keys(subs).sort().map(function (s) { return '<option value="' + U.escapeHTML(s) + '"></option>'; }).join('');
      }
    }
    function refresh() {
      TM.Tasks.purgeSweep();
      populateSubjectFilter();
      renderList();
      renderGroup();
      if (TM.Calendar) TM.Calendar.render();
      renderDashboardBar();
      if (TM.Presence && TM.Presence.update) TM.Presence.update();
    }
    function setView(v) {
      currentView = v;
      document.querySelectorAll('.view-tab[data-view]').forEach(function (b) {
        var on = b.getAttribute('data-view') === v;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      ['list', 'group', 'calendar', 'dashboard'].forEach(function (p) {
        var el = document.getElementById('pane-' + p);
        if (el) { el.classList.toggle('is-active', p === v); el.hidden = p !== v; }
      });
      if (v === 'calendar' && TM.Calendar) TM.Calendar.render();
    }
    return { refresh: refresh, setView: setView, renderList: renderList, renderGroup: renderGroup, renderDashboardBar: renderDashboardBar, metrics: metrics, applyFilters: applyFilters, sorted: sorted, classesFor: classesFor, taskItemHTML: taskItemHTML, groupKey: groupKey, overdueOf: overdueOf, dueSoonOf: dueSoonOf };
  })();

  /* ============================= TM.Presence ============================= */
  TM.Presence = (function () {
    var channels = {};
    var online = {};
    function client() { return TM.Auth && TM.Auth.client ? TM.Auth.client() : null; }
    function teardown() {
      var c = client();
      Object.keys(channels).forEach(function (k) {
        try { if (c) c.removeChannel(channels[k]); } catch (e) {}
      });
      channels = {};
      online = {};
    }
    function joinSelf() {
      var sb = client();
      if (!sb) return;
      var uid = TM.Auth.uid();
      var ch = sb.channel('presence:' + uid, { config: { presence: { key: uid } } });
      ch.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          ch.track({ uid: uid, username: TM.Auth.username() });
        }
      });
      channels[uid] = ch;
    }
    function watchFriend(fid, username) {
      var sb = client();
      if (!sb || !fid || channels[fid]) return;
      var ch = sb.channel('presence:' + fid, { config: { presence: { key: fid } } });
      ch.on('presence', { event: 'sync' }, function () {
        var state = ch.presenceState();
        var present = state[fid] && state[fid].length > 0;
        var wasOnline = !!(online[fid] && online[fid].online);
        online[fid] = { username: username || (state[fid] && state[fid][0] && state[fid][0].username) || fid, online: !!present };
        if (TM.UI && TM.UI.populateFriendPresence) TM.UI.populateFriendPresence(online);
        if (present && !wasOnline) onFriendOnline(fid);
      });
      ch.subscribe();
      channels[fid] = ch;
    }
    function onFriendOnline(fid) {
      if (TM.Config.demo) return;
      var uid = TM.Auth.uid();
      if (!uid) return;
      var c = client();
      if (!c) return;
      c.from('help_requests')
        .select('id, task_title, recipient:profiles!recipient_id(username)')
        .eq('sender_id', uid).eq('recipient_id', fid).in('status', ['sent', 'delivered'])
        .then(function (r) {
          if (r.error || !r.data || !r.data.length) return;
          if (!TM.UI.isAppVisible()) return;
          var name = r.data[0].recipient && r.data[0].recipient.username ? r.data[0].recipient.username : 'Your friend';
          TM.Notify.add(name + ' is online now \u2014 your help request for "' + r.data[0].task_title + '" was delivered.', { browser: true });
          TM.Notify.toast(name + ' is online \u2014 help request delivered.', 'ok');
        })
        .catch(function () {});
    }
    function friendsList() {
      var uid = TM.Auth.uid();
      if (!uid) return [];
      return TM.Storage.get(uid, 'friend-list-cache', []);
    }
    function setFriends(list) {
      var uid = TM.Auth.uid();
      if (uid) TM.Storage.set(uid, 'friend-list-cache', list);
      list.forEach(function (f) { watchFriend(f.friend_id, f.username); });
      update();
    }
    function update() {
      if (TM.UI && TM.UI.populateFriendPresence) TM.UI.populateFriendPresence(online);
    }
    function watchAll() {
      teardown();
      if (TM.Config.demo) return;
      joinSelf();
      friendsList().forEach(function (f) { watchFriend(f.friend_id, f.username); });
    }
    return { watchAll: watchAll, watchFriend: watchFriend, teardown: teardown, online: online, setFriends: setFriends, update: update, friendsList: friendsList };
  })();

  /* ============================= TM.Friends ============================= */
  TM.Friends = (function () {
    function sb() { return TM.Config.demo ? null : (TM.Auth && TM.Auth.client ? TM.Auth.client() : null); }
    function demoBlock() { TM.Notify.toast('Friends require Supabase setup \u2014 see README.', 'warn'); return false; }
    function fetchAll() {
      if (TM.Config.demo) return Promise.resolve({ friends: [], pending: [], sent: [] });
      var uid = TM.Auth.uid();
      return sb().from('friends')
        .select('*, sender:profiles!sender_id(username), recipient:profiles!recipient_id(username)')
        .or('sender_id.eq.' + uid + ',recipient_id.eq.' + uid)
        .then(function (res) {
          if (res.error) throw res.error;
          var raw = res.data || [];
          var accepted = [], pending = [], sent = [];
          raw.forEach(function (r) {
            r.other_id = r.sender_id === uid ? r.recipient_id : r.sender_id;
            r.other_name = r.sender_id === uid ? (r.recipient && r.recipient.username) : (r.sender && r.sender.username);
            if (r.status === 'accepted') accepted.push(r);
            else if (r.status === 'pending' && r.sender_id === uid) sent.push(r);
            else if (r.status === 'pending') pending.push(r);
          });
          TM.Presence.setFriends(accepted.map(function (r) { return { friend_id: r.other_id, username: r.other_name }; }));
          TM.Storage.set(uid, 'friends-cache', { accepted: accepted, pending: pending });
          return { friends: accepted, pending: pending, sent: sent };
        })
        .catch(function (e) {
          TM.Notify.toast('Could not load friends: ' + e.message, 'warn');
          return { friends: [], pending: [], sent: [] };
        });
    }
    function sendRequest(username) {
      if (TM.Config.demo) return demoBlock();
      username = String(username || '').trim();
      if (!username) { TM.Notify.toast('Enter a username.', 'warn'); return Promise.resolve(false); }
      var uid = TM.Auth.uid();
      return sb().from('profiles').select('id').eq('username', username).maybeSingle().then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) { TM.Notify.toast('No user named "' + username + '" exists.', 'warn'); return false; }
        var target = r.data.id;
        if (target === uid) { TM.Notify.toast('You cannot befriend yourself.', 'warn'); return false; }
        return sb().from('friends').insert({ sender_id: uid, recipient_id: target, status: 'pending' }).then(function (ins) {
          if (ins.error) {
            if (ins.error.code === '23505') { TM.Notify.toast('A request with that user already exists.', 'warn'); return false; }
            if (ins.error.code === '23503') { TM.Notify.toast('That user does not exist.', 'warn'); return false; }
            throw ins.error;
          }
          TM.Notify.toast('Friend request sent to ' + username + '.', 'ok');
          fetchAll();
          return true;
        });
      }).catch(function (e) { TM.Notify.toast('Failed to send request: ' + (e && e.message || 'unknown'), 'danger'); return false; });
    }
    function respond(rowId, accept) {
      if (TM.Config.demo) return demoBlock();
      return sb().from('friends').update({ status: accept ? 'accepted' : 'declined' }).eq('id', rowId).then(function (r) {
        if (r.error) throw r.error;
        TM.Notify.toast(accept ? 'Friend request accepted.' : 'Request declined.', accept ? 'ok' : 'info');
        fetchAll();
      }).catch(function (e) { TM.Notify.toast('Failed: ' + (e && e.message || 'unknown'), 'danger'); });
    }
    function removeFriend(rowId) {
      if (TM.Config.demo) return demoBlock();
      return sb().from('friends').delete().eq('id', rowId).then(function (r) {
        if (r.error) throw r.error;
        TM.Presence.setFriends([]);
        TM.Notify.toast('Removed friend.', 'info');
        fetchAll();
      }).catch(function (e) { TM.Notify.toast('Failed: ' + (e && e.message || 'unknown'), 'danger'); });
    }
    function subscribeRealtime() {
      if (TM.Config.demo) return null;
      var uid = TM.Auth.uid();
      var ch = TM.Auth.client().channel('friends:' + uid);
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'friends', filter: 'sender_id=eq.' + uid }, function () { fetchAll(); });
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'friends', filter: 'recipient_id=eq.' + uid }, function () {
        fetchAll();
        TM.Notify.add('You have a new friend request.', { browser: true });
      });
      ch.subscribe();
      return ch;
    }
    return { fetchAll: fetchAll, sendRequest: sendRequest, respond: respond, removeFriend: removeFriend, subscribeRealtime: subscribeRealtime, demoBlock: demoBlock };
  })();

  /* ============================= TM.Help ============================= */
  TM.Help = (function () {
    var cache = [];
    function sb() { return TM.Auth && TM.Auth.client ? TM.Auth.client() : null; }
    function demoBlock() { TM.Notify.toast('Help requests require Supabase setup \u2014 see README.', 'warn'); return false; }
    function loadForTask(taskId) {
      cache = [];
      if (TM.Config.demo) return Promise.resolve([]);
      var uid = TM.Auth.uid();
      return sb().from('help_requests')
        .select('*, recipient:profiles!recipient_id(username), sender:profiles!sender_id(username)')
        .or('sender_id.eq.' + uid + ',recipient_id.eq.' + uid)
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .then(function (r) {
          if (r.error) throw r.error;
          var rows = (r.data || []).map(function (h) {
            h._mine = h.sender_id === uid;
            h.other_name = h._mine ? (h.recipient && h.recipient.username) : (h.sender && h.sender.username);
            return h;
          });
          cache = rows;
          return rows;
        })
        .catch(function (e) {
          TM.Notify.toast('Could not load help requests: ' + (e && e.message || 'unknown'), 'warn');
          return [];
        });
    }
    function send(taskId, recipientIds, message) {
      if (TM.Config.demo) return demoBlock();
      var uid = TM.Auth.uid();
      var f = TM.Tasks.find(taskId);
      if (!f) return Promise.resolve(false);
      var rows = recipientIds.map(function (rid) {
        return {
          sender_id: uid, recipient_id: rid, task_id: taskId,
          task_title: f.task.title.slice(0, 200),
          message: message || null, status: 'sent',
          sent_at: new Date().toISOString()
        };
      });
      return sb().from('help_requests').insert(rows).then(function (r) {
        if (r.error) {
          if (r.error.code === '23505') {
            TM.Notify.toast('Duplicate blocked \u2014 one active request per friend per task.', 'warn');
            return false;
          }
          if (r.error.code === '23503') { TM.Notify.toast('A selected friend no longer exists.', 'warn'); return false; }
          throw r.error;
        }
        TM.Notify.toast('Help request sent to ' + (recipientIds.length === 1 ? '1 friend' : recipientIds.length + ' friends') + '.', 'ok');
        return true;
      }).catch(function (e) {
        if (e && e.code === '23505') { TM.Notify.toast('Duplicate blocked.', 'warn'); return false; }
        TM.Notify.toast('Failed to send: ' + (e && e.message || 'unknown'), 'danger');
        return false;
      });
    }
    function markDelivered(ids) {
      return sb().from('help_requests').update({ status: 'delivered', delivered_at: new Date().toISOString() })
        .in('id', ids).eq('recipient_id', TM.Auth.uid()).eq('status', 'sent').then(function (r) { if (r.error) throw r.error; });
    }
    function deliverIncoming() {
      if (TM.Config.demo) return;
      var uid = TM.Auth.uid();
      sb().from('help_requests').select('id')
        .eq('recipient_id', uid).eq('status', 'sent').limit(100)
        .then(function (r) {
          if (r.error || !r.data || !r.data.length) return;
          markDelivered(r.data.map(function (d) { return d.id; })).catch(function () {});
        });
    }
    function markRead(id) {
      if (TM.Config.demo) return Promise.resolve();
      return sb().from('help_requests').update({ status: 'read', read_at: new Date().toISOString() })
        .eq('id', id).eq('recipient_id', TM.Auth.uid()).neq('status', 'replied')
        .then(function (r) { if (r.error) throw r.error; })
        .catch(function () {});
    }
    function reply(id, text) {
      if (TM.Config.demo) return demoBlock();
      return sb().from('help_requests').update({ status: 'replied', reply: text.slice(0, 500), replied_at: new Date().toISOString() })
        .eq('id', id).eq('recipient_id', TM.Auth.uid())
        .then(function (r) { if (r.error) throw r.error; TM.Notify.toast('Reply sent.', 'ok'); })
        .catch(function (e) { TM.Notify.toast('Reply failed: ' + (e && e.message || 'unknown'), 'danger'); });
    }
    function subscribeRealtime() {
      if (TM.Config.demo) return null;
      var uid = TM.Auth.uid();
      var ch = TM.Auth.client().channel('help:' + uid);
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'help_requests', filter: 'recipient_id=eq.' + uid }, function (p) {
        if (p.eventType === 'INSERT') {
          var n = p.new || {};
          TM.Notify.add('You received a help request' + (n.task_title ? ' for "' + n.task_title + '"' : '') + '.', { browser: true, taskId: n.task_id });
          setTimeout(deliverIncoming, 0);
        }
        if (TM.UI && TM.UI.refreshHelp) TM.UI.refreshHelp(true);
      });
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'help_requests', filter: 'sender_id=eq.' + uid }, function (p) {
        if (TM.UI && TM.UI.refreshHelp) TM.UI.refreshHelp(true);
        var n = p.new || {};
        if (p.eventType === 'UPDATE' && n.status === 'read' && n.recipient_username_change === undefined) {
          // handled via refresh; status chip updates inline
        }
      });
      ch.subscribe();
      return ch;
    }
    function pendingForMeTo(friendId) {
      if (TM.Config.demo) return Promise.resolve([]);
      var uid = TM.Auth.uid();
      return sb().from('help_requests').select('*')
        .eq('sender_id', uid).eq('recipient_id', friendId).in('status', ['sent', 'delivered'])
        .then(function (r) { if (r.error) throw r.error; return r.data || []; })
        .catch(function () { return []; });
    }
    return { loadForTask: loadForTask, send: send, reply: reply, deliverIncoming: deliverIncoming, markRead: markRead, subscribeRealtime: subscribeRealtime, pendingForMeTo: pendingForMeTo, demoBlock: demoBlock };
  })();

  /* ============================= TM.Sync ============================= */
  TM.Sync = (function () {
    var clientId = 'cli_' + Math.random().toString(36).slice(2, 10);
    function sb() { return TM.Config.demo ? null : (TM.Auth && TM.Auth.client ? TM.Auth.client() : null); }
    function online() { return typeof navigator !== 'undefined' ? navigator.onLine : true; }
    function pushOne(task) {
      if (TM.Config.demo || !online()) return Promise.resolve();
      var s = sb(); if (!s) return Promise.resolve();
      var payload;
      if (task._deleted) payload = { id: task.id, _deleted: true, updatedAt: task.updatedAt };
      else if (task._deletedSeries) payload = { id: task.id, _deletedSeries: true, updatedAt: task.updatedAt };
      else payload = { id: task.id, data: task, updatedAt: task.updatedAt };
      return s.from('task_sync').upsert(
        { user_id: TM.Auth.uid(), task_id: task.id, payload: payload, cli: clientId, updated_at: new Date().toISOString() }
      ).then(function (r) {
        if (!r.error) TM.Tasks.markDirty(task.id, false);
      }).catch(function () {});
    }
    function pushSeries(series) {
      if (TM.Config.demo || !online()) return Promise.resolve();
      var s = sb(); if (!s) return Promise.resolve();
      return s.from('task_sync').upsert(
        { user_id: TM.Auth.uid(), task_id: 'series:' + series.seriesId, payload: { id: series.seriesId, seriesMeta: true, data: series, updatedAt: series.updatedAt }, cli: clientId, updated_at: new Date().toISOString() }
      ).catch(function () {});
    }
    function pullAll() {
      if (TM.Config.demo) return Promise.resolve();
      var s = sb(); if (!s) return Promise.resolve();
      return s.from('task_sync').select('*').eq('user_id', TM.Auth.uid()).then(function (r) {
        if (r.error) return;
        var changed = false;
        (r.data || []).forEach(function (rec) {
          if (rec.cli === clientId) return;
          var p = rec.payload || {};
          if (p._deleted) {
            var lf = TM.Tasks.find(p.id);
            if (!lf || (lf.task.updatedAt || 0) <= (p.updatedAt || 0)) { TM.Tasks.remove(p.id, true); changed = true; }
            return;
          }
          if (p._deletedSeries) {
            TM.Tasks.deleteSeries(p.id);
            changed = true;
            return;
          }
          if (p.seriesMeta) {
            var local = TM.Tasks.loadSeries();
            var remote = p.data;
            if (!local[remote.seriesId] || (local[remote.seriesId].updatedAt || 0) < (remote.updatedAt || 0)) {
              local[remote.seriesId] = remote;
              TM.Tasks.saveSeries(local);
              TM.Tasks.recomputeSeries(remote.seriesId);
              changed = true;
            }
            return;
          }
          if (!p.data) return;
          var local = TM.Tasks.find(p.data.id);
          if (!local) { TM.Tasks.upsert(p.data); changed = true; return; }
          var lt = local.task.updatedAt || 0, rt = p.data.updatedAt || 0;
          if (rt > lt + 500) {
            if (TM.Tasks.isDirty(p.data.id)) {
              TM.Notify.toast('Task "' + p.data.title + '" was changed elsewhere \u2014 keeping the newest version.', 'warn');
              TM.Notify.add('Conflict resolved (last-write-wins): "' + p.data.title + '"', { type: 'warn' });
            }
            TM.Tasks.upsert(p.data);
            changed = true;
          } else if (lt > rt + 500 && TM.Tasks.isDirty(p.data.id)) {
            pushOne(p.data);
          }
        });
        if (changed) TM.Views.refresh();
      }).catch(function () {});
    }
    function pushDirty() {
      if (TM.Config.demo) return Promise.resolve();
      var dirty = TM.Tasks.allDirty();
      var byId = {};
      TM.Tasks.loadTasks().forEach(function (t) { byId[t.id] = t; });
      var ps = [];
      dirty.forEach(function (id) {
        if (byId[id]) ps.push(pushOne(byId[id]));
        else ps.push(pushOne({ id: id, _deleted: true, updatedAt: Date.now() }));
      });
      var series = TM.Tasks.loadSeries();
      Object.keys(series).forEach(function (sid) {
        if (TM.Tasks.isDirty(sid)) ps.push(pushSeries(series[sid]));
      });
      return Promise.all(ps);
    }
    function subscribe() {
      if (TM.Config.demo) return;
      var s = sb(); if (!s) return;
      var uid = TM.Auth.uid();
      var chan = s.channel('sync:' + uid);
      chan.on('postgres_changes', { event: '*', schema: 'public', table: 'task_sync', filter: 'user_id=eq.' + uid }, function () {
        pushDirty();
        pullAll();
      });
      chan.subscribe();
    }
    function syncNow() {
      if (online()) { pushDirty(); pullAll(); }
    }
    return { pushOne: pushOne, pushSeries: pushSeries, pullAll: pullAll, pushDirty: pushDirty, subscribe: subscribe, syncNow: syncNow, online: online, clientId: clientId };
  })();

  /* ============================= TM.Auth ============================= */
  TM.Auth = (function () {
    var cachedClient = null, userId = null, userName = '';
    function makeClient() {
      if (TM.Config.demo) return null;
      cachedClient = cachedClient || supabase.createClient(TM.Config.url, TM.Config.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true }
      });
      return cachedClient;
    }
    function client() { return makeClient(); }
    function uid() { return userId; }
    function username() { return userName || ''; }
    function isDemo() { return TM.Config.demo; }
    function setUser(u) {
      userId = u && u.id ? u.id : null;
      if (userId) {
        var prof = TM.Storage.get(userId, 'user-meta', null);
        userName = (prof && prof.username) || (u && u.user_metadata && u.user_metadata.username) || '';
      } else userName = '';
    }
    function fetchUsername(force) {
      if (TM.Config.demo) return Promise.resolve(userName);
      var cached = TM.Storage.get(userId, 'user-meta', null);
      if (cached && cached.username && !force) { userName = cached.username; return Promise.resolve(userName); }
      return client().from('profiles').select('username').eq('id', userId).maybeSingle().then(function (r) {
        if (!r.error && r.data && r.data.username) {
          userName = r.data.username;
          TM.Storage.set(userId, 'user-meta', { username: userName });
        }
        return userName;
      }).catch(function () { return userName; });
    }
    function saveUsername(name) {
      userName = name;
      if (userId) TM.Storage.set(userId, 'user-meta', { username: name });
    }
    function init() {
      if (TM.Config.demo) {
        var d = TM.Storage.get('demo', 'identity', null);
        if (d && d.uid) { setUser({ id: d.uid }); userName = d.username || ''; return Promise.resolve({ uid: d.uid, username: userName, demo: true }); }
        return Promise.resolve(null);
      }
      try { makeClient(); } catch (e) { return Promise.resolve(null); }
      watchAuth();

      // Handle returning confirmation token in hash (#access_token=... or #type=signup)
      if (window.location.hash && (window.location.hash.indexOf('access_token=') !== -1 || window.location.hash.indexOf('type=signup') !== -1 || window.location.hash.indexOf('error_description=') !== -1)) {
        var hash = window.location.hash;
        if (hash.indexOf('error_description=') !== -1) {
          var errMatch = hash.match(/error_description=([^&]+)/);
          var errMsg = errMatch ? decodeURIComponent(errMatch[1]).replace(/\+/g, ' ') : 'Email confirmation failed.';
          setTimeout(function () { if (TM.Notify && TM.Notify.toast) TM.Notify.toast(errMsg, 'danger'); }, 800);
        } else {
          setTimeout(function () { if (TM.Notify && TM.Notify.toast) TM.Notify.toast('Email confirmed successfully! Welcome to Task Master.', 'ok'); }, 800);
        }
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
      }

      // Supabase v2: getSession() returns a Promise — chain it, don't read it synchronously.
      return resolveSession().then(function (res) {
        var data = (res && res.data) || {};
        if (data.session && data.session.user) {
          setUser(data.session.user);
          return fetchUsername(false).then(function () { return { uid: userId, username: userName }; });
        }
        return null;
      });
    }
    function resolveSession() {
      var res = client().auth.getSession();
      return (res && typeof res.then === 'function') ? res : Promise.resolve(res || { data: { session: null } });
    }
    var watching = false;
    function watchAuth() {
      if (watching) return;
      watching = true;
      client().auth.onAuthStateChange(function (event, session) {
        if (!session || !session.user) {
          if (event === 'SIGNED_OUT' && userId) {
            setUser(null);
            if (TM.App && TM.App.showAuth) TM.App.showAuth();
          }
          return;
        }
        // Keep user metadata fresh across token refreshes / reloads / other tabs.
        setUser(session.user);
        if (session.user.user_metadata && session.user.user_metadata.username) userName = session.user.user_metadata.username;
        fetchUsername(false);
      });
    }
    function friendlyAuthError(err) {
      if (!err) return null;
      var msg = String(err.message || err.error_description || '');
      if (/invalid login credentials/i.test(msg)) return new Error('Incorrect email or password.');
      if (/email not confirmed/i.test(msg)) {
        var e = new Error('Please confirm your email address, then log in.');
        e.code = 'email_confirmation_required';
        return e;
      }
      if (/user already registered/i.test(msg)) return new Error('An account with that email already exists. Try logging in.');
      if (/rate limit|too many requests/i.test(msg)) return new Error('Too many attempts — wait a moment and try again.');
      return err;
    }
    function syncProfile(user) {
      if (!user) return Promise.resolve();
      return client().from('profiles').select('username').eq('id', user.id).maybeSingle().then(function (r) {
        if (r.error || !r.data) {
          // Profile row missing (account predates the DB trigger) — backfill it.
          return client().from('profiles').insert({
            id: user.id,
            username: (user.user_metadata && user.user_metadata.username) || userName || 'user',
            email: user.email
          }).then(function (pr) {
            if (!pr.error && userName) TM.Storage.set(userId, 'user-meta', { username: userName });
          }).catch(function () {});
        }
        userName = r.data.username;
        TM.Storage.set(userId, 'user-meta', { username: userName });
      }).catch(function () {});
    }
    function validateReg(username, email, password) {
      if (!username || !String(username).trim()) return 'Display name is required.';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return 'Enter a valid email address.';
      if (!password || password.length < 8) return 'Password must be at least 8 characters.';
      return null;
    }
    function register(username, email, password) {
      username = String(username || '').trim().slice(0, 32);
      email = String(email || '').trim().toLowerCase();
      var v = validateReg(username, email, password);
      if (v) return Promise.reject(new Error(v));
      if (TM.Config.demo) {
        var d = TM.Storage.get('demo', 'identity', null);
        if (d) return Promise.reject(new Error('Demo mode supports one local account. Log in with it, or clear site data.'));
        var duid = 'demo_' + Math.random().toString(36).slice(2, 10);
        TM.Storage.set('demo', 'identity', { uid: duid, username: username, email: email });
        setUser({ id: duid, user_metadata: { username: username } });
        userName = username;
        return Promise.resolve({ uid: duid, username: username, demo: true });
      }
      var redirectUrl = window.location.origin + window.location.pathname;
      return client().auth.signUp({
        email: email, password: password,
        options: {
          data: { username: username },
          emailRedirectTo: redirectUrl
        }
      }).then(function (r) {
        if (r.error) throw friendlyAuthError(r.error);
        var data = r.data || {};
        var usr = data.user || (data.session && data.session.user);
        if (!usr) throw new Error('Registration incomplete — please try again.');
        return client().from('profiles').insert({ id: usr.id, username: username, email: email }).then(function (pr) {
          if (pr.error) { /* profile may be auto-created by DB trigger; swallow */ }
          if (data.session && data.session.user) {
            setUser(data.session.user);
            userName = username;
            saveUsername(username);
            return { uid: userId, username: userName };
          }
          // No session in the signUp response (email confirmation enabled, or
          // session creation deferred): try an immediate sign-in. When that is
          // rejected with "email not confirmed", the caller shows a graceful
          // confirmation state instead of a dead end.
          return client().auth.signInWithPassword({ email: email, password: password }).then(function (lr) {
            if (lr.error) throw friendlyAuthError(lr.error);
            setUser(lr.data.user);
            userName = username;
            saveUsername(username);
            return { uid: userId, username: userName };
          });
        });
      });
    }
    function login(email, password, persist) {
      email = String(email || '').trim().toLowerCase();
      password = String(password || '');
      if (!email || !password) return Promise.reject(new Error('Email and password are required.'));
      if (TM.Config.demo) {
        var d = TM.Storage.get('demo', 'identity', null);
        if (!d) return Promise.reject(new Error('No local demo account. Register first.'));
        setUser({ id: d.uid });
        userName = d.username;
        return Promise.resolve({ uid: d.uid, username: d.username, demo: true });
      }
      return client().auth.signInWithPassword({
        email: email, password: password,
        options: { persistSession: !!persist, autoRefreshToken: !!persist }
      }).then(function (r) {
        if (r.error) throw friendlyAuthError(r.error);
        setUser(r.data.user);
        return syncProfile(r.data.user).then(function () { return { uid: userId, username: userName }; });
      });
    }
    function logout() {
      try { TM.Sync.syncNow(); } catch (e) {}
      if (TM.Config.demo) return Promise.resolve();
      return client().auth.signOut().catch(function () {});
    }
    function deleteAccount() {
      // Profile + relationships removed via delete_own_user RPC (README SQL).
      // Local data wiped unconditionally; auth user handled by that RPC.
      if (TM.Config.demo) {
        TM.Storage.wipeUser('demo');
        localStorage.removeItem(TM.Config.LS_PREFIX + 'demo.identity');
        TM.IDB.wipeAll().catch(function () {});
        setUser(null);
        if (TM.App && TM.App.showAuth) TM.App.showAuth();
        return Promise.resolve();
      }
      var c = client();
      return c.rpc('delete_own_user').then(function (r) {
        if (r.error && TM.Notify) TM.Notify.toast('Account data cleared locally; remove the auth user via Supabase dashboard (see README).', 'warn');
        TM.Storage.wipeUser(userId);
        TM.IDB.wipeAll().catch(function () {});
        return c.auth.signOut();
      }).catch(function (e) {
        TM.Storage.wipeUser(userId);
        TM.IDB.wipeAll().catch(function () {});
        if (TM.Notify) TM.Notify.toast('Local data cleared (' + (e && e.message || 'RPC failed') + ').', 'warn');
        setUser(null);
        if (TM.App && TM.App.showAuth) TM.App.showAuth();
      });
    }
    return {
      client: client, uid: uid, username: username, isDemo: isDemo,
      init: init, register: register, login: login, logout: logout,
      deleteAccount: deleteAccount, fetchUsername: fetchUsername, saveUsername: saveUsername, setUser: setUser
    };
  })();

  /* ============================= TM.UI ============================= */
  TM.UI = (function () {
    var U = TM.Utils;
    var appVisible = false;
    var editingTask = null;
    var pendingAttachFiles = [];
    var backupDownloaded = false;

    function toast(text, type) {
      if (TM.Notify && TM.Notify.toast) TM.Notify.toast(text, type);
    }
    function $(id) { return document.getElementById(id); }
    function isAppVisible() { return appVisible; }

    function openModal(id) { var m = $(id); if (m) m.hidden = false; }
    function closeModal(id) { var m = $(id); if (m) m.hidden = true; }
    function closeAllModals() {
      ['task-modal', 'template-modal', 'friends-modal', 'help-modal', 'notify-modal', 'delete-modal', 'data-modal']
        .forEach(function (id) { closeModal(id); });
    }

    /* ---------- templates ---------- */
    function renderTemplateManager() {
      var list = $('template-list');
      var tpls = TM.Templates.load();
      list.innerHTML = tpls.length ? tpls.map(function (t) {
        return '<li class="template-item"><span class="template-name">' + U.escapeHTML(t.name) + '</span>' +
          '<span class="template-actions"><button class="btn btn-ghost btn-sm" data-tmpl-del="' + U.escapeHTML(t.name) + '">Remove</button></span></li>';
      }).join('') : '<li class="empty-item">No templates yet.</li>';
    }
    function quickAddTemplate(name) {
      var tpls = TM.Templates.load();
      var t = null;
      tpls.forEach(function (x) { if (x.name === name) t = x; });
      if (!t) return;
      var due = TM.Templates.resolveDue(t.freq);
      if (t.freq && t.freq !== 'none') {
        TM.Tasks.createSeries({ title: t.name, subject: t.subject, priority: t.priority, freq: t.freq, count: 10, start: due || U.todayISO() });
        toast('"' + t.name + '" schedule added.', 'ok');
      } else {
        TM.Tasks.upsert({ title: t.name, subject: t.subject, priority: t.priority, due: due });
        toast('"' + t.name + '" added.', 'ok');
      }
    }
    /* ---------- task modal ---------- */
    function openNewTask() {
      editingTask = null;
      pendingAttachFiles = [];
      $('task-modal-title').textContent = 'New task';
      $('task-id').value = '';
      $('task-series-id').value = '';
      $('task-instance-id').value = '';
      $('task-title').value = '';
      $('err-title').hidden = true;
      $('task-due').value = '';
      $('task-subject').value = '';
      setPriority('medium');
      $('recur-freq').value = 'none';
      $('recur-count').value = 10;
      updateRecurEnd();
      $('task-edit-scope-row').hidden = true;
      $('task-delete').hidden = true;
      renderAttachList('');
      openModal('task-modal');
      $('task-title').focus();
    }
    function openEditById(taskId) {
      var f = TM.Tasks.find(taskId);
      if (!f) return;
      var t = f.task;
      editingTask = taskId;
      pendingAttachFiles = [];
      $('task-modal-title').textContent = 'Edit task';
      $('task-id').value = t.id;
      $('task-series-id').value = t.seriesId || '';
      $('task-instance-id').value = t.instanceId || '';
      $('task-title').value = t.title;
      $('err-title').hidden = true;
      $('task-due').value = t.due || '';
      $('task-subject').value = t.subject || '';
      setPriority(t.priority || 'medium');
      if (t.seriesId) {
        var meta = TM.Tasks.loadSeries()[t.seriesId];
        $('recur-freq').value = (meta && meta.freq) || 'weekly';
        $('recur-count').value = (meta && meta.count) || 10;
        $('task-edit-scope-row').hidden = false;
        var instances = TM.Tasks.loadTasks().filter(function (x) { return x.seriesId === t.seriesId; }).length;
        checkScope(instances > 1 ? 'instance' : 'series');
      } else {
        $('recur-freq').value = 'none';
        $('task-edit-scope-row').hidden = true;
      }
      updateRecurEnd();
      $('task-delete').hidden = false;
      renderAttachList(t.id);
      openModal('task-modal');
    }
    function setPriority(p) {
      document.querySelectorAll('#priority-seg .seg-btn').forEach(function (b) {
        var on = b.getAttribute('data-priority') === p;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    function checkScope(v) {
      document.querySelectorAll('input[name="edit-scope"]').forEach(function (r) { r.checked = r.value === v; });
    }
    function currentPriority() {
      var active = document.querySelector('#priority-seg .seg-btn.is-active');
      return active ? active.getAttribute('data-priority') : 'medium';
    }
    function updateRecurEnd() {
      var grp = $('recur-end-group');
      if (!grp) return;
      var freqEl = $('recur-freq');
      var show = !!freqEl && freqEl.value !== 'none';
      grp.classList.toggle('recur-end-collapsed', !show);
      grp.setAttribute('aria-hidden', show ? 'false' : 'true');
      var input = grp.querySelector('#recur-count');
      if (input) input.disabled = !show;
    }

    /* ---------- attachments ---------- */
    function renderAttachList(taskId) {
      var list = $('attach-list'), size = $('attach-size');
      var parts = [], bytes = 0;
      if (taskId) {
        var f = TM.Tasks.find(taskId);
        if (f) (f.task.attachments || []).forEach(function (a) {
          bytes += a.size || 0;
          parts.push(attachItemHTML(a));
        });
      }
      pendingAttachFiles.forEach(function (pf) {
        bytes += pf.size || 0;
        parts.push(attachItemHTML({ kind: 'file', name: pf.name, size: pf.size, pending: true }));
      });
      list.innerHTML = parts.join('') || '<span class="attach-empty">No attachments.</span>';
      var pct = bytes / TM.Config.MAX_ATTACH_PER_TASK;
      size.textContent = U.fmtBytes(bytes) + ' / 5 MB';
      size.className = 'attach-size' + (pct >= 0.8 ? ' danger' : pct >= 0.5 ? ' warn' : '');
    }
    function attachItemHTML(a) {
      var meta;
      if (a.kind === 'file') meta = U.fmtBytes(a.size || 0) + (a.pending ? ' (pending)' : '');
      else if (a.kind === 'link') meta = '<a href="' + U.escapeHTML(a.url || '#') + '" target="_blank" rel="noopener">' + U.escapeHTML(a.url || '') + '</a>';
      else meta = 'note \u00b7 ' + U.escapeHTML(String(a.text || '').slice(0, 120));
      var fileSvg = '<svg class="attach-kind-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>';
      var linkSvg = '<svg class="attach-kind-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>';
      var noteSvg = '<svg class="attach-kind-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
      var kindIcon = a.kind === 'file' ? fileSvg : (a.kind === 'link' ? linkSvg : noteSvg);

      return '<div class="attach-item">' +
        '<div class="attach-info"><span class="attach-name">' + kindIcon + ' ' + U.escapeHTML(a.name || '') + '</span>' +
        '<span class="attach-sub">' + meta + '</span></div>' +
        '<button type="button" class="btn btn-ghost btn-sm btn-attach-remove" data-kind="' + a.kind + '" data-name="' + U.escapeHTML(a.name || '') + '">Remove</button>' +
        '</div>';
    }
    function stageFile(file) {
      var taskId = $('task-id').value;
      var used = pendingAttachFiles.reduce(function (s, p) { return s + (p.size || 0); }, 0);
      if (taskId) {
        var f = TM.Tasks.find(taskId);
        if (f) used += (f.task.attachments || []).reduce(function (s, a) { return s + (a.size || 0); }, 0);
      }
      if (used + file.size > TM.Config.MAX_ATTACH_PER_TASK) {
        toast('"' + file.name + '" is too large \u2014 total attachments per task must stay under 5 MB.', 'warn');
        TM.Notify.add('Attachment rejected: "' + file.name + '" exceeds the 5 MB per-task limit.', { type: 'warn' });
        return false;
      }
      pendingAttachFiles.push({ name: file.name, file: file, size: file.size, kind: 'file' });
      checkQuota(file.size);
      renderAttachList(taskId);
      return true;
    }
    function checkQuota(extraBytes) {
      TM.IDB.estimate().then(function (est) {
        if (!est || est.usage == null || !est.quota) return;
        var pct = (est.usage + (extraBytes || 0)) / est.quota;
        if (pct >= TM.Config.QUOTA_WARN_RATIO) {
          toast('IndexedDB storage is at/above 80% capacity (' + U.fmtBytes(est.usage) + ' used of ' + U.fmtBytes(est.quota) + ').', 'warn');
          TM.Notify.add('IndexedDB quota warning: storage at ' + Math.round(pct * 100) + '% capacity.', { type: 'warn' });
        }
      });
    }
    function stageLink() {
      var taskId = $('task-id').value;
      var url = prompt('Link URL (https://…):');
      if (url == null) return;
      url = url.trim();
      if (!U.isValidURL(url)) { toast('That link is not a valid http(s) URL.', 'warn'); return; }
      var f = null;
      if (taskId) f = TM.Tasks.find(taskId);
      var atts = (f && f.task.attachments) ? f.task.attachments : [];
      atts.push({ kind: 'link', name: url.slice(0, 120), url: url, size: new Blob([url]).size });
      if (f) { TM.Tasks.upsert(f.task); }
      else {
        // link staged before task exists — attach to the modal only via pending
      }
      renderAttachList(taskId);
    }
    function stageNote() {
      var taskId = $('task-id').value;
      var text = prompt('Note text:');
      if (text == null) return;
      text = text.trim();
      if (!text) return;
      var f = null;
      if (taskId) f = TM.Tasks.find(taskId);
      if (f) {
        f.task.attachments.push({ kind: 'note', name: 'Note', text: text, size: new Blob([text]).size });
        TM.Tasks.upsert(f.task);
      }
      renderAttachList(taskId);
    }
    function removeAttachment(kind, name) {
      var taskId = $('task-id').value;
      var idx = -1;
      pendingAttachFiles = pendingAttachFiles.filter(function (p, i) {
        if (p.name === name && p.kind === kind && idx === -1) { idx = i; return false; }
        return true;
      });
      if (idx !== -1) { renderAttachList(taskId); return; }
      if (!taskId) return;
      var f = TM.Tasks.find(taskId);
      if (!f) return;
      var removed = null;
      f.task.attachments = f.task.attachments.filter(function (a) {
        if (a.name === name && a.kind === kind && !removed) { removed = a; return false; }
        return true;
      });
      if (removed && removed.kind === 'file' && removed.blobId) TM.IDB.deleteBlob(removed.blobId).catch(function () {});
      TM.Tasks.upsert(f.task);
      renderAttachList(taskId);
    }
    function currentAttachments() {
      var taskId = $('task-id').value;
      if (!taskId) return [];
      var f = TM.Tasks.find(taskId);
      return f ? (f.task.attachments || []) : [];
    }

    /* ---------- save/delete task ---------- */
    function saveTaskForm() {
      var title = $('task-title').value.trim();
      if (!title) { $('err-title').hidden = false; $('task-title').focus(); return; }
      $('err-title').hidden = true;
      var due = $('task-due').value || null;
      var subject = $('task-subject').value.trim() || null;
      var priority = currentPriority();
      var freq = $('recur-freq').value;
      var count = parseInt($('recur-count').value, 10) || 10;
      var isEdit = !!$('task-id').value;
      var scopeEl = document.querySelector('input[name="edit-scope"]:checked');
      var scopeVal = scopeEl ? scopeEl.value : 'series';

      if (!isEdit) {
        var t = TM.Tasks.upsert({ title: title, due: due, subject: subject, priority: priority, attachments: [] });
        if (freq !== 'none' && TM.Recurse.validFreq(freq)) {
          TM.Tasks.createSeries({ title: title, subject: subject, priority: priority, freq: freq, count: Math.min(count, 365), start: due || U.todayISO() });
        }
        persistPendingFiles(t.id);
        closeModal('task-modal');
        toast('Task added.', 'ok');
        return;
      }
      var f = TM.Tasks.find($('task-id').value);
      if (!f) return;
      var tsk = f.task;
      if (tsk.seriesId && scopeVal === 'series') {
        TM.Tasks.editSeriesBase(tsk.seriesId, { title: title, subject: subject, priority: priority });
        persistPendingFiles(tsk.id);
        closeModal('task-modal');
        toast('Series updated \u2014 all occurrences reflect the change.', 'ok');
        return;
      }
      if (tsk.seriesId && scopeVal === 'instance') {
        TM.Tasks.editInstance(tsk, { title: title, due: due, subject: subject, priority: priority });
      } else {
        TM.Tasks.upsert({
          id: tsk.id, title: title, due: due, subject: subject, priority: priority,
          attachments: tsk.attachments, seriesId: tsk.seriesId, instanceIdx: tsk.instanceIdx,
          instanceOverrides: tsk.instanceOverrides, createdAt: tsk.createdAt, completed: tsk.completed, completedAt: tsk.completedAt
        });
      }
      persistPendingFiles(tsk.id);
      closeModal('task-modal');
      toast(tsk.seriesId && scopeVal === 'instance' ? 'Only this occurrence updated.' : 'Task updated.', 'ok');
    }
    function persistPendingFiles(taskId) {
      if (!pendingAttachFiles.length) return;
      var f = TM.Tasks.find(taskId);
      if (!f) return;
      var saved = [];
      var chain = Promise.resolve();
      pendingAttachFiles.forEach(function (p) {
        chain = chain.then(function () {
          if (p.kind !== 'file' || !p.file) return;
          var blobId = U.uid('blob');
          return TM.IDB.putBlob({ id: blobId, taskId: taskId, blob: p.file, name: p.name, mime: p.file.type || 'application/octet-stream', size: p.file.size })
            .then(function () {
              saved.push({ kind: 'file', name: p.name, blobId: blobId, size: p.file.size, mime: p.file.type || 'application/octet-stream' });
            })
            .catch(function (e) {
              toast('Could not store "' + p.name + '": ' + (e && e.message || 'IDB error'), 'danger');
            });
        });
      });
      chain.then(function () {
        var ff = TM.Tasks.find(taskId);
        if (!ff) return;
        ff.task.attachments = (ff.task.attachments || []).concat(saved);
        TM.Tasks.upsert(ff.task);
        pendingAttachFiles = [];
        renderAttachList(taskId);
        TM.Views.refresh();
      });
    }
    function processDelete() {
      var id = $('task-id').value;
      if (!id) return;
      var f = TM.Tasks.find(id);
      if (!f) return;
      if (f.task.seriesId) {
        var scopeEl = document.querySelector('input[name="edit-scope"]:checked');
        var scopeVal = scopeEl ? scopeEl.value : 'series';
        if (scopeVal === 'series') {
          var count = TM.Tasks.loadTasks().filter(function (t) { return t.seriesId === f.task.seriesId; }).length;
          if (confirm('Delete the ENTIRE recurring series (' + count + ' occurrences)? This cannot be undone.')) {
            TM.Tasks.deleteSeries(f.task.seriesId);
            closeModal('task-modal');
            toast('Series deleted.', 'ok');
          }
        } else {
          if (confirm('Delete only this occurrence? Other occurrences remain.')) {
            TM.Tasks.remove(id);
            closeModal('task-modal');
            toast('Occurrence deleted.', 'ok');
          }
        }
      } else {
        if (confirm('Delete this task? This cannot be undone.')) {
          TM.Tasks.remove(id);
          closeModal('task-modal');
          toast('Task deleted.', 'ok');
        }
      }
      TM.Views.refresh();
    }

    /* ---------- help modal ---------- */
    function openHelpFor(taskId) {
      var f = TM.Tasks.find(taskId);
      if (!f) { toast('Task not found.', 'warn'); return; }
      if (TM.Config.demo) { TM.Help.demoBlock(); return; }
      $('help-task-name').textContent = 'For: "' + f.task.title + '"';
      $('help-form').dataset.taskId = taskId;
      var ul = $('help-friend-list');
      var friends = TM.Presence.friendsList().slice();
      var onlineMap = TM.Presence.online;
      if (!friends.length) {
        ul.innerHTML = '<li class="friend-item">Add friends first to send help requests.</li>';
      } else {
        ul.innerHTML = friends.map(function (fr) {
          var on = onlineMap[fr.friend_id] && onlineMap[fr.friend_id].online;
          return '<li class="friend-item"><span class="friend-presence ' + (on ? 'online' : 'offline') + '"></span>' +
            '<span class="friend-name">' + U.escapeHTML(fr.username || fr.friend_id) + '</span>' +
            '<input type="checkbox" class="help-pick" data-fid="' + fr.friend_id + '" data-fname="' + U.escapeHTML(fr.username || '') + '" /></li>';
        }).join('');
      }
      TM.Help.loadForTask(taskId).then(function (rows) {
        renderHelpExisting(rows);
        openModal('help-modal');
      });
    }
    function renderHelpExisting(rows) {
      var ul = $('help-existing');
      if (!rows || !rows.length) { ul.innerHTML = ''; return; }
      ul.innerHTML = rows.map(function (h) {
        var chips = '<span class="help-status ' + (h.status || 'sent') + '">' + (h.status || 'sent') + '</span>';
        var who = h._mine ? 'To ' + U.escapeHTML(h.other_name || h.recipient_id) : 'From ' + U.escapeHTML(h.other_name || h.sender_id);
        var body = '<div><strong>' + who + '</strong> ' + chips + '</div>';
        if (h.message && h._mine) body += '<div class="help-reply">' + U.escapeHTML(h.message) + '</div>';
        if (!h._mine && h.message) body += '<div class="help-reply"><em>Message:</em> ' + U.escapeHTML(h.message) + '</div>';
        if (!h._mine && h.reply) body += '<div class="help-reply help-reply-sent"><strong>Your reply:</strong> ' + U.escapeHTML(h.reply) + '</div>';
        if (!h._mine && !h.reply && h.status !== 'sent') {
          body += '<div class="help-reply has-reply-input" data-id="' + h.id + '">' +
            '<input type="text" class="help-reply-input" placeholder="Optional reply\u2026" maxlength="500" />' +
            '<button class="btn btn-primary btn-sm" data-reply="' + h.id + '" type="button" disabled>Send</button></div>';
        }
        if (!h._mine && h.status === 'read') {
          // mark locally-computed; it was already marked read when opened
        }
        return '<li>' + body + '</li>';
      }).join('');
      ul.querySelectorAll('.has-reply-input .help-reply-input').forEach(function (inp) {
        var btn = inp.nextElementSibling;
        inp.addEventListener('input', function () {
          btn.disabled = !inp.value.trim();
          var id = inp.parentElement.getAttribute('data-id');
          if (id && inp.value.trim()) TM.Help.markRead(id);
        });
      });
      ul.querySelectorAll('[data-reply]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-reply');
          var box = ul.querySelector('.has-reply-input[data-id="' + id + '"]');
          var text = box ? box.querySelector('.help-reply-input').value.trim() : '';
          if (!text) { toast('Type a reply first.', 'warn'); return; }
          TM.Help.reply(id, text).then(function () { refreshHelp(true); });
        });
      });
      // mark incoming requests read when viewed
      rows.forEach(function (h) {
        if (!h._mine && (h.status === 'delivered')) TM.Help.markRead(h.id);
      });
    }
    function refreshHelp(force) {
      var form = $('help-form');
      var taskId = form ? form.dataset.taskId : null;
      if (taskId) {
        TM.Help.loadForTask(taskId).then(function (rows) {
          renderHelpExisting(rows);
        });
      }
      TM.Help.deliverIncoming();
    }
    function sendHelp() {
      var form = $('help-form');
      var taskId = form.dataset.taskId;
      if (!taskId) return;
      var picks = [];
      document.querySelectorAll('#help-friend-list .help-pick:checked').forEach(function (cb) {
        picks.push({ fid: cb.getAttribute('data-fid'), name: cb.getAttribute('data-fname') });
      });
      if (!picks.length) { toast('Pick at least one friend.', 'warn'); return; }
      var msg = $('help-message').value.trim().slice(0, 500);
      var mine = TM.Help.cache.filter(function (h) { return h._mine; }).map(function (h) { return h.recipient_id; });
      var dupes = picks.filter(function (p) { return mine.indexOf(p.fid) !== -1; });
      if (dupes.length) {
        toast('Active request already exists with: ' + dupes.map(function (d) { return d.name; }).join(', '), 'warn');
        return;
      }
      TM.Help.send(taskId, picks.map(function (p) { return p.fid; }), msg).then(function (ok) {
        if (ok) { closeModal('help-modal'); refreshHelp(true); }
      });
    }

    /* ---------- friends modal ---------- */
    function renderFriendsModal() {
      TM.Friends.fetchAll().then(function (data) {
        var pList = $('pending-list'), fList = $('friends-list');
        var pending = data.pending || [], friends = data.friends || [];
        pList.innerHTML = pending.length ? pending.map(function (r) {
          return '<li class="friend-item" data-fid="' + r.other_id + '">' +
            '<span class="friend-presence offline"></span>' +
            '<span class="friend-name">' + U.escapeHTML(r.other_name || 'Friend') + '</span>' +
            '<span class="friend-actions">' +
            '<button class="btn btn-ghost btn-sm" data-accept="' + r.id + '">Accept</button>' +
            '<button class="btn btn-danger-ghost btn-sm" data-decline="' + r.id + '">Decline</button></span></li>';
        }).join('') : '<li class="empty-item">No pending requests.</li>';
        fList.innerHTML = friends.length ? friends.map(function (r) {
          return '<li class="friend-item" data-fid="' + r.other_id + '">' +
            '<span class="friend-presence offline"></span>' +
            '<span class="friend-name">' + U.escapeHTML(r.other_name || 'Friend') + '</span>' +
            '<span class="friend-actions"><button class="btn btn-danger-ghost btn-sm" data-removefr="' + r.id + '">Remove</button></span></li>';
        }).join('') : '<li class="empty-item">No friends yet. Send a request by username above.</li>';
        if (TM.Presence && TM.Presence.update) TM.Presence.update();
      });
    }
    function populateFriendPresence(onlineMap) {
      var note = $('friends-presence-note');
      if (!note) return;
      var on = Object.keys(onlineMap).filter(function (k) { return onlineMap[k] && onlineMap[k].online; });
      var names = on.map(function (k) { return onlineMap[k].username; });
      note.textContent = names.length ? 'Online now: ' + names.join(', ') : '';
      note.hidden = !names.length;
      document.querySelectorAll('#friends-list .friend-item[data-fid]').forEach(function (li) {
        var fid = li.getAttribute('data-fid');
        var dot = li.querySelector('.friend-presence');
        if (dot) dot.className = 'friend-presence ' + ((onlineMap[fid] && onlineMap[fid].online) ? 'online' : 'offline');
      });
      document.querySelectorAll('#help-friend-list .friend-item').forEach(function (li) {
        var cb = li.querySelector('.help-pick');
        if (!cb) return;
        var fid = cb.getAttribute('data-fid');
        var dot = li.querySelector('.friend-presence');
        if (dot) dot.className = 'friend-presence ' + ((onlineMap[fid] && onlineMap[fid].online) ? 'online' : 'offline');
      });
    }

    /* ---------- notifications modal ---------- */
    function updateNotifyBadge() {
      var n = TM.Notify.unreadCount();
      var b = $('notify-badge');
      b.hidden = n === 0;
      b.textContent = n > 99 ? '99+' : String(n);
    }
    function renderNotificationList() {
      var uid = TM.Auth.uid();
      var list = TM.Notify.load(uid);
      var read = TM.Notify.loadRead(uid);
      $('notify-list').innerHTML = list.slice(0, 100).map(function (n) {
        return '<li class="notify-item' + (read[n.id] ? '' : ' unread') + '">' + U.escapeHTML(n.text) + '</li>';
      }).join('') || '<li class="notify-item">No notifications.</li>';
      TM.Notify.markAllRead();
    }

    /* ---------- delete account modal ---------- */
    function openDeleteModal() {
      backupDownloaded = false;
      $('delete-confirm').disabled = true;
      $('delete-warn-backup').style.display = 'block';
      openModal('delete-modal');
    }
    function onBackupDownloaded() {
      backupDownloaded = true;
      $('delete-confirm').disabled = false;
      $('delete-warn-backup').style.display = 'none';
      toast('Backup downloaded. You can now confirm deletion.', 'ok');
    }
    function confirmDeleteAccount() {
      if (!backupDownloaded) {
        toast('You must download an encrypted backup before deleting your account.', 'warn');
        return;
      }
      if (!confirm('Delete your Task Master account? Tasks, attachments, friends, and help history will be permanently removed. This cannot be undone.')) return;
      closeAllModals();
      TM.Auth.deleteAccount().then(function () {
        TM.Storage.wipeUser(TM.Auth.uid());
        TM.IDB.wipeAll().catch(function () {});
        TM.Presence.teardown();
        TM.App.showAuth();
        toast('Account deleted.', 'ok');
      });
    }

    /* ---------- connectivity ---------- */
    function setConnState(state, text) {
      var ind = $('conn-indicator'), dot = $('conn-dot'), txt = $('conn-text'), banner = $('offline-banner');
      if (!ind || !dot || !txt) return;
      if (!appVisible) { ind.hidden = true; return; }
      ind.hidden = false;
      dot.className = 'conn-dot' + (state === 'offline' ? ' offline' : state === 'syncing' ? ' syncing' : '');
      txt.textContent = text || (state === 'offline' ? 'Offline' : 'Online');
      if (banner) banner.hidden = state !== 'offline';
    }
    function handleOnline() {
      setConnState('syncing', 'Syncing\u2026');
      setTimeout(function () {
        TM.Sync.syncNow();
        setConnState('online', 'Online');
      }, 300);
    }
    function handleOffline() {
      setConnState('offline', 'Offline');
    }

    /* ---------- wiring ---------- */
    function slideTabIndicator() {
      var ind = $('auth-tab-indicator');
      if (!ind) return;
      var active = document.querySelector('#view-auth .auth-tab.is-active');
      var tabs = document.querySelector('#view-auth .auth-tabs');
      if (!active || !tabs) return;
      var tb = tabs.getBoundingClientRect(), ab = active.getBoundingClientRect();
      ind.style.width = Math.round(ab.width) + 'px';
      ind.style.transform = 'translateX(' + Math.round(ab.left - tb.left) + 'px)';
    }
    function showAuthTab(tab) {
      var login = tab === 'login';
      $('tab-login').classList.toggle('is-active', login);
      $('tab-register').classList.toggle('is-active', !login);
      $('tab-login').setAttribute('aria-selected', login ? 'true' : 'false');
      $('tab-register').setAttribute('aria-selected', login ? 'false' : 'true');
      $('panel-login').classList.toggle('is-active', login);
      $('panel-login').hidden = !login;
      $('panel-register').classList.toggle('is-active', !login);
      $('panel-register').hidden = login;
      $('auth-error').hidden = true;
      $('auth-error').classList.remove('is-success');
      slideTabIndicator();
    }
    function showAuthError(msg) {
      var er = $('auth-error');
      er.textContent = msg;
      er.classList.remove('is-success');
      er.hidden = false;
    }
    function showAuthSuccess(msg) {
      var er = $('auth-error');
      er.textContent = msg;
      er.classList.add('is-success');
      er.hidden = false;
    }
    function setAuthBusy(busy) {
      var form = document.querySelector('#view-auth .auth-form.is-active');
      if (form) form.classList.toggle('is-loading', busy);
      document.querySelectorAll('#view-auth button[type="submit"]').forEach(function (b) { b.disabled = busy; });
    }
    function bind() {
      // ---- password toggles ----
      document.querySelectorAll('.password-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var wrap = btn.closest('.password-input-wrap');
          if (!wrap) return;
          var input = wrap.querySelector('input');
          if (!input) return;
          var isPass = input.type === 'password';
          input.type = isPass ? 'text' : 'password';
          var eyeOpen = btn.querySelectorAll('.eye-open');
          var eyeClosed = btn.querySelectorAll('.eye-closed');
          eyeOpen.forEach(function (el) { el.style.display = isPass ? 'none' : ''; });
          eyeClosed.forEach(function (el) { el.style.display = isPass ? '' : 'none'; });
        });
      });

      // ---- auth ----
      $('tab-login').addEventListener('click', function () { showAuthTab('login'); });
      $('tab-register').addEventListener('click', function () { showAuthTab('register'); });
      $('panel-login').addEventListener('submit', function (e) {
        e.preventDefault();
        var email = $('login-email').value, pass = $('login-password').value;
        var persist = $('login-persist').checked;
        setAuthBusy(true);
        TM.Auth.login(email, pass, persist).then(function (res) {
          setAuthBusy(false);
          if (TM.App && TM.App.enterApp) TM.App.enterApp(res);
        }).catch(function (err) {
          setAuthBusy(false);
          showAuthError((err && (err.message || err.error_description)) || 'Login failed.');
        });
      });
      $('panel-register').addEventListener('submit', function (e) {
        e.preventDefault();
        var name = $('reg-username').value, email = $('reg-email').value, pass = $('reg-password').value;
        setAuthBusy(true);
        TM.Auth.register(name, email, pass).then(function (res) {
          setAuthBusy(false);
          if (TM.App && TM.App.enterApp) TM.App.enterApp(res);
        }).catch(function (err) {
          setAuthBusy(false);
          if (err && err.code === 'email_confirmation_required') {
            showAuthTab('login');
            $('login-email').value = email;
            $('login-email').focus();
            showAuthSuccess('Account created! Check your inbox to confirm your email, then log in.');
            return;
          }
          showAuthError((err && err.message) || 'Registration failed.');
        });
      });
      $('logout-btn').addEventListener('click', function () {
        TM.Auth.logout().then(function () {
          TM.Presence.teardown();
          if (TM.App && TM.App.showAuth) TM.App.showAuth();
        });
      });

      // ---- views & search ----
      document.querySelectorAll('.view-tab[data-view]').forEach(function (b) {
        b.addEventListener('click', function () { TM.Views.setView(b.getAttribute('data-view')); });
      });
      var searchInput = $('search-input');
      if (searchInput) {
        searchInput.addEventListener('input', TM.Utils.debounce(function () {
          TM.Views.renderList();
          TM.Views.renderGroup();
        }, 150));
      }
      $('sort-mode').addEventListener('change', TM.Views.refresh);
      $('filter-subject').addEventListener('change', TM.Views.refresh);
      $('filter-priority').addEventListener('change', TM.Views.refresh);
      $('filter-status').addEventListener('change', TM.Views.refresh);
      $('group-mode').addEventListener('change', TM.Views.refresh);

      // ---- KPI card interactive filtering ----
      document.querySelectorAll('.kpi-card[data-kpi-filter]').forEach(function (card) {
        card.addEventListener('click', function () {
          var targetFilter = card.getAttribute('data-kpi-filter');
          var statusSel = $('filter-status');
          if (statusSel) {
            if (targetFilter === 'all') statusSel.value = '';
            else if (targetFilter === 'upcoming') statusSel.value = 'active';
            else if (targetFilter === 'overdue') statusSel.value = 'overdue';
            else if (targetFilter === 'active') statusSel.value = 'active';
            TM.Views.setView('list');
            TM.Views.refresh();
          }
        });
      });

      // ---- filters & data ----
      $('filter-toggle').addEventListener('click', function () {
        var bar = $('filter-bar');
        var collapsed = bar.classList.toggle('collapsed');
        $('filter-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
      $('data-btn').addEventListener('click', function () { openModal('data-modal'); });
      $('data-close').addEventListener('click', function () { closeModal('data-modal'); });
      $('empty-new-btn').addEventListener('click', openNewTask);
      $('list-empty').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-tpl]') : null;
        if (b) quickAddTemplate(b.getAttribute('data-tpl'));
      });

      // ---- new task & template manager modal ----
      $('quick-add-btn').addEventListener('click', openNewTask);
      $('template-close').addEventListener('click', function () {
        closeModal('template-modal');
      });
      $('template-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var n = $('tmpl-name').value.trim();
        if (!n) { toast('Template name required.', 'warn'); return; }
        TM.Templates.add(n, $('tmpl-subject').value.trim(), $('tmpl-priority').value, $('tmpl-recur').value);
        $('tmpl-name').value = '';
        $('tmpl-subject').value = '';
        renderTemplateManager();
        TM.Views.refresh();
        toast('Template saved.', 'ok');
      });
      $('template-list').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-tmpl-del]') : null;
        if (b) { TM.Templates.removeByName(b.getAttribute('data-tmpl-del')); renderTemplateManager(); TM.Views.refresh(); }
      });

      // ---- task modal ----
      $('task-close').addEventListener('click', function () { closeModal('task-modal'); });
      $('task-cancel').addEventListener('click', function () { closeModal('task-modal'); });
      $('task-form').addEventListener('submit', function (e) { e.preventDefault(); saveTaskForm(); });
      $('task-delete').addEventListener('click', processDelete);
      document.querySelectorAll('#priority-seg .seg-btn').forEach(function (b) {
        b.addEventListener('click', function () { setPriority(b.getAttribute('data-priority')); });
      });
      $('recur-freq').addEventListener('change', updateRecurEnd);
      document.querySelectorAll('input[name="edit-scope"]').forEach(function (r) {
        r.addEventListener('change', function () { editingScope = r.value; });
      });
      $('attach-file').addEventListener('change', function (e) {
        Array.prototype.forEach.call(e.target.files || [], function (file) { stageFile(file); });
        e.target.value = '';
      });
      $('attach-link-btn').addEventListener('click', stageLink);
      $('attach-note-btn').addEventListener('click', stageNote);
      $('attach-list').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-kind]') : null;
        if (b) removeAttachment(b.getAttribute('data-kind'), b.getAttribute('data-name'));
      });

      // ---- task list actions (event delegation) ----
      ['task-list'].forEach(function (listId) {
        document.getElementById(listId).addEventListener('click', function (e) {
          var btn = e.target.closest ? e.target.closest('[data-action]') : null;
          if (!btn) {
            var main = e.target.closest ? e.target.closest('.task-main') : null;
            if (main) {
              var c = main.closest('.task');
              if (c && c.classList) c.classList.toggle('task-expanded');
            }
            return;
          }
          var li = btn.closest('.task');
          if (!li) return;
          var id = li.getAttribute('data-id');
          var action = btn.getAttribute('data-action');
          if (action === 'toggle') {
            e.stopPropagation();
            toggleTask(id, btn.checked);
          } else if (action === 'edit') {
            openEditById(id);
          } else if (action === 'help') {
            openHelpFor(id);
          } else if (action === 'delete') {
            if (confirm('Delete this task? This cannot be undone.')) {
              TM.Tasks.remove(id);
            }
          }
        });
      });
      document.getElementById('task-list').addEventListener('change', function (e) {
        if (e.target && e.target.classList.contains('task-check')) {
          var li = e.target.closest('.task');
          if (li) toggleTask(li.getAttribute('data-id'), e.target.checked);
        }
      });
      document.getElementById('group-container').addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-action]') : null;
        if (!btn) {
          var gm = e.target.closest ? e.target.closest('.task-main') : null;
          if (gm) {
            var gc = gm.closest('.task');
            if (gc && gc.classList) gc.classList.toggle('task-expanded');
          }
          return;
        }
        var li = btn.closest('.task');
        if (!li) return;
        var id = li.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        if (action === 'toggle') toggleTask(id, btn.checked);
        else if (action === 'edit') openEditById(id);
        else if (action === 'help') openHelpFor(id);
        else if (action === 'delete') {
          if (confirm('Delete this task? This cannot be undone.')) TM.Tasks.remove(id);
        }
      });
      document.getElementById('group-container').addEventListener('change', function (e) {
        if (e.target && e.target.classList.contains('task-check')) {
          var li = e.target.closest('.task');
          if (li) toggleTask(li.getAttribute('data-id'), e.target.checked);
        }
      });
      function toggleTask(id, completed) {
        TM.Tasks.setCompleted(id, completed);
        toast(completed ? 'Done \u2014 it will clear in 7 days if left completed.' : 'Reopened.', completed ? 'ok' : 'info');
      }

      // ---- group view select ----
      // (group-mode change is wired above with the other filters)

      // ---- calendar ----
      $('cal-prev').addEventListener('click', function () { TM.Calendar.move(-1); });
      $('cal-next').addEventListener('click', function () { TM.Calendar.move(1); });
      $('cal-today').addEventListener('click', function () { TM.Calendar.goToday(); });
      document.querySelectorAll('[data-cal]').forEach(function (b) {
        b.addEventListener('click', function () { TM.Calendar.setMode(b.getAttribute('data-cal')); });
      });

      // ---- export / backup ----
      $('export-csv-btn').addEventListener('click', TM.Export.exportCSV);
      $('export-json-btn').addEventListener('click', TM.Export.exportJSON);
      $('backup-btn').addEventListener('click', function () {
        if (TM.Export.encryptedBackup()) toast('Encrypted backup downloaded.', 'ok');
      });

      // ---- friends modal ----
      $('friends-btn').addEventListener('click', function () {
        renderFriendsModal();
        openModal('friends-modal');
      });
      $('friends-close').addEventListener('click', function () { closeModal('friends-modal'); });
      $('friend-add-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var un = $('friend-username').value.trim();
        TM.Friends.sendRequest(un).then(function (ok) {
          if (ok) { $('friend-username').value = ''; renderFriendsModal(); }
        });
      });
      $('pending-list').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-accept],[data-decline]') : null;
        if (!b) return;
        var id = b.getAttribute('data-accept') || b.getAttribute('data-decline');
        TM.Friends.respond(id, !!b.getAttribute('data-accept')).then(function () { renderFriendsModal(); });
      });
      $('friends-list').addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-removefr]') : null;
        if (!b) return;
        TM.Friends.removeFriend(b.getAttribute('data-removefr')).then(function () { renderFriendsModal(); });
      });

      // ---- help modal ----
      $('help-close').addEventListener('click', function () { closeModal('help-modal'); });
      $('help-form').addEventListener('submit', function (e) { e.preventDefault(); sendHelp(); });

      // ---- notifications modal ----
      $('notify-btn').addEventListener('click', function () {
        renderNotificationList();
        openModal('notify-modal');
      });
      $('notify-close').addEventListener('click', function () { closeModal('notify-modal'); });
      $('notify-browser-toggle').addEventListener('change', function (e) {
        var settings = TM.Storage.get(TM.Auth.uid(), 'settings', {}) || {};
        if (e.target.checked) {
          TM.Notify.requestBrowserPermission().then(function (granted) {
            settings.browserNotif = granted;
            TM.Storage.set(TM.Auth.uid(), 'settings', settings);
            toast(granted ? 'Browser notifications enabled.' : 'Permission denied by browser.', granted ? 'ok' : 'warn');
          });
        } else {
          settings.browserNotif = false;
          TM.Storage.set(TM.Auth.uid(), 'settings', settings);
          toast('Browser notifications disabled.', 'info');
        }
      });

      // ---- delete account ----
      $('delete-account-btn').addEventListener('click', openDeleteModal);
      $('delete-close').addEventListener('click', function () { closeModal('delete-modal'); });
      $('delete-cancel').addEventListener('click', function () { closeModal('delete-modal'); });
      $('delete-download').addEventListener('click', function () {
        if (TM.Export.encryptedBackup()) onBackupDownloaded();
      });
      $('delete-confirm').addEventListener('click', confirmDeleteAccount);

      // ---- connectivity ----
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      window.addEventListener('resize', slideTabIndicator);

      // ---- keyboard ----
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeAllModals();
      });
    }

    function bootFills() {
      // prefill browser-notif toggle from settings
      var settings = {};
      var uid = TM.Auth.uid();
      if (uid) settings = TM.Storage.get(uid, 'settings', {}) || {};
      var toggle = $('notify-browser-toggle');
      if (toggle) toggle.checked = !!(settings.browserNotif);
      showAuthTab('login');
    }

    return {
      bind: bind, bootFills: bootFills, openNewTask: openNewTask, openEditById: openEditById, openTaskById: openEditById,
      openDeleteModal: openDeleteModal, onBackupDownloaded: onBackupDownloaded,
      updateNotifyBadge: updateNotifyBadge, renderNotificationList: renderNotificationList,
      populateFriendPresence: populateFriendPresence, refreshHelp: refreshHelp,
      renderFriendsModal: renderFriendsModal, closeAllModals: closeAllModals, isAppVisible: isAppVisible,
      stageFile: stageFile, setConnState: setConnState, setAppVisible: function (v) { appVisible = v; }
    };
  })();

  /* ============================= TM.App ============================= */
  TM.App = (function () {
    function dismissSplash() {
      var splash = document.getElementById('app-intro-splash');
      if (splash && !splash.classList.contains('dismissed')) {
        splash.classList.add('dismissed');
        setTimeout(function () { if (splash && splash.parentNode) splash.parentNode.removeChild(splash); }, 800);
      }
    }
    function showAuth() {
      TM.UI.setAppVisible(false);
      TM.UI.closeAllModals();
      document.getElementById('view-auth').hidden = false;
      document.getElementById('view-app').hidden = true;
      TM.UI.bootFills();
      document.getElementById('conn-indicator').hidden = true;
      setTimeout(dismissSplash, 400);
    }
    function enterApp(session) {
      TM.UI.setAppVisible(true);
      document.getElementById('view-auth').hidden = true;
      document.getElementById('view-app').hidden = false;
      document.getElementById('conn-indicator').hidden = false;
      TM.Views.refresh();
      TM.UI.updateNotifyBadge();
      if (!TM.Config.demo) {
        TM.Help.deliverIncoming();
        TM.Friends.fetchAll().then(function () { TM.Presence.watchAll(); });
        TM.Friends.subscribeRealtime();
        TM.Help.subscribeRealtime();
        TM.Sync.subscribe();
        setTimeout(function () { TM.Sync.syncNow(); }, 800);
      } else {
        TM.Presence.update();
      }
      TM.UI.setConnState(TM.Sync.online() ? 'online' : 'offline', TM.Sync.online() ? 'Online' : 'Offline');
      TM.Notify.dueReminderCheck();
      startTimers();
      setTimeout(dismissSplash, 400);
    }
    function startTimers() {
      if (startTimers.__started) return;
      startTimers.__started = true;
      setInterval(function () { TM.Tasks.purgeSweep(); }, 10 * 60 * 1000);
      setInterval(function () { TM.Notify.dueReminderCheck(); }, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { TM.Tasks.purgeSweep(); TM.Sync.syncNow(); }
      });
      window.setInterval(function () { /* keepalive */ }, 30000);
    }
    function boot() {
      TM.UI.bind();
      TM.Auth.init().then(function (session) {
        if (session) enterApp(session);
        else showAuth();
      }).catch(function () { showAuth(); });
    }
    return { boot: boot, showAuth: showAuth, enterApp: enterApp };
  })();

  /* ============================= Boot ============================= */
  if (window.__TM_TEST__) {
    // Test harness mode: no auto-boot, full TM namespace exposed for tests.
    return;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { TM.App.boot(); });
  } else {
    TM.App.boot();
  }
})();