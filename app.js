/* Bot dashboard.
   The ntfy topic is read from location.hash only. Do not write a topic into this file.
*/
(function (factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && document.getElementById && document.getElementById('app')) {
    api.boot();
  }
})(function () {
  'use strict';

  var NTFY_ORIGIN = 'https://ntfy.sh';
  var TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
  var STATUSES = ['working', 'idle', 'waiting_user', 'error', 'done'];
  var SHAPES = ['sphere', 'rounded_cube', 'pill', 'triangle', 'cone', 'pentagon', 'hexagon', 'star4', 'star6', 'clover', 'rounded_square', 'trio'];
  var ACCESSORIES = ['none', 'glasses', 'stem', 'antenna', 'bow'];
  var DEFAULT_COLOR = '#8d867a';
  var STATUS_LABEL = {
    working: 'Working',
    idle: 'Idle',
    waiting_user: 'Waiting',
    error: 'Error',
    done: 'Done'
  };
  var PHASE_LABEL = {
    demo: 'Sample data',
    connecting: 'Connecting',
    live: 'Live',
    reconnecting: 'Reconnecting'
  };
  var NOTICES = {
    denied: 'That topic refused the connection. Retrying.',
    limited: 'ntfy is rate limiting reads. Retrying.',
    missing: 'ntfy did not return a stream for this topic. Retrying.',
    network: 'Cannot reach ntfy. Retrying.'
  };
  var FOOT = {
    demo: 'Sample bots are drawn in this page. Demo mode does not contact ntfy.',
    live: 'Showing about the last 12 hours from ntfy, then live updates. The topic stays in the address hash and is not stored by this site.'
  };
  var H = 3600000;
  var M = 60000;

  function emptyState() {
    return {
      roster: null,
      order: [],
      bots: Object.create(null),
      totalUsedPct: null,
      resetsAt: null,
      latestAt: null
    };
  }

  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function cleanName(value) {
    if (typeof value !== 'string') return null;
    var name = value.trim();
    if (!name || name.length > 64) return null;
    if (/[\u0000-\u001f\u007f]/.test(name)) return null;
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') return null;
    return name;
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  }

  function safeColor(value) {
    if (typeof value !== 'string') return null;
    var match = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
    if (!match) return null;
    return '#' + match[1].toLowerCase();
  }

  function paintColor(value) {
    return safeColor(value) || DEFAULT_COLOR;
  }

  function safeChat(url) {
    if (typeof url !== 'string') return null;
    if (url.length < 'grokbot://'.length + 1 || url.length > 400) return null;
    if (url.indexOf('grokbot://') !== 0) return null;
    if (/[\u0000-\u001f\u007f\s<>"'\\`]/.test(url)) return null;
    return url;
  }

  function usableNumber(value, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
  }

  function topicAllowed(topic) {
    return typeof topic === 'string' && topic !== 'demo' && TOPIC_RE.test(topic);
  }

  function usableId(id) {
    return typeof id === 'string' && /^[-_A-Za-z0-9]{1,64}$/.test(id);
  }

  function parseHash(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw) return '';
    try { return decodeURIComponent(raw).trim(); }
    catch (err) { return raw.trim(); }
  }

  function normalizeTopicInput(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    var hashAt = text.indexOf('#');
    if (hashAt >= 0 && /^https?:\/\//i.test(text)) {
      text = text.slice(hashAt + 1);
      try { text = decodeURIComponent(text); } catch (err) { /* keep raw */ }
    }
    return text.trim().replace(/^#/, '').replace(/\/+$/, '');
  }

  function ntfyUrl(topic, params) {
    if (!topicAllowed(topic)) {
      var bad = new Error('bad topic');
      bad.code = 'bad-topic';
      throw bad;
    }
    var url = new URL('/' + topic + '/json', NTFY_ORIGIN);
    var source = params || {};
    var keys = Object.keys(source).sort();
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key !== 'poll' && key !== 'since') throw new Error('bad query');
      if (key === 'poll' && String(source[key]) !== '1') throw new Error('bad poll');
      url.searchParams.set(key, String(source[key]));
    }
    if (url.origin !== NTFY_ORIGIN || url.username || url.password || url.hash) throw new Error('bad url');
    return url.toString();
  }

  function kindOf(data) {
    if (!plainObject(data)) return null;
    var extra = data.routines != null || data.roster != null || data.looks != null || data.groups != null || data.chat != null;
    if (data.type === 'usage') return extra ? null : 'usage';
    var flags = [data.routines != null, data.roster != null, data.looks != null, data.groups != null, data.chat != null].filter(Boolean).length;
    if (flags > 1) return null;
    if (data.routines != null) return 'routines';
    if (data.roster != null) return 'roster';
    if (data.looks != null) return 'looks';
    if (data.groups != null) return 'groups';
    if (data.chat != null) return 'chat';
    if (typeof data.bot === 'string' && typeof data.status === 'string') return 'status';
    return null;
  }

  function ensure(state, name) {
    var bot = state.bots[name];
    if (!bot) {
      bot = {
        status: null,
        step: '',
        updatedAt: null,
        routines: [],
        look: { shape: 'sphere', color: DEFAULT_COLOR, accessory: 'none' },
        group: null,
        chat: null,
        usage: null
      };
      state.bots[name] = bot;
    }
    return bot;
  }

  function touch(state, name) {
    if (state.order.indexOf(name) === -1) state.order.push(name);
  }

  function stamp(state, timeMs) {
    var t = Number.isFinite(timeMs) ? timeMs : Date.now();
    state.latestAt = Math.max(state.latestAt || 0, t);
    return t;
  }

  function applyPayload(state, payload, timeMs) {
    var kind = kindOf(payload);
    if (!kind) return false;
    if (kind === 'status') {
      var name = cleanName(payload.bot);
      if (!name || STATUSES.indexOf(payload.status) === -1) return false;
      var bot = ensure(state, name);
      bot.status = payload.status;
      bot.step = cleanText(payload.step || '', 180);
      bot.updatedAt = stamp(state, timeMs);
      touch(state, name);
      return true;
    }
    if (kind === 'routines') {
      var block = payload.routines;
      var routineBot = plainObject(block) ? cleanName(block.bot) : null;
      if (!routineBot || !Array.isArray(block.items)) return false;
      var items = [];
      for (var i = 0; i < block.items.length && items.length < 8; i++) {
        var item = block.items[i];
        if (!plainObject(item)) continue;
        var itemName = cleanText(item.name, 80);
        if (!itemName) continue;
        items.push({
          name: itemName,
          schedule: cleanText(item.schedule, 80),
          nextRun: cleanText(item.next_run, 40)
        });
      }
      ensure(state, routineBot).routines = items;
      touch(state, routineBot);
      stamp(state, timeMs);
      return true;
    }
    if (kind === 'roster') {
      if (!Array.isArray(payload.roster)) return false;
      var names = [];
      var seenNames = Object.create(null);
      for (var r = 0; r < payload.roster.length && names.length < 60; r++) {
        var rosterName = cleanName(payload.roster[r]);
        if (!rosterName || seenNames[rosterName]) continue;
        seenNames[rosterName] = true;
        names.push(rosterName);
        ensure(state, rosterName);
        touch(state, rosterName);
      }
      state.roster = names;
      stamp(state, timeMs);
      return true;
    }
    if (kind === 'looks') {
      if (!plainObject(payload.looks)) return false;
      var anyLook = false;
      var lookKeys = Object.keys(payload.looks);
      for (var l = 0; l < lookKeys.length; l++) {
        var lookName = cleanName(lookKeys[l]);
        var look = payload.looks[lookKeys[l]];
        if (!lookName || !plainObject(look)) continue;
        var lookBot = ensure(state, lookName);
        if (SHAPES.indexOf(look.shape) !== -1) lookBot.look.shape = look.shape;
        var color = safeColor(look.color);
        if (color) lookBot.look.color = color;
        if (ACCESSORIES.indexOf(look.accessory) !== -1) lookBot.look.accessory = look.accessory;
        touch(state, lookName);
        anyLook = true;
      }
      if (anyLook) stamp(state, timeMs);
      return anyLook;
    }
    if (kind === 'groups') {
      if (!plainObject(payload.groups)) return false;
      var anyGroup = false;
      var groupKeys = Object.keys(payload.groups);
      for (var g = 0; g < groupKeys.length; g++) {
        var groupBot = cleanName(groupKeys[g]);
        var groupName = cleanText(payload.groups[groupKeys[g]], 32);
        if (!groupBot || !groupName) continue;
        ensure(state, groupBot).group = groupName;
        touch(state, groupBot);
        anyGroup = true;
      }
      if (anyGroup) stamp(state, timeMs);
      return anyGroup;
    }
    if (kind === 'chat') {
      if (!plainObject(payload.chat)) return false;
      var anyChat = false;
      var chatKeys = Object.keys(payload.chat);
      for (var c = 0; c < chatKeys.length; c++) {
        var chatBot = cleanName(chatKeys[c]);
        if (!chatBot || typeof payload.chat[chatKeys[c]] !== 'string') continue;
        ensure(state, chatBot).chat = safeChat(payload.chat[chatKeys[c]]);
        touch(state, chatBot);
        anyChat = true;
      }
      if (anyChat) stamp(state, timeMs);
      return anyChat;
    }
    var anyUsage = false;
    if (usableNumber(payload.total_used_pct, 1000000)) {
      state.totalUsedPct = payload.total_used_pct;
      anyUsage = true;
    }
    if (typeof payload.resets_at === 'string') {
      var reset = cleanText(payload.resets_at, 40);
      if (Number.isFinite(Date.parse(reset))) {
        state.resetsAt = reset;
        anyUsage = true;
      }
    }
    if (plainObject(payload.bots)) {
      var usageKeys = Object.keys(payload.bots);
      for (var u = 0; u < usageKeys.length; u++) {
        var usageName = cleanName(usageKeys[u]);
        if (!usageName || !usableNumber(payload.bots[usageKeys[u]], 1000000)) continue;
        ensure(state, usageName).usage = payload.bots[usageKeys[u]];
        touch(state, usageName);
        anyUsage = true;
      }
    }
    if (anyUsage) stamp(state, timeMs);
    return anyUsage;
  }

  function ingestLine(state, line, seen) {
    var none = { id: '', applied: false };
    if (typeof line !== 'string') return none;
    var trimmed = line.trim();
    if (!trimmed || trimmed.length > 65536) return none;
    var env;
    try { env = JSON.parse(trimmed); } catch (err) { return none; }
    if (!plainObject(env)) return none;
    var id = typeof env.id === 'string' && env.id.length <= 80 ? env.id : '';
    if (id && seen && seen.has(id)) return { id: id, applied: false };
    if (id && seen) seen.add(id);
    if (env.event !== 'message' || typeof env.message !== 'string') return { id: id, applied: false };
    var payload;
    try { payload = JSON.parse(env.message); } catch (err) { return { id: id, applied: false }; }
    var timeMs = typeof env.time === 'number' && Number.isFinite(env.time) ? env.time * 1000 : null;
    return { id: id, applied: applyPayload(state, payload, timeMs) };
  }

  function stateFromLines(lines) {
    var state = emptyState();
    var seen = new Set();
    for (var i = 0; i < lines.length; i++) ingestLine(state, lines[i], seen);
    return state;
  }

  function floorsOf(state) {
    var names = state.roster ? state.roster.slice() : state.order.slice();
    var groups = new Map();
    var unassigned = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var bot = state.bots[name];
      var group = bot && bot.group;
      if (group) {
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(name);
      } else {
        unassigned.push(name);
      }
    }
    if (unassigned.length) {
      if (!groups.has('Unassigned')) groups.set('Unassigned', []);
      var bucket = groups.get('Unassigned');
      for (var u = 0; u < unassigned.length; u++) bucket.push(unassigned[u]);
    }
    var floors = [];
    groups.forEach(function (bots, name) {
      floors.push({ name: name, bots: bots, unassigned: name === 'Unassigned' });
    });
    return floors;
  }

  function formatSpan(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h';
    return Math.round(h / 24) + 'd';
  }

  function formatAgo(ts, now) {
    if (!Number.isFinite(ts)) return 'No update yet';
    var delta = now - ts;
    if (delta < 10000) return 'just now';
    return formatSpan(delta) + ' ago';
  }

  function formatOffset(iso, now) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return { label: '', overdue: false };
    var delta = t - now;
    if (Math.abs(delta) < 15000) return { label: 'due now', overdue: false };
    if (delta >= 0) return { label: 'in ' + formatSpan(delta), overdue: false };
    return { label: formatSpan(-delta) + ' overdue', overdue: true };
  }

  function formatNum(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '–';
    var rounded = Math.round((value + Number.EPSILON) * 10) / 10;
    if (Math.abs(rounded) >= 1000) return String(Math.round(rounded));
    if (Number.isInteger(rounded)) return String(rounded);
    return rounded.toFixed(1);
  }

  function formatReset(iso) {
    if (typeof iso !== 'string') return null;
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(new Date(t));
  }

  function demoLines(now) {
    var lines = [];
    function msg(id, delta, payload) {
      lines.push(JSON.stringify({
        id: id,
        time: Math.floor((now + delta) / 1000),
        event: 'message',
        message: JSON.stringify(payload)
      }));
    }
    lines.push('not-json');
    lines.push(JSON.stringify({ id: 'ka', time: Math.floor(now / 1000), event: 'keepalive' }));
    msg('bad-json', -120000, { hello: true });
    msg('roster', -110000, {
      roster: ['Atlas', 'Beacon', 'Quill', 'Nova', 'Moss', 'Prism', 'Lumen', 'Harbor', 'Forge', 'Nimbus', 'Pixel', 'Wren']
    });
    msg('ghost', -108000, { bot: 'Ghost', status: 'error', step: 'should stay hidden' });
    msg('looks-1', -100000, { looks: { Atlas: { shape: 'sphere', color: '#111111', accessory: 'none' } } });
    msg('looks-2', -99000, {
      looks: {
        Atlas: { shape: 'sphere', color: '#2D84F5', accessory: 'glasses' },
        Beacon: { shape: 'rounded_cube', color: '#E09A2B', accessory: 'antenna' },
        Quill: { shape: 'pill', color: '#7A5AF8', accessory: 'bow' },
        Nova: { shape: 'star6', color: '#E15A8A', accessory: 'none' },
        Moss: { shape: 'clover', color: '#2F9B6A', accessory: 'stem' },
        Prism: { shape: 'hexagon', color: '#1497A6', accessory: 'glasses' },
        Lumen: { shape: 'triangle', color: '#E4572E', accessory: 'none' },
        Harbor: { shape: 'cone', color: '#4C6A8A', accessory: 'none' },
        Forge: { shape: 'pentagon', color: '#D24B4B', accessory: 'none' },
        Nimbus: { shape: 'rounded_square', color: '#7D62D9', accessory: 'antenna' },
        Pixel: { shape: 'star4', color: '#EF8A4C', accessory: 'bow' },
        Wren: { shape: 'trio', color: '#2F6D4F', accessory: 'stem' }
      }
    });
    msg('looks-bad', -98000, { looks: { Atlas: { shape: 'nope', color: 'red', accessory: 'script' } } });
    msg('groups-1', -97000, { groups: { Atlas: 'Holding', Beacon: 'Ops' } });
    msg('groups-2', -96000, {
      groups: {
        Atlas: 'Ops', Quill: 'Ops',
        Nova: 'Research', Moss: 'Research', Prism: 'Research',
        Lumen: 'Support', Harbor: 'Support',
        Forge: 'Build', Nimbus: 'Build', Pixel: 'Build', Wren: 'Build'
      }
    });
    msg('chat-1', -95000, {
      chat: {
        Atlas: 'grokbot://app/v1/agent?id=atlas',
        Harbor: 'grokbot://app/v1/agent?id=harbor'
      }
    });
    msg('chat-2', -94000, {
      chat: {
        Harbor: 'https://example.com/not-allowed',
        Nimbus: 'javascript:alert(1)',
        Moss: 'GROKBOT://nope',
        Beacon: 'grokbot://app/v1/agent?id=beacon',
        Quill: 'grokbot://app/v1/agent?id=quill',
        Nova: 'grokbot://app/v1/agent?id=nova',
        Lumen: 'grokbot://app/v1/agent?id=lumen',
        Forge: 'grokbot://app/v1/agent?id=forge',
        Pixel: 'grokbot://app/v1/agent?id=pixel',
        Wren: 'grokbot://app/v1/agent?id=wren'
      }
    });
    msg('st-old', -H, { bot: 'Atlas', status: 'idle', step: 'Old step that should be replaced' });
    msg('st-atlas', -45000, { bot: 'Atlas', status: 'working', step: 'Checking deploy diffs' });
    msg('st-bad', -44000, { bot: 'Atlas', status: 'pwned', step: 'should not apply' });
    msg('st-beacon', -4 * M, { bot: 'Beacon', status: 'idle', step: 'Watching the queue' });
    msg('st-quill', -12 * M, { bot: 'Quill', status: 'waiting_user', step: 'Needs a yes on the copy' });
    msg('st-nova', -2 * M, { bot: 'Nova', status: 'working', step: 'Reading the new papers' });
    msg('st-moss', -3 * H, { bot: 'Moss', status: 'done', step: 'Notes filed' });
    msg('st-prism', -26 * M, { bot: 'Prism', status: 'idle', step: 'Idle between runs' });
    msg('st-lumen', -M, { bot: 'Lumen', status: 'error', step: 'Webhook timed out' });
    msg('st-harbor', -18 * M, { bot: 'Harbor', status: 'waiting_user', step: 'Waiting on a screenshot' });
    msg('st-forge', -8 * M, { bot: 'Forge', status: 'working', step: 'Compiling the patch' });
    msg('st-nimbus', -2 * H, { bot: 'Nimbus', status: 'idle', step: 'Cloud is quiet' });
    msg('st-pixel', -5 * H, { bot: 'Pixel', status: 'done', step: 'Icons exported' });
    msg('st-wren', -20000, { bot: 'Wren', status: 'working', step: 'Drafting the changelog' });
    msg('rt-atlas', -90000, {
      routines: {
        bot: 'Atlas',
        items: [
          { name: 'Morning sweep', schedule: 'weekdays 08:00', next_run: new Date(now + 2 * H).toISOString() },
          { name: 'Incident digest', schedule: 'hourly', next_run: new Date(now + 25 * M).toISOString() }
        ]
      }
    });
    msg('rt-beacon', -89000, { routines: { bot: 'Beacon', items: [{ name: 'Queue scan', schedule: 'every 15 min', next_run: new Date(now + 8 * M).toISOString() }] } });
    msg('rt-nova', -88000, { routines: { bot: 'Nova', items: [{ name: 'Literature pass', schedule: 'daily 07:30', next_run: new Date(now + 14 * H).toISOString() }] } });
    msg('rt-prism', -87000, { routines: { bot: 'Prism', items: [{ name: 'Citation check', schedule: 'weekly', next_run: new Date(now + 50 * H).toISOString() }] } });
    msg('rt-lumen', -86000, { routines: { bot: 'Lumen', items: [{ name: 'Inbox triage', schedule: 'every 30 min', next_run: new Date(now - 6 * M).toISOString() }] } });
    msg('rt-forge', -85000, { routines: { bot: 'Forge', items: [{ name: 'Nightly build', schedule: 'daily 01:00', next_run: new Date(now + 6 * H).toISOString() }] } });
    msg('rt-wren', -84000, { routines: { bot: 'Wren', items: [{ name: 'Changelog', schedule: 'weekdays 16:00', next_run: new Date(now + 3 * H).toISOString() }] } });
    msg('use-1', -70000, { type: 'usage', total_used_pct: 11, resets_at: 'not-a-date', bots: { Atlas: 1, Beacon: 4.1 } });
    msg('use-2', -60000, {
      type: 'usage',
      total_used_pct: 37,
      resets_at: new Date(now + 3 * 24 * H).toISOString(),
      bots: {
        Atlas: 8.2, Quill: 2.4, Nova: 6.5, Moss: 1.2, Prism: 3.3,
        Lumen: 5, Harbor: 1.8, Forge: 9.4, Nimbus: 2, Pixel: 0.8, Wren: 3.6
      }
    });
    return lines;
  }

  function summary(state) {
    var floors = floorsOf(state);
    var bots = 0;
    for (var i = 0; i < floors.length; i++) bots += floors[i].bots.length;
    if (!bots) return 'No bots yet';
    return bots + (bots === 1 ? ' bot' : ' bots') + ' · ' + floors.length + (floors.length === 1 ? ' floor' : ' floors');
  }

  function maxUsage(state, floors) {
    var max = 0;
    for (var i = 0; i < floors.length; i++) {
      var bots = floors[i].bots;
      for (var b = 0; b < bots.length; b++) {
        var value = state.bots[bots[b]] && state.bots[bots[b]].usage;
        if (typeof value === 'number' && value > max) max = value;
      }
    }
    return max;
  }

  function h(tag, props, kids) {
    var node = document.createElement(tag);
    applyProps(node, props);
    appendKids(node, kids);
    return node;
  }

  function svgEl(tag, props, kids) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    applyProps(node, props);
    appendKids(node, kids);
    return node;
  }

  function applyProps(node, props) {
    if (!props) return;
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = props[key];
      if (value == null || value === false) continue;
      if (key === 'text') node.textContent = String(value);
      else if (key === 'className') node.setAttribute('class', String(value));
      else node.setAttribute(key, String(value));
    }
  }

  function appendKids(node, kids) {
    if (!kids) return;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid == null || kid === false) continue;
      node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    function ch(c) { return Math.max(0, Math.min(255, c + amt)); }
    var parts = [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
    return '#' + parts.map(function (c) { return c.toString(16).padStart(2, '0'); }).join('');
  }

  function inkFor(hex) {
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.62 ? '#1c1916' : '#fffdf8';
  }

  function round(n) { return Math.round(n * 10) / 10; }

  function pointsAttr(pairs) {
    return pairs.map(function (p) { return round(p[0]) + ',' + round(p[1]); }).join(' ');
  }

  function regular(cx, cy, radius, n, rot) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = rot + (i * 2 * Math.PI) / n;
      pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    return pts;
  }

  function star(cx, cy, outer, inner, n) {
    var pts = [];
    for (var i = 0; i < n * 2; i++) {
      var radius = i % 2 === 0 ? outer : inner;
      var a = -Math.PI / 2 + (i * Math.PI) / n;
      pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
    }
    return pts;
  }

  function stroked(extra, color) {
    var props = {
      fill: color,
      stroke: '#1c1916',
      'stroke-width': '1.6',
      'stroke-linejoin': 'round'
    };
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) props[keys[i]] = extra[keys[i]];
    return props;
  }

  function avatarLabel(look) {
    var shape = SHAPES.indexOf(look.shape) === -1 ? 'sphere' : look.shape;
    var accessory = ACCESSORIES.indexOf(look.accessory) === -1 ? 'none' : look.accessory;
    return accessory === 'none' ? shape + ' avatar' : shape + ' avatar with ' + accessory;
  }

  function makeAvatar(look) {
    var safe = {
      shape: SHAPES.indexOf(look && look.shape) === -1 ? 'sphere' : look.shape,
      color: paintColor(look && look.color),
      accessory: ACCESSORIES.indexOf(look && look.accessory) === -1 ? 'none' : look.accessory
    };
    var svg = svgEl('svg', {
      viewBox: '0 0 64 64',
      className: 'avatar',
      role: 'img',
      'aria-label': avatarLabel(safe),
      focusable: 'false'
    });
    drawAvatar(svg, safe);
    return svg;
  }

  function drawAvatar(svg, look) {
    var color = look.color;
    svg.appendChild(svgEl('ellipse', { cx: '32', cy: '58', rx: '14', ry: '2.4', fill: '#1c1916', opacity: '0.1' }));
    if (look.shape === 'sphere') {
      svg.appendChild(svgEl('circle', stroked({ cx: '32', cy: '36', r: '16' }, color)));
      svg.appendChild(svgEl('ellipse', { cx: '26', cy: '30', rx: '6', ry: '4', fill: '#ffffff', opacity: '0.38' }));
    } else if (look.shape === 'rounded_cube') {
      svg.appendChild(svgEl('rect', stroked({ x: '14', y: '16', width: '30', height: '30', rx: '7' }, shade(color, -28))));
      svg.appendChild(svgEl('rect', stroked({ x: '20', y: '22', width: '30', height: '30', rx: '7' }, color)));
    } else if (look.shape === 'pill') {
      svg.appendChild(svgEl('rect', stroked({ x: '14', y: '24', width: '36', height: '22', rx: '11' }, color)));
      svg.appendChild(svgEl('ellipse', { cx: '24', cy: '32', rx: '5', ry: '3', fill: '#ffffff', opacity: '0.35' }));
    } else if (look.shape === 'triangle') {
      svg.appendChild(svgEl('polygon', stroked({ points: '32,16 52,52 12,52' }, color)));
    } else if (look.shape === 'cone') {
      svg.appendChild(svgEl('polygon', stroked({ points: '32,14 50,46 14,46' }, color)));
      svg.appendChild(svgEl('ellipse', stroked({ cx: '32', cy: '46', rx: '18', ry: '6' }, shade(color, -18))));
    } else if (look.shape === 'pentagon') {
      svg.appendChild(svgEl('polygon', stroked({ points: pointsAttr(regular(32, 36, 18, 5, -Math.PI / 2)) }, color)));
    } else if (look.shape === 'hexagon') {
      svg.appendChild(svgEl('polygon', stroked({ points: pointsAttr(regular(32, 36, 18, 6, 0)) }, color)));
    } else if (look.shape === 'star4') {
      svg.appendChild(svgEl('polygon', stroked({ points: pointsAttr(star(32, 36, 18, 7, 4)) }, color)));
    } else if (look.shape === 'star6') {
      svg.appendChild(svgEl('polygon', stroked({ points: pointsAttr(star(32, 36, 18, 8, 6)) }, color)));
    } else if (look.shape === 'clover') {
      var leaves = [[32, 24], [21, 35], [43, 35], [32, 44]];
      for (var i = 0; i < leaves.length; i++) {
        svg.appendChild(svgEl('circle', stroked({ cx: String(leaves[i][0]), cy: String(leaves[i][1]), r: '9' }, color)));
      }
    } else if (look.shape === 'rounded_square') {
      svg.appendChild(svgEl('rect', stroked({ x: '16', y: '18', width: '32', height: '32', rx: '10' }, color)));
      svg.appendChild(svgEl('ellipse', { cx: '26', cy: '28', rx: '5', ry: '3', fill: '#ffffff', opacity: '0.3' }));
    } else {
      var dots = [[32, 22], [21, 40], [43, 40]];
      for (var d = 0; d < dots.length; d++) {
        svg.appendChild(svgEl('circle', stroked({ cx: String(dots[d][0]), cy: String(dots[d][1]), r: '9' }, color)));
      }
    }
    drawAccessory(svg, look);
  }

  function drawAccessory(svg, look) {
    var accessory = look.accessory;
    if (accessory === 'none') return;
    var color = look.color;
    var ink = inkFor(color);
    var tops = {
      sphere: 20, rounded_cube: 16, pill: 24, triangle: 16, cone: 14,
      pentagon: 18, hexagon: 18, star4: 16, star6: 16, clover: 16,
      rounded_square: 18, trio: 16
    };
    var top = tops[look.shape] || 18;
    if (accessory === 'glasses') {
      svg.appendChild(svgEl('circle', { cx: '24', cy: '36', r: '6', fill: 'none', stroke: ink, 'stroke-width': '1.8' }));
      svg.appendChild(svgEl('circle', { cx: '40', cy: '36', r: '6', fill: 'none', stroke: ink, 'stroke-width': '1.8' }));
      svg.appendChild(svgEl('path', { d: 'M30 36 H34', fill: 'none', stroke: ink, 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
    } else if (accessory === 'stem') {
      svg.appendChild(svgEl('path', {
        d: 'M32 ' + top + ' V' + (top - 10),
        fill: 'none', stroke: '#1c1916', 'stroke-width': '1.7', 'stroke-linecap': 'round'
      }));
      svg.appendChild(svgEl('ellipse', {
        cx: '36', cy: String(top - 12), rx: '5', ry: '3.1',
        fill: '#2f9b6a', stroke: '#1c1916', 'stroke-width': '1.2',
        transform: 'rotate(-28 36 ' + (top - 12) + ')'
      }));
    } else if (accessory === 'antenna') {
      svg.appendChild(svgEl('path', {
        d: 'M32 ' + (top + 1) + ' V8',
        fill: 'none', stroke: '#1c1916', 'stroke-width': '1.7', 'stroke-linecap': 'round'
      }));
      svg.appendChild(svgEl('circle', { cx: '32', cy: '6.5', r: '3.2', fill: color, stroke: '#1c1916', 'stroke-width': '1.4' }));
    } else if (accessory === 'bow') {
      var y = top + 1;
      svg.appendChild(svgEl('path', {
        d: 'M32 ' + y +
          ' C27 ' + (y - 7) + ' 20 ' + (y - 3) + ' 24 ' + (y + 1) +
          ' C20 ' + (y + 6) + ' 27 ' + (y + 8) + ' 32 ' + (y + 2) +
          ' C37 ' + (y + 8) + ' 44 ' + (y + 6) + ' 40 ' + (y + 1) +
          ' C44 ' + (y - 3) + ' 37 ' + (y - 7) + ' 32 ' + y,
        fill: ink
      }));
      svg.appendChild(svgEl('circle', {
        cx: '32', cy: String(y + 1), r: '2',
        fill: ink === '#1c1916' ? '#fffdf8' : '#1c1916'
      }));
    }
  }

  function mark() {
    return svgEl('svg', { viewBox: '0 0 48 48', className: 'mark', 'aria-hidden': 'true', focusable: 'false' }, [
      svgEl('rect', { width: '48', height: '48', rx: '14', fill: '#e4f08a' }),
      svgEl('circle', { cx: '18', cy: '24', r: '7', fill: '#1c1916' }),
      svgEl('rect', { x: '26', y: '17', width: '12', height: '14', rx: '4', fill: '#1c1916' })
    ]);
  }

  function meterSvg(pct, track, bar, label) {
    var width = pct > 0 ? Math.max(2, Math.min(100, pct)) : 0;
    var svg = svgEl('svg', {
      viewBox: '0 0 100 8',
      preserveAspectRatio: 'none',
      className: 'meter',
      role: 'meter',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(Math.round(width)),
      'aria-label': label,
      focusable: 'false'
    });
    svg.appendChild(svgEl('rect', { x: '0', y: '0', width: '100', height: '8', fill: track }));
    if (width > 0) {
      svg.appendChild(svgEl('rect', { x: '0', y: '0', width: String(round(width)), height: '8', fill: bar }));
    }
    return svg;
  }

  function badge(status) {
    var known = STATUSES.indexOf(status) !== -1;
    var key = known ? status : 'idle';
    var el = h('p', { className: 'badge badge-' + key });
    if (key === 'working') {
      var pulse = h('span', { className: 'pulse', 'aria-hidden': 'true' });
      el.appendChild(pulse);
    }
    el.appendChild(document.createTextNode(known ? STATUS_LABEL[status] : 'No status'));
    return el;
  }

  function renderRoutines(items, now) {
    var wrap = h('div', { className: 'routines' });
    wrap.appendChild(h('p', { className: 'kicker', text: 'Routines' }));
    if (!items || !items.length) {
      wrap.appendChild(h('p', { className: 'muted', text: 'None scheduled' }));
      return wrap;
    }
    var list = h('ul', { className: 'routine-list' });
    var shown = items.slice(0, 3);
    for (var i = 0; i < shown.length; i++) {
      var item = shown[i];
      var li = h('li', { className: 'routine' });
      var row = h('div', { className: 'routine-row' });
      row.appendChild(h('span', { className: 'routine-name', text: item.name }));
      var when = formatOffset(item.nextRun, now);
      var whenEl = h('span', {
        className: when.overdue ? 'routine-when overdue' : 'routine-when',
        text: when.label || 'unscheduled'
      });
      if (item.nextRun && when.label) whenEl.setAttribute('data-next', item.nextRun);
      row.appendChild(whenEl);
      li.appendChild(row);
      if (item.schedule) li.appendChild(h('p', { className: 'routine-sched', text: item.schedule }));
      list.appendChild(li);
    }
    wrap.appendChild(list);
    if (items.length > 3) wrap.appendChild(h('p', { className: 'muted', text: (items.length - 3) + ' more' }));
    return wrap;
  }

  function renderUsage(value, max) {
    var wrap = h('div', { className: 'usage' });
    var row = h('div', { className: 'usage-row' });
    row.appendChild(h('span', { className: 'kicker', text: 'Usage' }));
    row.appendChild(h('span', { className: 'usage-val', text: value == null ? '–' : formatNum(value) }));
    wrap.appendChild(row);
    var pct = value != null && max > 0 ? (value / max) * 100 : 0;
    wrap.appendChild(meterSvg(pct, '#efe8dc', '#1c1916', 'Share of the busiest bot'));
    return wrap;
  }

  function renderBot(name, bot, max, now) {
    var card = h('article', { className: bot.chat ? 'card has-chat' : 'card', translate: 'no' });
    var head = h('div', { className: 'card-head' });
    head.appendChild(makeAvatar(bot.look));
    var idCol = h('div', { className: 'id' });
    var nameEl = h('h3', { className: 'name', text: name });
    nameEl.setAttribute('title', name);
    idCol.appendChild(nameEl);
    idCol.appendChild(badge(bot.status));
    head.appendChild(idCol);
    card.appendChild(head);
    var step = h('p', { className: 'step', text: bot.step || 'No step reported' });
    if (bot.step) step.setAttribute('title', bot.step);
    card.appendChild(step);
    var when = h('p', {
      className: 'when',
      text: bot.updatedAt ? formatAgo(bot.updatedAt, now) : 'No update yet'
    });
    if (bot.updatedAt) when.setAttribute('data-updated', String(bot.updatedAt));
    card.appendChild(when);
    card.appendChild(renderRoutines(bot.routines, now));
    card.appendChild(renderUsage(bot.usage, max));
    if (bot.chat) {
      var link = h('a', { className: 'chat', href: bot.chat, rel: 'noreferrer' });
      link.appendChild(document.createTextNode('Open chat'));
      var sr = h('span', { className: 'sr', text: ' for ' + name });
      link.appendChild(sr);
      card.appendChild(link);
    }
    return card;
  }

  function toneClass(index, unassigned) {
    if (unassigned) return 'tone-u';
    return 'tone-' + (index % 6);
  }

  function renderGate(root, model, handlers) {
    var main = h('main', { className: 'wrap' });
    var card = h('section', { className: 'gate' });
    card.appendChild(mark());
    card.appendChild(h('h1', { text: 'Bot dashboard' }));
    card.appendChild(h('p', { className: 'lede', text: 'A floor for each team, and a small avatar for each assistant.' }));
    var preview = h('div', { className: 'preview', 'aria-hidden': 'true' });
    var samples = [
      { shape: 'sphere', color: '#2d84f5', accessory: 'glasses' },
      { shape: 'clover', color: '#2f9b6a', accessory: 'stem' },
      { shape: 'star4', color: '#ef8a4c', accessory: 'bow' }
    ];
    for (var i = 0; i < samples.length; i++) preview.appendChild(makeAvatar(samples[i]));
    card.appendChild(preview);
    var form = h('form', { className: 'gate-row' });
    var label = h('label', { className: 'sr', for: 'topic', text: 'ntfy topic' });
    var input = h('input', {
      id: 'topic',
      type: 'text',
      maxlength: '300',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      placeholder: 'ntfy topic',
      'aria-describedby': model.gateError ? 'topic-hint topic-error' : 'topic-hint'
    });
    if (model.gateError) input.setAttribute('aria-invalid', 'true');
    var button = h('button', { type: 'submit', text: 'Open' });
    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(button);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (handlers.onTopic) handlers.onTopic(input.value);
    });
    card.appendChild(form);
    card.appendChild(h('p', {
      className: 'hint',
      id: 'topic-hint',
      text: 'The topic stays in the address bar after # and is sent only to ntfy.sh. Anyone who knows an ntfy topic can read it, so treat the name like a password.'
    }));
    if (model.gateError) {
      card.appendChild(h('p', {
        className: 'gate-error',
        id: 'topic-error',
        text: 'Use 1–64 letters, numbers, hyphens, or underscores.'
      }));
    }
    var demo = h('a', { className: 'demo-link', href: '#demo', text: 'Preview with sample bots' });
    card.appendChild(demo);
    main.appendChild(card);
    root.appendChild(main);
  }

  function renderBoard(root, model, handlers, now) {
    var state = model.state;
    var floors = floorsOf(state);
    var main = h('main', { className: 'wrap' });
    var top = h('header', { className: 'top' });
    var brand = h('div', { className: 'brand' });
    var row = h('div', { className: 'brand-row' });
    row.appendChild(mark());
    var titles = h('div');
    titles.appendChild(h('h1', { className: 'word', text: 'Bot dashboard' }));
    var sub = h('div', { className: 'sub sub-row' });
    var phase = PHASE_LABEL[model.phase] ? model.phase : 'live';
    var pill = h('p', { className: 'pill pill-' + phase });
    if (phase === 'live' || phase === 'demo') pill.appendChild(h('span', { className: 'dot', 'aria-hidden': 'true' }));
    pill.appendChild(document.createTextNode(PHASE_LABEL[phase]));
    sub.appendChild(pill);
    sub.appendChild(h('span', { text: summary(state) }));
    titles.appendChild(sub);
    if (state.latestAt) {
      var last = h('p', { className: 'sub' });
      last.appendChild(document.createTextNode('Last message '));
      last.appendChild(h('span', { text: formatAgo(state.latestAt, now), 'data-updated': String(state.latestAt) }));
      titles.appendChild(last);
    }
    row.appendChild(titles);
    brand.appendChild(row);
    var change = h('button', { type: 'button', className: 'text-btn', text: 'Change topic' });
    change.addEventListener('click', function () { if (handlers.onClear) handlers.onClear(); });
    brand.appendChild(change);
    if (NOTICES[model.notice]) brand.appendChild(h('p', { className: 'notice', text: NOTICES[model.notice] }));
    top.appendChild(brand);

    var quota = h('div', { className: 'quota' });
    quota.appendChild(h('p', { className: 'kicker kicker-light', text: 'Weekly quota' }));
    var big = h('p', { className: 'quota-num' });
    big.appendChild(document.createTextNode(state.totalUsedPct == null ? '–' : formatNum(state.totalUsedPct)));
    if (state.totalUsedPct != null) big.appendChild(h('span', { className: 'unit', text: '%' }));
    quota.appendChild(big);
    var reset = formatReset(state.resetsAt);
    quota.appendChild(h('p', { className: 'reset', text: reset ? 'Resets ' + reset : 'No reset time yet' }));
    if (state.totalUsedPct != null) {
      quota.appendChild(meterSvg(Math.max(0, Math.min(100, state.totalUsedPct)), '#3a342c', '#e4f08a', 'Weekly quota used'));
    }
    top.appendChild(quota);
    main.appendChild(top);

    if (!floors.length) {
      var emptyText = state.roster && state.roster.length === 0
        ? 'The roster is empty.'
        : 'No messages yet in the 12-hour window.';
      main.appendChild(h('p', { className: 'empty', text: emptyText }));
    } else {
      var busiest = maxUsage(state, floors);
      for (var i = 0; i < floors.length; i++) {
        var floor = floors[i];
        var section = h('section', { className: 'floor' });
        var team = h('div', { className: 'team ' + toneClass(i, floor.unassigned) });
        var teamHead = h('div', { className: 'team-head' });
        teamHead.appendChild(h('p', { className: 'team-no', text: String(i + 1).padStart(2, '0') }));
        teamHead.appendChild(h('p', { className: 'kicker', text: 'Floor' }));
        var teamName = h('h2', { className: 'team-name', text: floor.name });
        teamName.setAttribute('translate', 'no');
        teamHead.appendChild(teamName);
        team.appendChild(teamHead);
        team.appendChild(h('p', {
          className: 'team-count',
          text: floor.bots.length + (floor.bots.length === 1 ? ' bot' : ' bots')
        }));
        section.appendChild(team);
        var scroller = h('div', { className: 'floor-bots' });
        scroller.setAttribute('data-floor', floor.name);
        for (var b = 0; b < floor.bots.length; b++) {
          var botName = floor.bots[b];
          scroller.appendChild(renderBot(botName, state.bots[botName], busiest, now));
        }
        section.appendChild(scroller);
        main.appendChild(section);
      }
    }
    main.appendChild(h('p', { className: 'foot', text: model.phase === 'demo' ? FOOT.demo : FOOT.live }));
    root.appendChild(main);
  }

  function paint(root, model, handlers) {
    var now = Number.isFinite(model.now) ? model.now : Date.now();
    clear(root);
    var phase = model.phase || 'gate';
    root.setAttribute('data-phase', phase);
    if (phase === 'gate') renderGate(root, model, handlers || {});
    else renderBoard(root, model, handlers || {}, now);
    var links = root.querySelectorAll('a.chat');
    for (var i = 0; i < links.length; i++) {
      if (!safeChat(links[i].getAttribute('href') || '')) links[i].remove();
    }
  }

  var view = {
    phase: 'gate',
    state: emptyState(),
    gateError: false,
    notice: ''
  };
  var generation = 0;
  var controller = null;
  var renderTimer = 0;
  var booted = false;

  function render() {
    var root = document.getElementById('app');
    if (!root) return;
    var prev = root.querySelector('#topic');
    var typed = prev ? prev.value : '';
    var y = window.scrollY || 0;
    var left = new Map();
    var scrollers = root.querySelectorAll('[data-floor]');
    for (var i = 0; i < scrollers.length; i++) left.set(scrollers[i].getAttribute('data-floor'), scrollers[i].scrollLeft);
    try {
      paint(root, view, { onTopic: openTopic, onClear: clearHash });
    } catch (err) {
      clear(root);
      root.setAttribute('data-phase', 'error');
      root.appendChild(h('p', { className: 'empty', text: 'The board could not draw this update.' }));
      return;
    }
    var next = root.querySelectorAll('[data-floor]');
    for (var s = 0; s < next.length; s++) {
      var key = next[s].getAttribute('data-floor');
      if (left.has(key)) next[s].scrollLeft = left.get(key);
    }
    var input = root.querySelector('#topic');
    if (input && typed) {
      input.value = typed;
      if (view.gateError) input.focus();
    }
    if (y) window.scrollTo(0, y);
  }

  function scheduleRender(gen) {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = 0;
      if (gen !== generation) return;
      render();
    }, 40);
  }

  function stop() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = 0;
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function tick() {
    if (view.phase === 'gate') return;
    var now = Date.now();
    var updated = document.querySelectorAll('[data-updated]');
    for (var i = 0; i < updated.length; i++) {
      updated[i].textContent = formatAgo(Number(updated[i].getAttribute('data-updated')), now);
    }
    var upcoming = document.querySelectorAll('[data-next]');
    for (var n = 0; n < upcoming.length; n++) {
      var info = formatOffset(upcoming[n].getAttribute('data-next'), now);
      upcoming[n].textContent = info.label || 'unscheduled';
      upcoming[n].classList.toggle('overdue', info.overdue);
    }
  }

  function readHash() { return parseHash(location.hash); }

  function openTopic(raw) {
    var topic = normalizeTopicInput(raw);
    if (!topic) {
      view.phase = 'gate';
      view.gateError = true;
      render();
      return;
    }
    if (topic === 'demo') {
      location.hash = 'demo';
      return;
    }
    if (!topicAllowed(topic)) {
      view.phase = 'gate';
      view.gateError = true;
      view.state = emptyState();
      render();
      return;
    }
    location.hash = topic;
  }

  function clearHash() {
    try { history.pushState(null, '', location.pathname + location.search); }
    catch (err) { location.hash = ''; }
    route();
  }

  function fetchOpts(signal) {
    return {
      signal: signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors'
    };
  }

  function statusError(status) {
    var err = new Error('http');
    err.status = status;
    return err;
  }

  function noticeCode(err) {
    var status = err && err.status;
    if (status === 429) return 'limited';
    if (status === 401 || status === 403) return 'denied';
    if (status === 404) return 'missing';
    return 'network';
  }

  function discard(res) {
    try { if (res && res.body && res.body.cancel) return res.body.cancel(); }
    catch (err) { /* ignore */ }
    return Promise.resolve();
  }

  function withTimeout(signal, ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
    }
    return signal;
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        var err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function consume(state, seen, text) {
    var last = '';
    var applied = false;
    var parts = String(text || '').split('\n');
    for (var i = 0; i < parts.length; i++) {
      var result = ingestLine(state, parts[i], seen);
      if (usableId(result.id)) last = result.id;
      if (result.applied) applied = true;
    }
    return { last: last, applied: applied };
  }

  async function pollHistory(topic, since, signal, seen, gen) {
    var res = await fetch(ntfyUrl(topic, { poll: '1', since: since || '12h' }), fetchOpts(withTimeout(signal, 20000)));
    if (gen !== generation || signal.aborted) {
      await discard(res);
      return '';
    }
    if (!res.ok) {
      await discard(res);
      throw statusError(res.status);
    }
    var text = await res.text();
    if (gen !== generation || signal.aborted) return '';
    var result = consume(view.state, seen, text);
    if (result.applied && gen === generation) {
      view.phase = 'live';
      view.notice = '';
      render();
    }
    return result.last;
  }

  async function readNdjson(res, signal, seen, gen) {
    if (!res.body || typeof res.body.getReader !== 'function') throw statusError(0);
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var last = '';
    try {
      while (!signal.aborted && gen === generation) {
        var chunk = await reader.read();
        if (chunk.done) {
          buf += decoder.decode();
          var tail = consume(view.state, seen, buf);
          if (usableId(tail.last)) last = tail.last;
          if (tail.applied) scheduleRender(gen);
          break;
        }
        buf += decoder.decode(chunk.value, { stream: true });
        var nl = buf.lastIndexOf('\n');
        if (nl === -1) continue;
        var ready = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        var result = consume(view.state, seen, ready);
        if (usableId(result.last)) last = result.last;
        if (result.applied) scheduleRender(gen);
      }
    } finally {
      try { reader.releaseLock(); } catch (err) { /* ignore */ }
    }
    return last;
  }

  async function runNetwork(topic, signal, gen) {
    var lastId = '';
    var backoff = 700;
    var seen = new Set();
    while (!signal.aborted && gen === generation) {
      var since = usableId(lastId) ? lastId : '12h';
      try {
        var polled = await pollHistory(topic, since, signal, seen, gen);
        if (gen !== generation || signal.aborted) return;
        if (usableId(polled)) lastId = polled;
        var streamSince = usableId(lastId) ? lastId : '12h';
        var res = await fetch(ntfyUrl(topic, { since: streamSince }), fetchOpts(signal));
        if (gen !== generation || signal.aborted) {
          await discard(res);
          return;
        }
        if (!res.ok) {
          await discard(res);
          throw statusError(res.status);
        }
        view.phase = 'live';
        view.notice = '';
        if (gen === generation) render();
        var streamed = await readNdjson(res, signal, seen, gen);
        if (gen !== generation || signal.aborted) return;
        if (usableId(streamed)) lastId = streamed;
        view.phase = 'reconnecting';
        view.notice = '';
        if (gen === generation) render();
      } catch (err) {
        if (gen !== generation || signal.aborted || (err && err.name === 'AbortError')) return;
        view.phase = 'reconnecting';
        view.notice = noticeCode(err);
        if (gen === generation) render();
      }
      if (gen !== generation || signal.aborted) return;
      try { await sleep(backoff, signal); }
      catch (err) { return; }
      backoff = Math.min(20000, Math.round(backoff * 1.8));
    }
  }

  function route() {
    var gen = ++generation;
    stop();
    var topic = readHash();
    view.gateError = false;
    view.notice = '';
    if (!topic) {
      view.phase = 'gate';
      view.state = emptyState();
      render();
      return;
    }
    if (topic === 'demo') {
      view.phase = 'demo';
      view.state = stateFromLines(demoLines(Date.now()));
      render();
      return;
    }
    if (!topicAllowed(topic)) {
      view.phase = 'gate';
      view.gateError = true;
      view.state = emptyState();
      render();
      return;
    }
    view.phase = 'connecting';
    view.state = emptyState();
    render();
    controller = new AbortController();
    runNetwork(topic, controller.signal, gen);
  }

  function boot() {
    if (booted) return;
    booted = true;
    window.addEventListener('hashchange', route);
    window.addEventListener('popstate', route);
    setInterval(tick, 15000);
    route();
  }

  return {
    boot: boot,
    emptyState: emptyState,
    applyPayload: applyPayload,
    ingestLine: ingestLine,
    stateFromLines: stateFromLines,
    demoLines: demoLines,
    floorsOf: floorsOf,
    safeChat: safeChat,
    safeColor: safeColor,
    kindOf: kindOf,
    topicAllowed: topicAllowed,
    parseHash: parseHash,
    normalizeTopicInput: normalizeTopicInput,
    ntfyUrl: ntfyUrl,
    formatAgo: formatAgo,
    formatOffset: formatOffset,
    formatNum: formatNum,
    formatReset: formatReset,
    paint: paint
  };
});
