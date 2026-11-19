/*
 * Home dashboard for an always-on iPad Air 2 (Safari 15).
 *
 * Keep this file ES2017: no optional chaining (?.), no nullish coalescing (??),
 * no Array.prototype.at / Object.hasOwn / structuredClone, no modules.
 * `npm run check` enforces the syntax part.
 */
(function () {
  'use strict';

  var CONFIG = {
    kumaSlug: 'home',
    kumaIntervalMs: 30 * 1000,
    k8sIntervalMs: 60 * 1000,
    requestTimeoutMs: 15 * 1000,
    // Show the red "stale" frame when a source hasn't updated for this long.
    staleAfterMs: 3 * 60 * 1000,
    // Reload the whole page periodically so a long-running tab doesn't degrade.
    reloadEveryMs: 6 * 60 * 60 * 1000,
    beatsShown: 30,
    // Dim the screen between these hours (local time). Set start === end to disable.
    nightStartHour: 23,
    nightEndHour: 6
  };

  var STATUS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maint' };
  var STATUS_LABEL = { down: 'ダウン', up: '正常', pending: '保留', maint: 'メンテナンス', unknown: '不明' };
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  var state = {
    kuma: { lastOk: 0, error: null, data: null },
    k8s: { lastOk: 0, error: null, data: null },
    startedAt: Date.now()
  };

  // ---------------------------------------------------------------- utils

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function getJSON(url) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, CONFIG.requestTimeoutMs);
    return fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) { clearTimeout(timer); return json; },
            function (err) { clearTimeout(timer); throw err; });
  }

  // Uptime Kuma times are UTC strings like "2026-11-19 05:16:07.699".
  function parseKumaTime(s) {
    if (!s) return null;
    var d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }

  // Kubernetes quantities -> number (CPU in cores, memory in bytes).
  function parseQuantity(q) {
    if (q === undefined || q === null) return 0;
    var s = String(q);
    var m = /^([0-9.]+)([a-zA-Z]*)$/.exec(s);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    var unit = m[2];
    var mult = {
      '': 1, n: 1e-9, u: 1e-6, m: 1e-3,
      k: 1e3, M: 1e6, G: 1e9, T: 1e12,
      Ki: 1024, Mi: 1048576, Gi: 1073741824, Ti: 1099511627776
    }[unit];
    return mult === undefined ? 0 : n * mult;
  }

  // ---------------------------------------------------------------- clock

  function renderClock() {
    var now = new Date();
    $('time').textContent = hhmm(now);
    $('date').textContent = (now.getMonth() + 1) + '月' + now.getDate() + '日 (' + WEEKDAYS[now.getDay()] + ')';

    var h = now.getHours();
    var s = CONFIG.nightStartHour, e = CONFIG.nightEndHour;
    var night = s === e ? false : (s < e ? (h >= s && h < e) : (h >= s || h < e));
    document.body.className = night ? 'night' : '';
  }

  // ---------------------------------------------------------------- kuma

  function loadKuma() {
    var slug = encodeURIComponent(CONFIG.kumaSlug);
    return Promise.all([
      getJSON('api/kuma/' + slug),
      getJSON('api/kuma/heartbeat/' + slug)
    ]).then(function (r) {
      state.kuma.data = { page: r[0], beats: r[1] };
      state.kuma.lastOk = Date.now();
      state.kuma.error = null;
    }, function (err) {
      state.kuma.error = err && err.message ? err.message : String(err);
    }).then(render);
  }

  function monitorStatus(beats) {
    if (!beats || beats.length === 0) return 'unknown';
    return STATUS[beats[beats.length - 1].status] || 'unknown';
  }

  function buildMonitors() {
    var data = state.kuma.data;
    if (!data) return [];
    var heartbeatList = (data.beats && data.beats.heartbeatList) || {};
    var uptimeList = (data.beats && data.beats.uptimeList) || {};
    var maintenance = (data.page && data.page.maintenanceList) || [];
    var groups = (data.page && data.page.publicGroupList) || [];

    return groups.map(function (g) {
      return {
        name: g.name,
        monitors: (g.monitorList || []).map(function (m) {
          var beats = heartbeatList[m.id] || heartbeatList[String(m.id)] || [];
          var status = monitorStatus(beats);
          if (status !== 'down' && maintenance.length > 0 && m.maintenance) status = 'maint';
          var last = beats.length ? beats[beats.length - 1] : null;
          var up = uptimeList[m.id + '_24'];
          return {
            id: m.id,
            name: m.name,
            status: status,
            beats: beats.slice(-CONFIG.beatsShown),
            uptime24: typeof up === 'number' ? up : null,
            ping: last && typeof last.ping === 'number' ? last.ping : null,
            lastMsg: last ? last.msg : '',
            lastTime: last ? parseKumaTime(last.time) : null
          };
        })
      };
    });
  }

  function formatPing(ms) {
    if (ms === null) return '';
    if (ms < 1) return '<1 ms';
    return Math.round(ms) + ' ms';
  }

  function renderMonitors(groups) {
    var root = $('monitors');
    root.innerHTML = '';

    if (state.kuma.error && !state.kuma.data) {
      root.appendChild(el('div', 'error', 'Uptime Kuma から取得できません: ' + state.kuma.error));
      return;
    }
    if (!state.kuma.data) {
      root.appendChild(el('div', 'empty', '読み込み中…'));
      return;
    }

    groups.forEach(function (g) {
      // With a single group the panel title is enough.
      if (groups.length > 1) root.appendChild(el('div', 'group-name', g.name));
      g.monitors.forEach(function (m) {
        var row = el('div', 'monitor monitor-' + m.status);
        row.appendChild(el('span', 'dot s-' + m.status));
        var name = el('span', 'monitor-name', m.name);
        if (m.status === 'down' && m.lastMsg) name.title = m.lastMsg;
        row.appendChild(name);

        var beats = el('span', 'beats');
        var missing = CONFIG.beatsShown - m.beats.length;
        for (var i = 0; i < missing; i++) beats.appendChild(el('span', 'beat s-unknown'));
        m.beats.forEach(function (b) {
          beats.appendChild(el('span', 'beat s-' + (STATUS[b.status] || 'unknown')));
        });
        row.appendChild(beats);

        row.appendChild(el('span', 'ping', formatPing(m.ping)));
        row.appendChild(el('span', 'uptime',
          m.uptime24 !== null ? (Math.floor(m.uptime24 * 1000) / 10).toFixed(1) + '%' : '-'));
        root.appendChild(row);
      });
    });

    if (groups.length === 0) root.appendChild(el('div', 'empty', 'ステータスページにモニターがありません'));
  }

  // ---------------------------------------------------------------- k8s

  function loadK8s() {
    return Promise.all([
      getJSON('api/k8s/nodes'),
      getJSON('api/k8s/node-metrics'),
      getJSON('api/k8s/pods')
    ]).then(function (r) {
      state.k8s.data = { nodes: r[0], metrics: r[1], pods: r[2] };
      state.k8s.lastOk = Date.now();
      state.k8s.error = null;
    }, function (err) {
      state.k8s.error = err && err.message ? err.message : String(err);
    }).then(render);
  }

  function buildNodes() {
    var data = state.k8s.data;
    if (!data) return [];
    var usage = {};
    ((data.metrics && data.metrics.items) || []).forEach(function (m) {
      usage[m.metadata.name] = m.usage || {};
    });
    return ((data.nodes && data.nodes.items) || []).map(function (n) {
      var name = n.metadata.name;
      var cap = (n.status && n.status.capacity) || {};
      var conds = (n.status && n.status.conditions) || [];
      var ready = conds.some(function (c) { return c.type === 'Ready' && c.status === 'True'; });
      var u = usage[name];
      var cpuCap = parseQuantity(cap.cpu), memCap = parseQuantity(cap.memory);
      return {
        name: name,
        ready: ready,
        cpu: u && cpuCap ? parseQuantity(u.cpu) / cpuCap : null,
        mem: u && memCap ? parseQuantity(u.memory) / memCap : null
      };
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  }

  function podProblem(p) {
    var phase = p.status && p.status.phase;
    if (phase === 'Succeeded') return null;
    if (p.metadata && p.metadata.deletionTimestamp) return null;
    var statuses = (p.status && p.status.containerStatuses) || [];
    for (var i = 0; i < statuses.length; i++) {
      var cs = statuses[i];
      if (cs.state && cs.state.waiting && cs.state.waiting.reason &&
          cs.state.waiting.reason !== 'ContainerCreating' && cs.state.waiting.reason !== 'PodInitializing') {
        return cs.state.waiting.reason;
      }
      if (cs.state && cs.state.terminated && cs.state.terminated.exitCode !== 0) {
        return cs.state.terminated.reason || 'Error';
      }
    }
    if (phase === 'Pending' || phase === 'Failed' || phase === 'Unknown') {
      return (p.status && p.status.reason) || phase;
    }
    if (phase === 'Running') {
      for (var j = 0; j < statuses.length; j++) {
        // Ignore pods that started recently; they may still be warming up.
        var started = statuses[j].state && statuses[j].state.running && statuses[j].state.running.startedAt;
        var age = started ? Date.now() - new Date(started).getTime() : Infinity;
        if (!statuses[j].ready && age > 5 * 60 * 1000) return 'NotReady';
      }
    }
    return null;
  }

  function buildProblemPods() {
    var data = state.k8s.data;
    if (!data) return [];
    var out = [];
    ((data.pods && data.pods.items) || []).forEach(function (p) {
      var reason = podProblem(p);
      if (reason) out.push({ ns: p.metadata.namespace, name: p.metadata.name, reason: reason });
    });
    return out;
  }

  function meter(label, ratio) {
    var wrap = el('div', 'meter-wrap');
    wrap.appendChild(el('span', 'meter-label', label));
    var bar = el('div', 'meter');
    var fill = el('div', 'meter-fill');
    var pct = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
    fill.style.width = pct + '%';
    if (pct >= 90) fill.className += ' crit';
    else if (pct >= 75) fill.className += ' warn';
    bar.appendChild(fill);
    wrap.appendChild(bar);
    wrap.appendChild(el('span', 'meter-value', ratio === null ? '-' : Math.round(pct) + '%'));
    return wrap;
  }

  function renderCluster(nodes, pods) {
    var nodesRoot = $('nodes');
    var podsRoot = $('pods');
    nodesRoot.innerHTML = '';
    podsRoot.innerHTML = '';

    if (state.k8s.error && !state.k8s.data) {
      nodesRoot.appendChild(el('div', 'error', 'Kubernetes から取得できません: ' + state.k8s.error));
      return;
    }
    if (!state.k8s.data) {
      nodesRoot.appendChild(el('div', 'empty', '読み込み中…'));
      return;
    }

    nodes.forEach(function (n) {
      var row = el('div', 'node' + (n.ready ? '' : ' node-notready'));
      row.appendChild(el('span', 'node-name', n.name + (n.ready ? '' : ' ✕')));
      row.appendChild(meter('CPU', n.cpu));
      row.appendChild(meter('MEM', n.mem));
      nodesRoot.appendChild(row);
    });

    if (pods.length === 0) {
      podsRoot.appendChild(el('div', 'empty', 'なし'));
    } else {
      pods.forEach(function (p) {
        var row = el('div', 'pod');
        var name = el('span', 'pod-name');
        name.appendChild(el('span', 'pod-ns', p.ns + '/'));
        name.appendChild(document.createTextNode(p.name));
        row.appendChild(name);
        row.appendChild(el('span', 'pod-reason', p.reason));
        podsRoot.appendChild(row);
      });
    }
  }

  // ---------------------------------------------------------------- summary & staleness

  function renderSummary(groups, nodes, pods) {
    var counts = { up: 0, down: 0, pending: 0, maint: 0, unknown: 0 };
    var downNames = [];
    groups.forEach(function (g) {
      g.monitors.forEach(function (m) {
        counts[m.status] = (counts[m.status] || 0) + 1;
        if (m.status === 'down') downNames.push(m.name);
      });
    });
    var notReady = nodes.filter(function (n) { return !n.ready; }).map(function (n) { return n.name; });

    var box = $('summary');
    var title, detail = [], cls;
    if (!state.kuma.data && !state.k8s.data) {
      cls = 'summary-unknown';
      title = state.kuma.error || state.k8s.error ? '取得できません' : '読み込み中…';
    } else if (downNames.length > 0 || notReady.length > 0) {
      cls = 'summary-down';
      title = (downNames.length + notReady.length) + ' 件の障害';
      if (downNames.length) detail.push('ダウン: ' + downNames.join(', '));
      if (notReady.length) detail.push('ノード停止: ' + notReady.join(', '));
    } else if (counts.pending > 0 || pods.length > 0) {
      cls = 'summary-warn';
      title = '注意';
      if (counts.pending) detail.push('保留中のモニター ' + counts.pending + ' 件');
      if (pods.length) detail.push('問題のある Pod ' + pods.length + ' 件');
    } else {
      cls = 'summary-ok';
      title = 'すべて正常';
      detail.push('モニター ' + counts.up + ' 件 正常' + (counts.maint ? '・メンテナンス ' + counts.maint + ' 件' : ''));
    }
    box.className = 'summary ' + cls;
    $('summary-title').textContent = title;
    $('summary-detail').textContent = detail.join(' / ');
  }

  function renderUpdated(id, src) {
    var t = $(id);
    if (!src.lastOk) { t.textContent = ''; return; }
    t.textContent = (src.error ? '⚠ ' : '') + hhmm(new Date(src.lastOk)) + ' 更新';
  }

  function renderStale() {
    var now = Date.now();
    var stale = [];
    var grace = now - state.startedAt > CONFIG.staleAfterMs;
    [['Uptime Kuma', state.kuma], ['Kubernetes', state.k8s]].forEach(function (pair) {
      var src = pair[1];
      var last = src.lastOk || (grace ? 0 : now);
      if (now - last > CONFIG.staleAfterMs) stale.push(pair[0]);
    });
    var box = $('stale');
    if (stale.length) {
      box.className = 'stale';
      $('stale-text').textContent = stale.join('・') + ' の更新が止まっています';
    } else {
      box.className = 'stale hidden';
    }
  }

  function render() {
    var groups = buildMonitors();
    var nodes = buildNodes();
    var pods = buildProblemPods();
    renderMonitors(groups);
    renderCluster(nodes, pods);
    renderSummary(groups, nodes, pods);
    renderUpdated('monitors-updated', state.kuma);
    renderUpdated('cluster-updated', state.k8s);
    renderStale();
  }

  // ---------------------------------------------------------------- main

  function every(ms, fn) {
    fn();
    setInterval(fn, ms);
  }

  renderClock();
  render();
  every(1000, renderClock);
  every(CONFIG.kumaIntervalMs, loadKuma);
  every(CONFIG.k8sIntervalMs, loadK8s);
  setInterval(renderStale, 10 * 1000);
  setTimeout(function () { location.reload(); }, CONFIG.reloadEveryMs);
})();
