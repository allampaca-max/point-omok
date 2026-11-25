/* 포인트오목 — 화면과 네트워크.
 *
 * 구조
 *  - 방을 만든 사람(방장)의 브라우저가 게임 상태 전체를 들고 판정한다(GameHost).
 *  - 두 사람 모두 자기 몫의 화면 정보(PO.viewFor)만 받는다. 방장 자신의 화면도 같은 경로로 그린다.
 *  - 연결은 PeerJS(WebRTC)로 브라우저끼리 직접 잇는다. 게임 서버가 필요 없어서 GitHub Pages 같은
 *    정적 호스팅에 올려도 되고, 같은 집이든 서로 다른 곳이든 방 코드만 있으면 된다.
 */
(function () {
  'use strict';
  const PO = window.PO;
  const Bot = window.PointOmokBot;
  const tr = (k, p) => window.I18N.t(k, p);

  const PEER_PREFIX = 'pointomok-v1-';
  const REVEAL_MS = 3800;  // 결과 공개 후 다음 라운드까지
  const STEP_MS = 650;     // 돌 하나씩 색이 입혀지는 간격
  const EMOTES = ['👍', '😏', '😱', '🤔', 'ㅋㅋ'];
  const K = {
    name: 'pointomok.name', host: 'pointomok.host', client: 'pointomok.client',
    records: 'pointomok.records', settings: 'pointomok.settings', mute: 'pointomok.mute',
  };

  // ───────── 작은 도구들 ─────────
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 공간 없음 */ } };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const circled = (k) => '①②③'[k];
  function makeCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3300);
  }
  const fmtTime = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // ───────── 소리 (WebAudio로 즉석 합성) ─────────
  const Sound = {
    ctx: null,
    muted: !!load(K.mute, false),
    ac() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    clack() {
      if (this.muted) return;
      const ac = this.ac(); if (!ac) return;
      const t = ac.currentTime, len = Math.floor(ac.sampleRate * 0.06);
      const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
      const src = ac.createBufferSource(); src.buffer = buf;
      const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2300; bp.Q.value = 1.1;
      const g = ac.createGain(); g.gain.value = 0.8;
      src.connect(bp).connect(g).connect(ac.destination); src.start(t);
      const o = ac.createOscillator(), og = ac.createGain();
      o.frequency.setValueAtTime(230, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
      og.gain.setValueAtTime(0.3, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(og).connect(ac.destination); o.start(t); o.stop(t + 0.12);
    },
    beep(freq, dur, vol, when) {
      if (this.muted) return;
      const ac = this.ac(); if (!ac) return;
      const t = ac.currentTime + (when || 0);
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    tick() { this.beep(1320, 0.05, 0.05); },
    turn() { this.beep(660, 0.1, 0.09); this.beep(990, 0.14, 0.09, 0.1); },
    win() { [523, 659, 784, 1047].forEach((f, i) => this.beep(f, 0.24, 0.1, i * 0.12)); },
    lose() { [392, 330, 262].forEach((f, i) => this.beep(f, 0.28, 0.08, i * 0.16)); },
  };

  // ───────── 게임 진행자: 방장 브라우저에서만 돈다 ─────────
  class GameHost {
    constructor(o) {
      this.code = o.code || '';
      this.settings = PO.cleanSettings(o.settings);
      this.colorPref = o.colorPref || 'random';
      this.names = [o.myName || '', ''];
      this.remote = o.remote;       // { send(msg), connected }
      this.onLocal = o.onLocal;     // 방장 자기 화면으로 보내는 함수
      this.persistOn = !!o.persist;
      this.state = null;
      this.games = 0;
      this.guestCid = null;
      this.deadline = 0;
      this.pausedLeft = null;
      this.pauses = {};             // 이유 → 누가(좌석) 또는 true
      this.draftSel = null;
      this.draftBet = [null, null];
      this.rematch = [false, false];
      this.lastTick = Date.now();
      this.iv = setInterval(() => this.tick(), 400);
    }
    static fromSave(data, o) {
      const h = new GameHost(Object.assign({}, o, {
        code: data.code, settings: data.settings, colorPref: data.colorPref, myName: data.names[0],
      }));
      h.names = data.names.slice();
      h.state = data.state;
      h.games = data.games || 1;
      h.guestCid = data.guestCid || null;
      h.rematch = data.rematch || [false, false];
      if (h.state && h.state.phase !== 'over') {
        h.pauses = { disconnect: true };
        h.pausedLeft = data.msLeft != null ? Math.max(data.msLeft, 5000) : h.phaseMs();
      }
      return h;
    }
    destroy() { clearInterval(this.iv); }

    setGuest(name, cid) {
      this.names[1] = name || '';
      if (cid) this.guestCid = cid;
      if (this.state) this.state.names = this.names.slice();
      this.setPause('disconnect', false);
    }
    guestLeft() {
      if (this.state && this.state.phase !== 'over') this.setPause('disconnect', true);
      else this.push();
    }
    // 게임 중에는 원래 참가자만 받는다. 단 원래 참가자가 끊겨 있으면 다른 기기에서 이어받을 수 있다.
    canAccept(cid) { return !this.state || !this.guestCid || cid === this.guestCid || !this.remote.connected; }

    startGame() {
      let black;
      if (this.state) black = 1 - this.state.black; // 다시 하기: 흑백을 바꾼다
      else if (this.colorPref === 'black') black = 0;
      else if (this.colorPref === 'white') black = 1;
      else black = Math.random() < 0.5 ? 0 : 1;
      this.state = PO.newGame(this.settings, black);
      this.state.names = this.names.slice();
      this.games++;
      this.rematch = [false, false];
      this.draftSel = null;
      this.draftBet = [null, null];
      delete this.pauses.manual;
      this.enterPhase();
    }

    phaseMs() {
      const st = this.state;
      if (!st) return 0;
      if (st.phase === 'select') return st.settings.selectSec * 1000;
      if (st.phase === 'bet') return st.settings.betSec * 1000;
      if (st.phase === 'reveal') return REVEAL_MS;
      return 0;
    }
    isPaused() { return Object.keys(this.pauses).length > 0; }
    enterPhase() {
      if (this.state && this.state.phase === 'over') delete this.pauses.manual;
      const ms = this.phaseMs();
      if (!ms) { this.deadline = 0; this.pausedLeft = null; }
      else if (this.isPaused()) { this.deadline = 0; this.pausedLeft = ms; }
      else { this.deadline = Date.now() + ms; this.pausedLeft = null; }
      this.push();
    }
    setPause(reason, on, by) {
      const was = this.isPaused();
      if (on) this.pauses[reason] = by == null ? true : by;
      else delete this.pauses[reason];
      const now = this.isPaused();
      if (!was && now && this.deadline) { this.pausedLeft = Math.max(0, this.deadline - Date.now()); this.deadline = 0; }
      if (was && !now && this.pausedLeft != null) { this.deadline = Date.now() + Math.max(this.pausedLeft, 3000); this.pausedLeft = null; }
      this.push();
    }
    msLeft() {
      if (this.pausedLeft != null) return this.pausedLeft;
      return this.deadline ? Math.max(0, this.deadline - Date.now()) : 0;
    }
    tick() {
      const now = Date.now(), gap = now - this.lastTick;
      this.lastTick = now;
      if (!this.state || !this.deadline) return;
      if (gap > 3000) { this.deadline += gap; this.push(); return; } // 기기가 잠들었던 시간은 빼 준다
      if (now >= this.deadline) this.onTimeout();
    }
    onTimeout() {
      const st = this.state;
      this.deadline = 0;
      try {
        if (st.phase === 'select') {
          const t = (this.draftSel && PO.emptyTriple(st.board, st.size, this.draftSel)) || PO.randomTriple(st);
          PO.applySelect(st, st.selector, t, true);
          this.draftSel = null;
          this.enterPhase();
        } else if (st.phase === 'bet') {
          for (const s of [0, 1]) {
            if (!st.bets[s]) PO.applyBet(st, s, PO.autoBets(this.draftBet[s], st.balance[s]), true);
          }
          this.resolve();
        } else if (st.phase === 'reveal') {
          PO.nextRound(st);
          this.enterPhase();
        }
      } catch (e) { console.error(e); }
    }
    resolve() {
      PO.resolveRound(this.state);
      this.draftBet = [null, null];
      this.enterPhase();
    }

    handle(seat, m) {
      if (!m || typeof m !== 'object') return;
      const st = this.state;
      try {
        switch (m.t) {
          case 'select':
            if (!st) return;
            PO.applySelect(st, seat, m.cells, false);
            this.draftSel = null;
            this.enterPhase();
            break;
          case 'draftSel':
            if (st && st.phase === 'select' && seat === st.selector) this.draftSel = Array.isArray(m.cells) ? m.cells.slice(0, 3) : null;
            break;
          case 'bet':
            if (!st) return;
            if (PO.applyBet(st, seat, Array.isArray(m.bets) ? m.bets.map(Number) : null, false)) this.resolve();
            else this.push();
            break;
          case 'draftBet':
            if (st && st.phase === 'bet') this.draftBet[seat] = Array.isArray(m.bets) ? m.bets.slice(0, 3) : null;
            break;
          case 'pause':
            if (st && st.phase !== 'over') this.setPause('manual', !!m.on, seat);
            break;
          case 'resign':
            if (!st) return;
            PO.resign(st, seat);
            this.enterPhase();
            break;
          case 'rematch':
            if (!st || st.phase !== 'over') return;
            this.rematch[seat] = true;
            if (this.rematch[0] && this.rematch[1]) this.startGame();
            else this.push();
            break;
          case 'emote':
            if (EMOTES.includes(m.e)) this.sendTo(1 - seat, { t: 'emote', e: m.e, from: seat });
            break;
        }
      } catch (e) {
        if (e instanceof PO.RuleError) this.sendTo(seat, { t: 'err', code: e.code, p: e.params && e.params.p });
        else console.error(e);
      }
    }

    sendTo(seat, msg) { if (seat === 0) this.onLocal(msg); else this.remote.send(msg); }
    message(seat) {
      const common = { names: this.names.slice(), code: this.code, me: seat };
      if (!this.state) {
        return Object.assign(common, { t: 'lobby', settings: this.settings, colorPref: this.colorPref, guestHere: !!this.remote.connected });
      }
      return Object.assign(common, {
        t: 'view',
        view: PO.viewFor(this.state, seat),
        msLeft: this.msLeft(),
        paused: this.isPaused(),
        pauses: Object.assign({}, this.pauses),
        rematch: this.rematch.slice(),
        oppConnected: seat === 0 ? !!this.remote.connected : true,
      });
    }
    push() {
      this.sendTo(0, this.message(0));
      this.sendTo(1, this.message(1));
      if (this.persistOn) this.persist();
    }
    persist() {
      save(K.host, {
        code: this.code, settings: this.settings, colorPref: this.colorPref, names: this.names,
        state: this.state, games: this.games, guestCid: this.guestCid, rematch: this.rematch,
        msLeft: this.msLeft(), savedAt: Date.now(),
      });
    }
  }

  // ───────── 연습용 봇 자리 ─────────
  class BotSeat {
    constructor() { this.host = null; this.connected = true; this.done = new Set(); }
    send(m) {
      if (m.t !== 'view') return;
      const v = m.view, h = this.host;
      const once = (key, ms, fn) => {
        if (this.done.has(key)) return;
        this.done.add(key);
        setTimeout(() => { if (h.state && h.state.id === v.id) fn(); }, ms);
      };
      if (v.phase === 'select' && v.selector === v.me) {
        once(`${v.id}:${v.round}:sel`, 1200 + Math.random() * 2000, () => h.handle(1, { t: 'select', cells: Bot.chooseTriple(v) }));
      }
      if (v.phase === 'bet' && !v.myBet) {
        once(`${v.id}:${v.round}:bet`, 1500 + Math.random() * 3500, () => h.handle(1, { t: 'bet', bets: Bot.chooseBets(v) }));
      }
      if (v.phase === 'over' && m.rematch[0] && !m.rematch[1]) {
        once(`${v.id}:re`, 700, () => h.handle(1, { t: 'rematch' }));
      }
    }
  }

  // ───────── PeerJS 연결: 방장 쪽 ─────────
  class HostNet {
    constructor(code, h) {
      this.code = code; this.h = h;
      this.peer = null; this.conn = null; this.connected = false; this.lastSeen = 0;
      this.hb = setInterval(() => this.heartbeat(), 2000);
    }
    start() {
      if (this.peer) { try { this.peer.destroy(); } catch (e) { /* 무시 */ } }
      const peer = new Peer(PEER_PREFIX + this.code, { debug: 1 });
      this.peer = peer;
      peer.on('open', () => this.h.onOpen());
      peer.on('connection', (conn) => this.accept(conn));
      peer.on('disconnected', () => { setTimeout(() => { if (this.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500); });
      peer.on('error', (err) => { if (this.peer === peer) this.h.onError(err); });
    }
    accept(conn) {
      conn.on('data', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'hello') {
          const cid = String(m.cid || '');
          if (!this.h.canAccept(cid)) {
            try { conn.send({ t: 'full' }); } catch (e) { /* 무시 */ }
            setTimeout(() => { try { conn.close(); } catch (e) { /* 무시 */ } }, 600);
            return;
          }
          if (this.conn && this.conn !== conn) { const old = this.conn; this.conn = null; try { old.close(); } catch (e) { /* 무시 */ } }
          this.conn = conn;
          this.connected = true;
          this.lastSeen = Date.now();
          this.h.onGuest(String(m.name || '').slice(0, 12), cid);
          return;
        }
        if (conn !== this.conn) return;
        this.lastSeen = Date.now();
        if (m.t === 'pong') return;
        this.h.onMessage(m);
      });
      const gone = () => { if (conn === this.conn) this.drop(); };
      conn.on('close', gone);
      conn.on('error', gone);
    }
    heartbeat() {
      if (!this.conn || !this.connected) return;
      this.send({ t: 'ping' });
      if (Date.now() - this.lastSeen > 9000) this.drop();
    }
    drop() {
      if (!this.connected) return;
      this.connected = false;
      const c = this.conn; this.conn = null;
      try { c && c.close(); } catch (e) { /* 무시 */ }
      this.h.onDrop();
    }
    send(m) { if (this.conn && this.conn.open) { try { this.conn.send(m); } catch (e) { /* 끊김은 heartbeat가 처리 */ } } }
    destroy() {
      clearInterval(this.hb);
      this.connected = false;
      try { this.conn && this.conn.close(); } catch (e) { /* 무시 */ }
      try { this.peer && this.peer.destroy(); } catch (e) { /* 무시 */ }
    }
  }

  // ───────── PeerJS 연결: 참가자 쪽 ─────────
  class GuestNet {
    constructor(code, cid, name, h) {
      this.code = code; this.cid = cid; this.name = name; this.h = h;
      this.peer = null; this.conn = null; this.connected = false; this.ever = false;
      this.attempts = 0; this.stopped = false; this.lastSeen = 0;
      this.hb = setInterval(() => { if (this.connected && Date.now() - this.lastSeen > 9000) this.lost(); }, 2000);
    }
    start() {
      const peer = new Peer({ debug: 1 });
      this.peer = peer;
      peer.on('open', () => this.connect());
      peer.on('disconnected', () => { setTimeout(() => { if (!this.stopped && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500); });
      peer.on('error', (err) => {
        if (this.stopped) return;
        if (err.type === 'peer-unavailable') this.lost();
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this.h.onStatus('reconnecting');
        else console.warn('peer error', err.type, err);
      });
    }
    connect() {
      if (this.stopped) return;
      clearTimeout(this.retryT); clearTimeout(this.openT);
      if (this.conn) { const old = this.conn; this.conn = null; try { old.close(); } catch (e) { /* 무시 */ } }
      this.attempts++;
      const conn = this.peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.conn = conn;
      conn.on('open', () => {
        if (conn !== this.conn) return;
        clearTimeout(this.openT);
        this.connected = true; this.ever = true; this.attempts = 0;
        this.lastSeen = Date.now();
        conn.send({ t: 'hello', cid: this.cid, name: this.name });
        this.h.onStatus('connected');
      });
      conn.on('data', (m) => {
        if (conn !== this.conn || !m || typeof m !== 'object') return;
        this.lastSeen = Date.now();
        if (m.t === 'ping') { try { conn.send({ t: 'pong' }); } catch (e) { /* 무시 */ } return; }
        if (m.t === 'full') { this.stop(); this.h.onStatus('full'); return; }
        this.h.onMessage(m);
      });
      conn.on('close', () => { if (conn === this.conn) this.lost(); });
      this.openT = setTimeout(() => { if (conn === this.conn && !conn.open) this.lost(); }, 9000);
    }
    lost() {
      if (this.stopped) return;
      this.connected = false;
      if (!this.ever && this.attempts >= 4) { this.stop(); this.h.onStatus('notfound'); return; }
      this.h.onStatus(this.ever ? 'reconnecting' : 'connecting');
      clearTimeout(this.retryT);
      this.retryT = setTimeout(() => {
        if (this.stopped) return;
        if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect(); // 다시 열리면 'open'에서 connect
        else this.connect();
      }, 2500);
    }
    send(m) { if (this.conn && this.conn.open) { try { this.conn.send(m); } catch (e) { /* 무시 */ } } }
    stop() {
      this.stopped = true;
      clearInterval(this.hb); clearTimeout(this.retryT); clearTimeout(this.openT);
      try { this.conn && this.conn.close(); } catch (e) { /* 무시 */ }
      try { this.peer && this.peer.destroy(); } catch (e) { /* 무시 */ }
    }
    destroy() { this.stop(); }
  }

  // ───────── 앱 상태 ─────────
  const app = {
    mode: 'lobby',       // lobby | host | guest | solo
    screen: 'lobby',
    host: null,
    net: null,
    netStatus: '',
    msg: null,           // 마지막으로 받은 lobby/view 메시지
    view: null,
    deadlineAt: 0,
    sel: { key: '', anchor: null, hover: null, triple: null },
    draft: { key: '', bets: [1, 1, 1] },
    anim: { id: '', round: 0, step: 3, token: 0 },
    panelSig: '',
    playersSig: '',
    logSig: '',
    overlaySig: null,
    dismissed: {},
    saved: new Set(load(K.records, []).map((r) => r.id)),
    needed: false,
    lastTickSec: -1,
    formMode: 'create',
  };

  function act(m) {
    if (app.host) app.host.handle(0, m);
    else if (app.net) app.net.send(m);
  }

  function show(screen) {
    app.screen = screen;
    for (const id of ['lobby', 'room', 'game']) $('#' + id).hidden = id !== screen;
    window.scrollTo(0, 0);
  }

  const myName = () => ($('#name').value.trim() || '').slice(0, 12);
  const kindOf = (v, seat) => (seat === v.black ? 'b' : 'w');
  const colorName = (v, seat) => tr(seat === v.black ? 'color.b' : 'color.w');
  // 이름을 비워 둔 사람은 각자 화면의 언어로 '방장/참가자/봇' 등으로 보인다.
  const roleName = (mode, seat) => tr(mode === 'solo' ? (seat === 1 ? 'role.bot' : 'role.you') : (seat === 0 ? 'role.host' : 'role.guest'));
  const nameOf = (v, seat) => v.names[seat] || roleName(app.mode, seat);
  const recName = (rec, seat) => rec.names[seat] || roleName(rec.mode, seat);

  // ───────── 메시지 받기 ─────────
  function onMessage(m) {
    switch (m.t) {
      case 'lobby':
        app.msg = m;
        app.view = null;
        if (app.screen !== 'room') show('room');
        renderRoom();
        break;
      case 'view':
        onView(m);
        break;
      case 'err':
        toast(tr('err.' + m.code, { p: m.p }), 'err');
        break;
      case 'emote':
        showBubble(m.from, m.e);
        break;
    }
  }

  function onView(m) {
    const prev = app.view;
    app.msg = m;
    app.view = m.view;
    app.deadlineAt = performance.now() + (m.msLeft || 0);
    const v = m.view;
    if (app.screen !== 'game') { show('game'); app.panelSig = app.playersSig = app.logSig = ''; app.overlaySig = null; }
    if (!prev || prev.id !== v.id) { app.sel = { key: '', anchor: null, hover: null, triple: null }; }
    const key = v.id + ':' + v.round;
    if (app.sel.key !== key) app.sel = { key, anchor: null, hover: null, triple: null };
    if (app.draft.key !== key) app.draft = { key, bets: [1, 1, 1] };
    if (prev && prev.id === v.id && prev.phase === 'select' && v.phase === 'bet') Sound.clack();
    maybeAnimate(v);
    if (v.phase === 'over') saveRecord(v);
    const need = needsMe(v);
    if (need && !app.needed) {
      Sound.turn();
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(40);
      if (window.innerWidth <= 900) {
        const target = v.phase === 'bet' ? $('#panel') : $('#board-wrap');
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
      }
    }
    app.needed = need;
    document.title = (need ? '● ' : '') + tr('doc.title');
    render();
  }

  function needsMe(v) {
    return (v.phase === 'select' && v.selector === v.me) || (v.phase === 'bet' && !v.myBet);
  }

  function maybeAnimate(v) {
    const lr = v.lastReveal;
    if (!lr) return;
    if (app.anim.id === v.id && app.anim.round === lr.round) return;
    const fresh = (v.phase === 'reveal' || v.phase === 'over') && lr.round === v.round &&
      !(v.result && v.result.reason === 'resign');
    const token = ++app.anim.token;
    app.anim = { id: v.id, round: lr.round, step: fresh ? 0 : 3, token };
    if (!fresh) return;
    for (let k = 1; k <= 3; k++) {
      setTimeout(() => {
        if (app.anim.token !== token) return;
        app.anim.step = k;
        Sound.clack();
        if (k === 3 && app.view && app.view.phase === 'over') {
          const r = app.view.result;
          setTimeout(() => { if (r.winner === app.view.me) Sound.win(); else if (r.winner != null) Sound.lose(); }, 300);
        }
        render();
      }, 300 + (k - 1) * STEP_MS);
    }
    if (v.phase === 'over') setTimeout(() => { if (app.anim.token === token) { app.anim.step = 4; render(); } }, 300 + 3 * STEP_MS + 400);
  }
  const animStep = () => {
    const v = app.view;
    if (!v || !v.lastReveal || app.anim.id !== v.id || app.anim.round !== v.lastReveal.round) return 4;
    return app.anim.step;
  };

  function saveRecord(v) {
    if (app.saved.has(v.id)) return;
    const recs = load(K.records, []).filter((r) => r.id !== v.id);
    recs.unshift({
      id: v.id, at: Date.now(), size: v.size, names: v.names, black: v.black, me: v.me,
      settings: v.settings, history: v.history, result: v.result, mode: app.mode,
    });
    save(K.records, recs.slice(0, 40));
    app.saved.add(v.id);
  }

  // ───────── 판 그리기 ─────────
  const C = 40, PAD = 38, R = C * 0.46;
  const boardW = (size) => PAD * 2 + C * (size - 1);
  const pos = (size, i) => { const [x, y] = PO.xy(size, i); return [PAD + x * C, PAD + y * C]; };
  function starPoints(size) {
    const a = size === 19 ? [3, 9, 15] : [3, 7, 11];
    const out = [];
    for (const y of a) for (const x of a) {
      if (size === 15 && ((x === 7) !== (y === 7))) continue;
      out.push([x, y]);
    }
    return out;
  }
  function boardStatic(size, p) {
    const end = PAD + C * (size - 1);
    let s = `<defs>
      <radialGradient id="${p}black" cx="36%" cy="30%" r="72%"><stop offset="0" stop-color="#7a7a7a"/><stop offset=".38" stop-color="#2a2a2a"/><stop offset="1" stop-color="#050505"/></radialGradient>
      <radialGradient id="${p}white" cx="36%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".62" stop-color="#ebe7df"/><stop offset="1" stop-color="#b3ada0"/></radialGradient>
      <radialGradient id="${p}sky" cx="36%" cy="30%" r="75%"><stop offset="0" stop-color="#f4fcff"/><stop offset=".45" stop-color="#9ad6f7"/><stop offset="1" stop-color="#3b8fc4"/></radialGradient>
      <filter id="${p}shadow" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="1.6" dy="2.6" stdDeviation="1.7" flood-color="#000" flood-opacity=".45"/></filter>
    </defs>`;
    let d = '';
    for (let k = 1; k < size - 1; k++) { const q = PAD + k * C; d += `M${PAD} ${q}H${end}M${q} ${PAD}V${end}`; }
    s += `<path class="grid-line" d="${d}"/>`;
    s += `<rect class="grid-edge" x="${PAD}" y="${PAD}" width="${end - PAD}" height="${end - PAD}"/>`;
    for (const [x, y] of starPoints(size)) s += `<circle class="star" cx="${PAD + x * C}" cy="${PAD + y * C}" r="4.4"/>`;
    for (let k = 0; k < size; k++) {
      const q = PAD + k * C;
      s += `<text class="coord" x="${q}" y="${PAD / 2 - 3}">${PO.COLS[k]}</text>`;
      s += `<text class="coord" x="${q}" y="${end + PAD / 2 + 3}">${PO.COLS[k]}</text>`;
      s += `<text class="coord" x="${PAD / 2 - 3}" y="${q}">${size - k}</text>`;
      s += `<text class="coord" x="${end + PAD / 2 + 3}" y="${q}">${size - k}</text>`;
    }
    return s;
  }
  function stoneSvg(size, i, kind, p, cls) {
    const [cx, cy] = pos(size, i);
    const fill = kind === 'b' ? 'black' : kind === 'w' ? 'white' : 'sky';
    return `<circle class="stone ${kind} ${cls || ''}" cx="${cx}" cy="${cy}" r="${R}" fill="url(#${p}${fill})" filter="url(#${p}shadow)"/>`;
  }
  function labelSvg(size, i, text, cls, dy) {
    const [cx, cy] = pos(size, i);
    return `<text class="${cls || 'lbl'}" x="${cx}" y="${cy + (dy || 0)}">${text}</text>`;
  }

  const board = { size: 0, layers: null, stonesSig: '' };
  function ensureBoard(size) {
    if (board.size === size && board.layers) return;
    board.size = size;
    const svg = $('#board');
    const W = boardW(size);
    svg.setAttribute('viewBox', `0 0 ${W} ${W}`);
    svg.innerHTML = boardStatic(size, 'm-') + '<g id="L-stones"></g><g id="L-sel"></g><g id="L-win"></g>';
    board.layers = { stones: $('#L-stones'), sel: $('#L-sel'), win: $('#L-win') };
    board.stonesSig = '';
  }

  function renderStones() {
    const v = app.view;
    ensureBoard(v.size);
    const step = animStep();
    const lr = v.lastReveal;
    const sig = JSON.stringify([v.id, v.board, v.triple, v.phase, step, lr && lr.round]);
    if (sig === board.stonesSig) return;
    board.stonesSig = sig;
    const hidden = lr && step < 3 ? lr.triple : null;
    let s = '';
    for (let i = 0; i < v.board.length; i++) {
      const seat = v.board[i];
      if (seat === PO.EMPTY) continue;
      const k = hidden ? hidden.indexOf(i) : -1;
      if (k >= 0 && k >= step) {
        s += stoneSvg(v.size, i, 'n', 'm-') + labelSvg(v.size, i, k + 1);
      } else if (k >= 0 && k === step - 1) {
        const [cx, cy] = pos(v.size, i);
        s += stoneSvg(v.size, i, kindOf(v, seat), 'm-', 'pop');
        s += `<circle class="burst ${kindOf(v, seat)}" cx="${cx}" cy="${cy}" r="${R}"/>`;
      } else {
        s += stoneSvg(v.size, i, kindOf(v, seat), 'm-');
      }
    }
    if (v.phase === 'bet' && v.triple) {
      v.triple.forEach((c, k) => { s += stoneSvg(v.size, c, 'n', 'm-', 'pop') + labelSvg(v.size, c, k + 1); });
    }
    // 지난 라운드에 놓인 세 돌 표시
    if (lr && step >= 3 && v.phase !== 'bet') {
      for (const c of lr.triple) {
        const [cx, cy] = pos(v.size, c);
        s += `<circle class="last-mark" cx="${cx}" cy="${cy}" r="5.5"/>`;
      }
    }
    board.layers.stones.innerHTML = s;

    let w = '';
    if (v.phase === 'over' && v.result && v.result.lines && step >= 3) {
      v.result.lines.forEach((lines, seat) => {
        for (const line of lines) {
          const [x1, y1] = pos(v.size, line[0]), [x2, y2] = pos(v.size, line[line.length - 1]);
          w += `<line class="win-line ${kindOf(v, seat)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
        }
      });
    }
    board.layers.win.innerHTML = w;
  }

  function canSelect() {
    const v = app.view;
    return !!v && app.screen === 'game' && v.phase === 'select' && v.selector === v.me;
  }

  function renderSel() {
    if (!board.layers) return;
    const v = app.view, on = canSelect(), L = board.layers.sel;
    $('#board').classList.toggle('selecting', on);
    if (!on) { L.innerHTML = ''; return; }
    const s = app.sel;
    let out = '';
    if (s.triple) {
      s.triple.forEach((c, k) => { out += stoneSvg(v.size, c, 'n', 'm-') + labelSvg(v.size, c, k + 1); });
    } else if (s.anchor != null) {
      const preview = s.hover != null ? PO.tripleFromClicks(v.board, v.size, s.anchor, s.hover) : null;
      for (const t of PO.clickTargets(v.board, v.size, s.anchor)) {
        const [cx, cy] = pos(v.size, t);
        out += `<circle class="target-dot" cx="${cx}" cy="${cy}" r="5"/>`;
      }
      if (preview) preview.forEach((c, k) => { out += stoneSvg(v.size, c, 'n', 'm-', 'ghost') + labelSvg(v.size, c, k + 1); });
      const [ax, ay] = pos(v.size, s.anchor);
      out += `<circle class="anchor-ring" cx="${ax}" cy="${ay}" r="${R}"/>`;
    } else if (s.hover != null && v.board[s.hover] === PO.EMPTY) {
      const [cx, cy] = pos(v.size, s.hover);
      out += `<circle class="hover-dot" cx="${cx}" cy="${cy}" r="${R * 0.7}"/>`;
    }
    L.innerHTML = out;
  }

  function cellFromEvent(e) {
    const v = app.view;
    if (!v) return null;
    const svg = $('#board');
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    const x = Math.round((p.x - PAD) / C), y = Math.round((p.y - PAD) / C);
    if (!PO.inBounds(v.size, x, y)) return null;
    if (Math.hypot(p.x - (PAD + x * C), p.y - (PAD + y * C)) > C * 0.62) return null;
    return PO.idx(v.size, x, y);
  }

  function onCellClick(c) {
    if (!canSelect() || c == null) return;
    const v = app.view, s = app.sel;
    if (v.board[c] !== PO.EMPTY) return;
    if (s.triple) {
      s.anchor = s.triple.includes(c) ? null : c;
      s.triple = null;
    } else if (s.anchor == null) {
      s.anchor = c;
    } else if (s.anchor === c) {
      s.anchor = null;
    } else {
      const t = PO.tripleFromClicks(v.board, v.size, s.anchor, c);
      if (t) { s.triple = t; s.anchor = null; Sound.clack(); }
      else s.anchor = c;
    }
    act({ t: 'draftSel', cells: s.triple });
    renderSel();
    renderPanel();
  }

  // ───────── 오른쪽 기둥 ─────────
  function renderPlayers() {
    const v = app.view, m = app.msg;
    const sig = JSON.stringify([v.id, v.names, v.black, v.phase, v.round, v.selector, v.balance, !!v.myBet, v.oppLocked, m.oppConnected, v.result && v.result.winner, m.rematch]);
    if (sig === app.playersSig) return;
    app.playersSig = sig;
    const cards = [v.me, 1 - v.me].map((seat) => {
      const me = seat === v.me;
      const tags = [];
      if (v.phase !== 'over') {
        tags.push(seat === v.selector ? `<span class="tag sel">${tr('tag.sel')}</span>` : `<span class="tag tie" title="${tr('tag.tieTitle')}">${tr('tag.tie')}</span>`);
      } else if (v.result && v.result.winner === seat) {
        tags.push(`<span class="tag tie">${tr('tag.win')}</span>`);
      }
      let status = '', cls = '';
      if (!me && !m.oppConnected) { status = tr('st.offline'); cls = 'bad'; }
      else if (v.phase === 'select') status = tr(seat === v.selector ? 'st.picking' : 'st.waiting');
      else if (v.phase === 'bet') {
        const locked = me ? !!v.myBet : v.oppLocked;
        status = tr(locked ? 'st.locked' : 'st.betting');
        if (locked) cls = 'ok';
      } else if (v.phase === 'reveal') status = tr('st.revealing');
      else if (v.phase === 'over') {
        if (m.rematch[seat]) { status = tr('st.rematch'); cls = 'ok'; }
      }
      const pts = me
        ? `<div class="ppoints">${v.balance}<small>P</small></div>`
        : `<div class="ppoints hidden" title="${tr('pts.hidden')}">?<small>P</small></div>`;
      return `<div class="pcard ${me ? 'me' : ''}" data-seat="${seat}">
        <div class="pcard-top"><span class="pstone ${kindOf(v, seat)}"></span><span class="pname">${esc(nameOf(v, seat))}</span>${me ? `<span class="pyou">${tr('role.you')}</span>` : ''}</div>
        ${pts}
        <div class="tags">${tags.join('')}</div>
        <div class="pstatus ${cls}">${status}</div>
      </div>`;
    });
    $('#players').innerHTML = cards.join('');
  }

  function showBubble(seat, e) {
    const v = app.view;
    if (!v || app.screen !== 'game') return;
    const el = document.createElement('div');
    el.className = 'bubble ' + (seat === v.me ? 'left' : 'right');
    el.textContent = e === 'ㅋㅋ' ? tr('emote.lol') : e;
    $('#bubbles').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  function phaseTotal(v) {
    if (v.phase === 'select') return v.settings.selectSec * 1000;
    if (v.phase === 'bet') return v.settings.betSec * 1000;
    if (v.phase === 'reveal') return REVEAL_MS;
    return 0;
  }
  function renderPhaseLabel() {
    const v = app.view;
    $('#phase-label').innerHTML = v.phase === 'over'
      ? `${tr('phase.gameOver')} <small>· ${tr('phase.roundN', { n: v.round })}</small>`
      : `${tr('phase.round', { n: v.round })} <small>· ${tr('phase.' + v.phase)}</small>`;
  }
  function updateTimer() {
    const v = app.view, m = app.msg;
    if (!v || app.screen !== 'game') return;
    const el = $('#timer'), bar = $('#timebar');
    const total = phaseTotal(v);
    if (!total || v.phase === 'reveal') {
      el.textContent = v.phase === 'reveal' ? '' : '';
      el.className = 'timer';
      bar.style.width = v.phase === 'reveal' ? '100%' : '0';
      bar.className = '';
      return;
    }
    if (m.paused) {
      el.textContent = tr('timer.paused');
      el.className = 'timer paused';
      bar.style.width = Math.min(100, (m.msLeft / total) * 100) + '%';
      return;
    }
    const left = Math.max(0, app.deadlineAt - performance.now());
    const sec = Math.ceil(left / 1000);
    el.textContent = fmtTime(sec);
    const low = sec <= 10;
    el.className = 'timer' + (low ? ' low' : '');
    bar.className = low ? 'low' : '';
    bar.style.width = Math.min(100, (left / total) * 100) + '%';
    if (needsMe(v) && sec <= 5 && sec > 0 && sec !== app.lastTickSec) { app.lastTickSec = sec; Sound.tick(); }
  }

  function panelSig(v) {
    const m = app.msg;
    return JSON.stringify([v.id, v.phase, v.round, v.selector === v.me, !!v.myBet, v.oppLocked, animStep(),
      app.sel.triple, m.rematch, v.balance, m.oppConnected]);
  }
  function renderPanel() {
    const v = app.view;
    const sig = panelSig(v);
    if (sig === app.panelSig) return;
    app.panelSig = sig;
    $('#panel').innerHTML = panelHtml(v);
    if (v.phase === 'bet' && !v.myBet) updateBetUi();
  }
  function tripleChips(v, cells) {
    return `<div class="sel-chips">${cells.map((c, k) => `<span class="sel-chip"><span class="num">${k + 1}</span>${PO.coordName(v.size, c)}</span>`).join('')}</div>`;
  }
  function panelHtml(v) {
    const opp = 1 - v.me;
    if (v.phase === 'select') {
      if (v.selector === v.me) {
        const t = app.sel.triple;
        return `<h3>${tr('sel.title')}</h3>
          <p>${tr('sel.help')}</p>
          ${t ? tripleChips(v, t) : `<div class="sel-chips"><span class="sel-chip empty">${tr('sel.none')}</span></div>`}
          <div class="row">
            <button class="btn primary" data-act="confirm-sel" ${t ? '' : 'disabled'}>${tr('sel.confirm')}</button>
            <button class="btn ghost" data-act="clear-sel" ${t || app.sel.anchor != null ? '' : 'disabled'}>${tr('sel.clear')}</button>
          </div>
          <p class="hint">${tr('sel.hint', { name: esc(nameOf(v, opp)) })}</p>`;
      }
      return `<h3>${tr('selWait.title', { name: esc(nameOf(v, v.selector)) })}</h3>
        <p>${tr('selWait.body', { p: v.balance })}</p>
        <p class="hint">${tr('selWait.hint')}</p>`;
    }
    if (v.phase === 'bet') {
      const tieTo = v.selector === v.me ? tr('bet.tieOpp', { name: esc(nameOf(v, opp)) }) : tr('bet.tieMe');
      if (v.myBet) {
        const spent = PO.sum(v.myBet), rem = v.balance - spent;
        return `<h3>${tr('bet.lockedTitle')}</h3>
          ${tripleChips(v, v.triple)}
          <div class="locked">${v.myBet.map((b, k) => `<span class="num">${k + 1}</span><span class="v">${b}</span>`).join('')}</div>
          <p>${tr('bet.left', { r: rem, c: Math.floor(rem / 2) })}${v.myBetAuto ? ` <span class="auto-mark">${tr('bet.auto')}</span>` : ''}</p>
          <p class="hint">${tr(v.oppLocked ? 'bet.oppDone' : 'bet.oppWait')}</p>`;
      }
      return `<h3>${tr('bet.title')}</h3>
        <p>${tr('bet.body', { p: v.balance, tie: tieTo })}</p>
        <div class="bet-rows">${[0, 1, 2].map((k) => `
          <div class="bet-row" data-k="${k}">
            <span class="num">${k + 1}</span><span class="bet-coord">${PO.coordName(v.size, v.triple[k])}</span>
            <div class="stepper">
              <button data-act="bet-dec" data-k="${k}" aria-label="${tr('bet.dec', { k: k + 1 })}">−</button>
              <input type="number" inputmode="numeric" min="1" step="1" data-k="${k}" aria-label="${tr('bet.input', { k: k + 1 })}">
              <button data-act="bet-inc" data-k="${k}" aria-label="${tr('bet.inc', { k: k + 1 })}">+</button>
            </div>
          </div>`).join('')}
        </div>
        <div class="quick">
          <button data-act="bet-reset" title="${tr('q.resetTitle')}">1·1·1</button>
          <button data-act="bet-even" title="${tr('q.evenTitle')}">${tr('q.even')}</button>
          <button data-act="bet-all" data-k="0" title="${tr('q.allTitle', { c: '①' })}">${tr('q.all', { c: '①' })}</button>
          <button data-act="bet-all" data-k="1" title="${tr('q.allTitle', { c: '②' })}">${tr('q.all', { c: '②' })}</button>
          <button data-act="bet-all" data-k="2" title="${tr('q.allTitle', { c: '③' })}">${tr('q.all', { c: '③' })}</button>
        </div>
        <div class="bet-sum">
          <div><b id="bs-spent">3</b><span>${tr('sum.spent')}</span></div>
          <div id="bs-rem-box"><b id="bs-rem">0</b><span>${tr('sum.left')}</span></div>
          <div class="carry"><b id="bs-carry">0</b><span>${tr('sum.carry')}</span></div>
        </div>
        <button class="btn primary wide" data-act="confirm-bet" id="confirm-bet">${tr('bet.confirm')}</button>
        <p class="hint">${tr('bet.hint')}</p>`;
    }
    if (v.phase === 'reveal' || v.phase === 'over') {
      const h = v.history[v.history.length - 1];
      const step = animStep();
      const fresh = h && v.lastReveal && h.round === v.lastReveal.round && !(v.phase === 'over' && v.result.reason === 'resign' && h.round !== v.round);
      let list = '';
      if (h && fresh) {
        list = `<ul class="reveal-list">${h.triple.map((c, k) => {
          if (k >= step) return `<li class="wait"><span class="num">${k + 1}</span>${PO.coordName(v.size, c)}<span class="who">…</span></li>`;
          const w = h.winners[k];
          return `<li><span class="num">${k + 1}</span>${PO.coordName(v.size, c)}
            <span class="mine">${tr('rev.mine', { b: h.bets[v.me][k] })}</span>
            <span class="who"><span class="pstone ${kindOf(v, w)}"></span>${esc(nameOf(v, w))}</span></li>`;
        }).join('')}</ul>`;
      }
      if (v.phase === 'reveal') {
        const carry = h.carry[v.me];
        return `<h3>${tr('rev.title')}</h3>${list}
          <p>${tr('rev.carry', { r: h.remaining[v.me], c: carry, n: carry + v.settings.grant })}</p>
          <p class="hint">${tr('rev.next', { name: esc(nameOf(v, 1 - v.selector)) })}</p>`;
      }
      // over
      const r = v.result, m = app.msg;
      const head = tr(r.winner == null ? 'res.draw' : r.winner === v.me ? 'res.win' : 'res.lose');
      const sub = r.winner == null ? reasonText(v) : `${tr('res.by', { color: colorName(v, r.winner), name: esc(nameOf(v, r.winner)) })} · ${reasonText(v)}`;
      const iWant = m.rematch[v.me], theyWant = m.rematch[opp];
      return `${list}
        <div class="win-text">${head}</div>
        <p>${sub}</p>
        <button class="btn wide" data-act="snapshot">${tr('btn.snapshotFull')}</button>
        <button class="btn primary wide" data-act="rematch" ${iWant ? 'disabled' : ''}>${tr(iWant ? 'btn.rematchWait' : 'btn.rematch')}</button>
        ${theyWant && !iWant ? `<p class="hint">${tr('rematch.they', { name: esc(nameOf(v, opp)) })}</p>` : ''}
        <button class="btn ghost wide" data-act="leave">${tr('btn.lobby')}</button>`;
    }
    return '';
  }

  function reasonText(v) {
    const r = v.result;
    switch (r.reason) {
      case 'omok': return tr('why.omok', { n: r.round });
      case 'more': return tr('why.more', { a: Math.max(...r.counts), b: Math.min(...r.counts) });
      case 'majority': return tr('why.majority', { n: r.counts[0] });
      case 'resign': return tr('why.resign', { name: esc(nameOf(v, 1 - r.winner)) });
      case 'full': return tr('why.full');
      default: return '';
    }
  }

  // 베팅 입력
  function updateBetUi() {
    const v = app.view;
    if (!v || v.phase !== 'bet' || v.myBet) return;
    const d = app.draft.bets, bal = v.balance, spent = PO.sum(d), rem = bal - spent;
    $$('.stepper input').forEach((inp) => {
      const k = +inp.dataset.k;
      if (document.activeElement !== inp || inp.value === '' || +inp.value !== d[k]) {
        if (!(document.activeElement === inp && inp.value === '' && d[k] === 0)) inp.value = d[k];
      }
      inp.max = d[k] + Math.max(0, rem);
    });
    $$('[data-act="bet-inc"]').forEach((b) => { b.disabled = rem <= 0; });
    $$('[data-act="bet-dec"]').forEach((b) => { b.disabled = d[+b.dataset.k] <= 1; });
    const s = $('#bs-spent'); if (!s) return;
    s.textContent = spent;
    $('#bs-rem').textContent = rem;
    $('#bs-rem-box').className = rem < 0 ? 'over' : '';
    $('#bs-carry').textContent = Math.floor(Math.max(0, rem) / 2);
    $('#confirm-bet').disabled = !!PO.validateBets(d, bal);
    sendDraftBet();
  }
  let draftT = null;
  function sendDraftBet() {
    clearTimeout(draftT);
    draftT = setTimeout(() => act({ t: 'draftBet', bets: app.draft.bets.slice() }), 250);
  }
  function setDraft(k, val, strict) {
    const v = app.view;
    const d = app.draft.bets;
    const others = d.reduce((s, x, i) => (i === k ? s : s + x), 0);
    const max = Math.max(1, v.balance - others);
    let n = Number.isFinite(val) ? Math.floor(val) : (strict ? 1 : 0);
    n = Math.min(max, Math.max(strict ? 1 : 0, n));
    d[k] = n;
    updateBetUi();
  }

  function renderLog() {
    const v = app.view;
    const sig = JSON.stringify([v.id, v.history.length, v.phase === 'over', animStep() >= 3]);
    if (sig === app.logSig) return;
    app.logSig = sig;
    const step = animStep();
    const rows = v.history.slice().reverse().filter((h) => !(h.round === v.round && step < 3 && v.phase !== 'select'));
    $('#log').innerHTML = rows.map((h) => {
      const mine = h.bets[v.me];
      return `<li><span class="r">R${h.round}</span>
        <span class="mini-stones">${h.winners.map((w) => `<i class="${kindOf(v, w)}"></i>`).join('')}</span>
        <span>${tr('log.picker', { name: esc(nameOf(v, h.selector)) })}${h.selectAuto ? ` <span class="auto-mark">${tr('auto')}</span>` : ''}</span>
        <small>${tr('log.mine', { b: mine ? mine.join('·') : '-', c: h.carry[v.me] })}</small></li>`;
    }).join('') || `<li><small>${tr('log.empty')}</small></li>`;
  }

  function renderOverlay() {
    const v = app.view, m = app.msg, el = $('#overlay');
    let html = '';
    if (app.mode === 'guest' && app.netStatus !== 'connected') {
      html = `<div class="overlay-card"><h2>${tr('ov.lostTitle')}</h2><p>${tr('ov.lostBody')}</p>
        <button class="btn ghost" data-act="leave">${tr('btn.leave')}</button></div>`;
    } else if (v.phase !== 'over' && !m.oppConnected) {
      html = `<div class="overlay-card"><h2>${tr('ov.oppTitle')}</h2><p>${tr('ov.oppBody', { name: esc(nameOf(v, 1 - v.me)), code: esc(m.code) })}</p></div>`;
    } else if (v.phase === 'over' && animStep() >= 4 && !app.dismissed[v.id]) {
      const r = v.result;
      const head = tr(r.winner == null ? 'res.draw' : r.winner === v.me ? 'res.win' : 'res.lose');
      const sub = r.winner == null ? reasonText(v) : `${tr('res.by', { color: colorName(v, r.winner), name: esc(nameOf(v, r.winner)) })} · ${reasonText(v)}`;
      html = `<div class="overlay-card win"><h2>${head}</h2><p>${sub}</p>
        <div class="row center"><button class="btn primary" data-act="snapshot">${tr('btn.snapshot')}</button><button class="btn ghost" data-act="dismiss-overlay">${tr('btn.viewBoard')}</button></div></div>`;
    } else if (m.paused && m.pauses && m.pauses.manual != null) {
      const by = m.pauses.manual;
      html = `<div class="overlay-card"><h2>${tr('ov.pausedTitle')}</h2><p>${tr('ov.pausedBody', { name: esc(nameOf(v, by)) })}</p><button class="btn primary" data-act="pause">${tr('bar.resume')}</button></div>`;
    }
    if (html === app.overlaySig) return;
    app.overlaySig = html;
    el.innerHTML = html;
    el.hidden = !html;
  }

  function renderBar() {
    const v = app.view, m = app.msg;
    $('#code-chip').textContent = app.mode === 'solo' ? tr('bar.practice') : (m.code || '');
    const net = $('#net');
    if (app.mode === 'solo') { net.textContent = ''; net.className = 'net'; }
    else if (app.mode === 'guest') {
      const ok = app.netStatus === 'connected';
      net.textContent = tr(ok ? 'net.ok' : 'net.re');
      net.className = 'net ' + (ok ? 'ok' : 'bad');
    } else {
      net.textContent = tr(m.oppConnected ? 'net.opp' : 'net.none');
      net.className = 'net ' + (m.oppConnected ? 'ok' : 'bad');
    }
    const manual = !!(m.pauses && m.pauses.manual != null);
    const pb = $('#pause-btn');
    pb.classList.toggle('on', manual);
    pb.disabled = v.phase === 'over';
    pb.title = tr(manual ? 'bar.resume' : 'bar.pause');
    pb.setAttribute('aria-label', pb.title);
    $('#mute-btn').classList.toggle('on', !Sound.muted);
    $('#mute-btn').textContent = Sound.muted ? '♪̸' : '♪';
    $('#resign-btn').hidden = v.phase === 'over';
  }

  function render() {
    if (!app.view || app.screen !== 'game') return;
    renderBar();
    renderPlayers();
    renderPhaseLabel();
    renderStones();
    renderSel();
    renderPanel();
    renderLog();
    renderOverlay();
    updateTimer();
  }

  // ───────── 대기실 ─────────
  function settingsSummary(s, colorPref) {
    const color = colorPref ? tr('room.summaryColor', { c: tr({ random: 'pref.random', black: 'color.b', white: 'color.w' }[colorPref]) }) : '';
    return tr('room.summary', { s: s.size, a: s.selectSec, b: s.betSec, color });
  }
  function shareUrl(code) { return location.origin + location.pathname + '?join=' + code; }
  function renderRoom() {
    const m = app.msg;
    const isHost = app.mode === 'host';
    const code = isHost ? app.host.code : (app.net && app.net.code) || '';
    $('#room-code').textContent = code || '····';
    $('#share-box').hidden = !isHost || !code;
    if (isHost && code) $('#share-link').value = shareUrl(code);
    let status;
    if (isHost) {
      if (app.netStatus === 'opening') status = tr('room.opening');
      else if (app.netStatus === 'waitid') status = tr('room.waitid');
      else if (m && m.guestHere) status = tr('room.guestHere', { name: esc(m.names[1] || tr('role.guest')) });
      else status = tr('room.waiting');
    } else {
      status = ['connecting', 'connected', 'reconnecting', 'notfound', 'full'].includes(app.netStatus)
        ? tr('room.' + app.netStatus) : tr('room.default');
    }
    $('#room-status').innerHTML = status;
    const names = m ? m.names : [isHost ? myName() : '', ''];
    const me = isHost ? 0 : 1;
    const here = isHost ? !!(m && m.guestHere) : !!m;
    $('#room-players').innerHTML = [0, 1].map((seat) => {
      const present = seat === 0 ? (isHost || !!m) : here;
      const role = tr(seat === 0 ? 'role.host' : 'role.guest');
      if (!present) return `<li class="empty">${seat === 0 ? role : tr('room.empty')}</li>`;
      return `<li><span>${esc(names[seat] || role)}${seat === me ? ` <small>${tr('room.me')}</small>` : ''}</span><small>${role}</small></li>`;
    }).join('');
    $('#room-settings').textContent = m && m.settings ? settingsSummary(m.settings, m.colorPref) : '';
    const sb = $('#start-btn');
    sb.hidden = !isHost;
    sb.disabled = !(m && m.guestHere);
  }

  // ───────── 시작 · 참가 · 연습 · 이어하기 ─────────
  function readSettingsForm() {
    const f = $('#settings-form');
    const val = (n) => (f.querySelector(`input[name="${n}"]:checked`) || {}).value;
    return { settings: { size: +val('size'), selectSec: +val('selectSec'), betSec: +val('betSec') }, colorPref: val('color') };
  }
  function writeSettingsForm(saved) {
    if (!saved) return;
    const f = $('#settings-form');
    const set = (n, v) => { const el = f.querySelector(`input[name="${n}"][value="${v}"]`); if (el) el.checked = true; };
    if (saved.settings) for (const k of ['size', 'selectSec', 'betSec']) set(k, saved.settings[k]);
    if (saved.colorPref) set('color', saved.colorPref);
  }

  function hostCallbacks() {
    return {
      onOpen: () => { app.netStatus = 'open'; if (app.host) app.host.push(); if (app.screen === 'room') renderRoom(); },
      onGuest: (name, cid) => {
        const h = app.host; if (!h) return;
        h.setGuest(name, cid);
        toast(tr('toast.joined', { name: name || tr('role.guest') }));
      },
      onMessage: (m) => { if (app.host) app.host.handle(1, m); },
      onDrop: () => {
        if (!app.host) return;
        app.host.guestLeft();
        toast(tr('toast.oppLost'), 'err');
      },
      canAccept: (cid) => !!app.host && app.host.canAccept(cid),
      onError: (err) => {
        if (err.type === 'unavailable-id') {
          if (app.host && app.host.state) {
            // 이어하기: 예전 연결이 서버에서 정리될 때까지 같은 코드로 다시 시도
            app.netStatus = 'waitid';
            if (app.screen === 'room') renderRoom();
            setTimeout(() => { if (app.net) app.net.start(); }, 3000);
          } else {
            const code = makeCode();
            app.host.code = code; app.net.code = code;
            app.net.start();
            renderRoom();
          }
        } else if (err.type === 'browser-incompatible') {
          toast(tr('toast.noRTC'), 'err');
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          toast(tr('toast.signal'), 'err');
          setTimeout(() => { if (app.net && app.net.peer && app.net.peer.destroyed) app.net.start(); }, 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      },
    };
  }

  function startHosting(settings, colorPref) {
    if (!window.Peer) { toast(tr('toast.noPeer'), 'err'); return; }
    teardown();
    app.mode = 'host';
    const code = makeCode();
    const net = new HostNet(code, hostCallbacks());
    app.net = net;
    app.host = new GameHost({
      code, settings, colorPref, myName: myName(),
      remote: { send: (m) => net.send(m), get connected() { return net.connected; } },
      onLocal: onMessage, persist: true,
    });
    app.netStatus = 'opening';
    show('room');
    app.msg = null;
    renderRoom();
    net.start();
  }

  function resumeHosting() {
    const data = load(K.host, null);
    if (!data || !data.state) return;
    if (!window.Peer) { toast(tr('toast.noPeer'), 'err'); return; }
    teardown();
    app.mode = 'host';
    const net = new HostNet(data.code, hostCallbacks());
    app.net = net;
    app.host = GameHost.fromSave(data, {
      remote: { send: (m) => net.send(m), get connected() { return net.connected; } },
      onLocal: onMessage, persist: true,
    });
    app.netStatus = 'opening';
    app.host.push();
    net.start();
  }

  function startSolo(settings, colorPref) {
    teardown();
    app.mode = 'solo';
    const bot = new BotSeat();
    app.host = new GameHost({ code: '', settings, colorPref, myName: myName(), remote: bot, onLocal: onMessage, persist: false });
    bot.host = app.host;
    app.host.names[1] = '';
    app.host.startGame();
  }

  function startJoining(code) {
    if (!window.Peer) { toast(tr('toast.noPeer'), 'err'); return; }
    teardown();
    app.mode = 'guest';
    const map = load(K.client, {});
    const cid = map[code] || rid();
    map[code] = cid;
    save(K.client, map);
    history.replaceState(null, '', location.pathname + '?join=' + code);
    app.netStatus = 'connecting';
    app.msg = null;
    const net = new GuestNet(code, cid, myName(), {
      onMessage,
      onStatus: (s) => {
        const was = app.netStatus;
        app.netStatus = s;
        if (s === 'connected' && was === 'reconnecting') toast(tr('toast.reconnected'));
        if (app.screen === 'room') renderRoom();
        else if (app.screen === 'game') { app.overlaySig = null; render(); }
      },
    });
    app.net = net;
    show('room');
    renderRoom();
    net.start();
  }

  function teardown() {
    if (app.host) { app.host.destroy(); app.host = null; }
    if (app.net) { app.net.destroy(); app.net = null; }
    app.msg = null; app.view = null; app.netStatus = '';
    app.panelSig = app.playersSig = app.logSig = ''; app.overlaySig = null;
    app.anim.token++;
    app.needed = false;
    document.title = tr('doc.title');
  }

  function leave() {
    const v = app.view;
    const inGame = v && v.phase !== 'over' && app.mode !== 'solo';
    if (inGame && !confirm(tr(app.mode === 'host' ? 'confirm.leaveHost' : 'confirm.leaveGuest'))) return;
    if (app.mode === 'host' && (!v || v.phase === 'over')) localStorage.removeItem(K.host);
    teardown();
    app.mode = 'lobby';
    history.replaceState(null, '', location.pathname);
    show('lobby');
    refreshResume();
    hideForms();
  }

  function refreshResume() {
    const data = load(K.host, null);
    const ok = data && data.state && data.state.phase !== 'over' && Date.now() - data.savedAt < 24 * 3600 * 1000;
    $('#resume-card').hidden = !ok;
    if (ok) {
      $('#resume-code').textContent = data.code;
      $('#resume-meta').textContent = tr('resume.meta', { a: data.names[0] || tr('role.host'), b: data.names[1] || '?', n: data.state.round, t: fmtDate(data.savedAt) });
    }
  }

  function setSettingsLabels() {
    const solo = app.formMode === 'solo';
    $('#settings-title').textContent = tr(solo ? 'set.titleSolo' : 'set.titleRoom');
    $('#settings-submit').textContent = tr(solo ? 'set.submitSolo' : 'set.submitRoom');
  }

  function setLang(l) {
    window.I18N.set(l);
    closeModal();
    setSettingsLabels();
    refreshResume();
    app.panelSig = app.playersSig = app.logSig = '';
    app.overlaySig = null;
    if (app.screen === 'room') renderRoom();
    if (app.screen === 'game' && app.view) {
      render();
      document.title = (app.needed ? '● ' : '') + tr('doc.title');
    }
  }

  function hideForms() { $('#settings-form').hidden = true; $('#join-form').hidden = true; }
  function showSettings(mode) {
    app.formMode = mode;
    $('#join-form').hidden = true;
    $('#settings-form').hidden = false;
    setSettingsLabels();
    $('#settings-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ───────── 모달: 규칙 · 스냅샷 ─────────
  function openModal(html) {
    $('#modal-body').innerHTML = html;
    $('#modal').hidden = false;
    replay = null;
  }
  function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; replay = null; }

  function openRecords() {
    const recs = load(K.records, []);
    const items = recs.map((r) => {
      const res = r.result;
      const who = res.winner == null ? tr('res.draw') : tr('rec.won', { name: recName(r, res.winner) });
      const mine = res.winner == null ? '' : tr(res.winner === r.me ? 'rec.myWin' : 'rec.myLoss');
      return `<li><button data-act="open-record" data-id="${esc(r.id)}"><span>${tr('rec.vs', { b: esc(recName(r, r.black)), w: esc(recName(r, 1 - r.black)) })}${r.mode === 'solo' ? ` <small>${tr('rec.practice')}</small>` : ''}</span>
        <small>${fmtDate(r.at)} · ${tr('rec.rounds', { n: r.history.length })} · ${esc(who)}${mine}</small></button></li>`;
    }).join('');
    openModal(`<h2>${tr('rec.title')}</h2><p class="hint" style="color:var(--muted);margin:6px 0 0">${tr('rec.note')}</p>
      ${items ? `<ul class="rec-list">${items}</ul>` : `<p style="color:var(--muted)">${tr('rec.empty')}</p>`}`);
  }

  let replay = null;
  function openReplay(rec) {
    const N = rec.history.length;
    const b = rec.black, wseat = 1 - rec.black;
    const r = rec.result;
    const cname = (seat) => tr(seat === b ? 'color.b' : 'color.w');
    const resText = r.winner == null ? tr('res.draw') : tr('rp.won', { color: cname(r.winner), name: esc(recName(rec, r.winner)) });
    const whyText = r.reason ? tr('rp.why', { why: tr('rp.' + r.reason, { a: Math.max(...r.counts), b: Math.min(...r.counts) }), n: r.round }) : '';
    const ledger = rec.history.map((h) => {
      const cell = (k) => {
        const bb = h.bets[b][k], ww = h.bets[wseat][k], tie = bb === ww;
        return `<td><span class="${h.winners[k] === b ? 'win' : 'lose'}">${bb}</span> : <span class="${h.winners[k] === wseat ? 'win' : 'lose'}">${ww}</span>${tie ? ` <span class="tie-mark">${tr('rp.tie')}</span>` : ''}</td>`;
      };
      const money = (s) => `${h.balance[s]} → ${h.remaining[s]} <small>(+${h.carry[s]})</small>${h.betAuto[s] ? ` <span class="auto-mark">${tr('auto')}</span>` : ''}`;
      return `<tr><td><b>${h.round}</b></td><td>${cname(h.selector)}${h.selectAuto ? ` <span class="auto-mark">${tr('auto')}</span>` : ''}</td>${cell(0)}${cell(1)}${cell(2)}<td>${money(b)}</td><td>${money(wseat)}</td></tr>`;
    }).join('');
    openModal(`<h2>${tr('rp.title', { d: fmtDate(rec.at) })}</h2>
      <p style="color:var(--muted);margin:6px 0 0">${tr('rp.head', { b: esc(recName(rec, b)), w: esc(recName(rec, wseat)), res: resText })}${whyText}</p>
      <div class="replay">
        <div class="replay-board"><svg id="rp-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boardW(rec.size)} ${boardW(rec.size)}">${boardStatic(rec.size, 'r-')}<g id="rp-dyn"></g></svg></div>
        <div>
          <div class="replay-ctrl">
            <button class="icon-btn" data-act="rp-prev" aria-label="${tr('rp.prev')}">◀</button>
            <input type="range" id="rp-range" min="1" max="${Math.max(1, N)}" value="${Math.max(1, N)}" aria-label="${tr('rp.round')}">
            <button class="icon-btn" data-act="rp-next" aria-label="${tr('rp.next')}">▶</button>
            <span class="lab" id="rp-lab"></span>
          </div>
          <div id="rp-detail"></div>
        </div>
      </div>
      <div class="ledger-wrap"><table class="ledger">
        <thead><tr><th>R</th><th>${tr('rp.colPicker')}</th><th>${tr('rp.colSpot', { c: '①' })}</th><th>${tr('rp.colSpot', { c: '②' })}</th><th>${tr('rp.colSpot', { c: '③' })}</th><th>${tr('rp.colMoney', { color: tr('color.b') })}</th><th>${tr('rp.colMoney', { color: tr('color.w') })}</th></tr></thead>
        <tbody>${ledger || `<tr><td colspan="7">${tr('rp.none')}</td></tr>`}</tbody></table></div>`);
    replay = { rec, round: Math.max(1, N) };
    drawReplay();
  }
  function drawReplay() {
    if (!replay) return;
    const { rec, round } = replay;
    const N = rec.history.length;
    const size = rec.size;
    const boardArr = new Array(size * size).fill(PO.EMPTY);
    for (let i = 0; i < Math.min(round, N); i++) {
      const h = rec.history[i];
      h.triple.forEach((c, k) => { boardArr[c] = h.winners[k]; });
    }
    const kind = (seat) => (seat === rec.black ? 'b' : 'w');
    let s = '';
    for (let i = 0; i < boardArr.length; i++) if (boardArr[i] !== PO.EMPTY) s += stoneSvg(size, i, kind(boardArr[i]), 'r-');
    const h = rec.history[round - 1];
    if (h) {
      h.triple.forEach((c, k) => {
        const [cx, cy] = pos(size, c);
        s += `<circle class="last-mark" cx="${cx}" cy="${cy}" r="${R + 3}"/>`;
        s += `<text class="lbl" x="${cx}" y="${cy}" style="fill:${h.winners[k] === rec.black ? '#f1ebdf' : '#14121b'}">${k + 1}</text>`;
      });
    }
    if (round === N && rec.result && rec.result.lines) {
      rec.result.lines.forEach((lines) => lines.forEach((line) => {
        const [x1, y1] = pos(size, line[0]), [x2, y2] = pos(size, line[line.length - 1]);
        s += `<line class="win-line" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
      }));
    }
    $('#rp-dyn').innerHTML = s;
    $('#rp-range').value = round;
    $('#rp-lab').textContent = N ? `R${round} / ${N}` : '—';
    if (!h) { $('#rp-detail').innerHTML = `<p style="color:var(--muted)">${tr('rp.noRound')}</p>`; return; }
    const b = rec.black, w = 1 - rec.black;
    const rows = h.triple.map((c, k) => {
      const tie = h.bets[b][k] === h.bets[w][k];
      return `<tr><td><span class="num">${k + 1}</span> ${PO.coordName(size, c)}</td>
        <td class="${h.winners[k] === b ? 'win' : 'lose'}">${h.bets[b][k]}</td>
        <td class="${h.winners[k] === w ? 'win' : 'lose'}">${h.bets[w][k]}</td>
        <td>${tr(h.winners[k] === b ? 'color.b' : 'color.w')}${tie ? ` <span class="tie-mark">${tr('rp.tieNon')}</span>` : ''}</td></tr>`;
    }).join('');
    $('#rp-detail').innerHTML = `
      <p style="margin:0 0 8px;color:var(--muted)">${tr('rp.picker')} <b style="color:var(--fg)">${tr(h.selector === b ? 'color.b' : 'color.w')} ${esc(recName(rec, h.selector))}</b>${h.selectAuto ? ` <span class="auto-mark">${tr('rp.autoPick')}</span>` : ''}</p>
      <table class="detail"><thead><tr><th>${tr('rp.spot')}</th><th>${tr('color.b')} ${esc(recName(rec, b))}</th><th>${tr('color.w')} ${esc(recName(rec, w))}</th><th>${tr('rp.placed')}</th></tr></thead><tbody>${rows}
        <tr><td><small>${tr('rp.had')}</small></td><td>${h.balance[b]}</td><td>${h.balance[w]}</td><td></td></tr>
        <tr><td><small>${tr('rp.left')}</small></td><td>${h.remaining[b]}</td><td>${h.remaining[w]}</td><td></td></tr>
        <tr><td><small>${tr('rp.carry')}</small></td><td>${h.carry[b]}</td><td>${h.carry[w]}</td><td></td></tr>
      </tbody></table>`;
  }

  // ───────── 이벤트 ─────────
  const handlers = {
    'lang': (b) => setLang(b.dataset.lang),
    'lang-flip': () => { $('#menu').hidden = true; setLang(window.I18N.lang === 'ko' ? 'en' : 'ko'); },
    'show-create': () => showSettings('create'),
    'show-solo': () => showSettings('solo'),
    'show-join': () => { $('#settings-form').hidden = true; $('#join-form').hidden = false; $('#join-code').focus(); },
    'hide-forms': hideForms,
    'resume': () => { save(K.name, myName()); resumeHosting(); },
    'discard-resume': () => { if (confirm(tr('confirm.discard'))) { localStorage.removeItem(K.host); refreshResume(); } },
    'rules': () => { $('#menu').hidden = true; openModal(tr('rules')); },
    'records': openRecords,
    'open-record': (b) => { const rec = load(K.records, []).find((r) => r.id === b.dataset.id); if (rec) openReplay(rec); },
    'close-modal': closeModal,
    'rp-prev': () => { if (replay && replay.round > 1) { replay.round--; drawReplay(); } },
    'rp-next': () => { if (replay && replay.round < replay.rec.history.length) { replay.round++; drawReplay(); } },
    'copy-link': async (b) => {
      const url = $('#share-link').value;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title: tr('doc.title'), text: tr('share.text', { code: app.host.code }), url }); return; } catch (e) { /* 취소 */ }
      }
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {
        const inp = $('#share-link'); inp.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      }
      toast(tr(ok ? 'toast.copied' : 'toast.copyFail'));
      b.blur();
    },
    'start': () => { if (app.host && app.host.remote.connected) app.host.startGame(); },
    'leave': () => { $('#menu').hidden = true; closeModal(); leave(); },
    'menu': () => { $('#menu').hidden = !$('#menu').hidden; },
    'pause': () => {
      const m = app.msg; if (!m || !app.view || app.view.phase === 'over') return;
      act({ t: 'pause', on: !(m.pauses && m.pauses.manual != null) });
    },
    'mute': () => { Sound.muted = !Sound.muted; save(K.mute, Sound.muted); if (!Sound.muted) Sound.clack(); if (app.view) renderBar(); },
    'resign': () => { $('#menu').hidden = true; if (app.view && app.view.phase !== 'over' && confirm(tr('confirm.resign'))) act({ t: 'resign' }); },
    'confirm-sel': () => { if (app.sel.triple) act({ t: 'select', cells: app.sel.triple }); },
    'clear-sel': () => { app.sel.triple = null; app.sel.anchor = null; act({ t: 'draftSel', cells: null }); renderSel(); renderPanel(); },
    'bet-inc': (b) => { const k = +b.dataset.k; setDraft(k, app.draft.bets[k] + 1, true); },
    'bet-dec': (b) => { const k = +b.dataset.k; setDraft(k, app.draft.bets[k] - 1, true); },
    'bet-reset': () => { app.draft.bets = [1, 1, 1]; updateBetUi(); },
    'bet-even': () => {
      const bal = app.view.balance, base = Math.floor(bal / 3), extra = bal - base * 3;
      app.draft.bets = [0, 1, 2].map((k) => base + (k < extra ? 1 : 0));
      updateBetUi();
    },
    'bet-all': (b) => {
      const k = +b.dataset.k, bal = app.view.balance;
      app.draft.bets = [1, 1, 1]; app.draft.bets[k] = bal - 2;
      updateBetUi();
    },
    'confirm-bet': () => {
      const v = app.view, err = PO.validateBets(app.draft.bets, v.balance);
      if (err) { toast(tr('err.' + err.code, err), 'err'); return; }
      act({ t: 'bet', bets: app.draft.bets.slice() });
    },
    'emote': (b) => { const e = b.dataset.e; act({ t: 'emote', e }); if (app.view) showBubble(app.view.me, e); },
    'snapshot': () => {
      const v = app.view; if (!v) return;
      saveRecord(v);
      const rec = load(K.records, []).find((r) => r.id === v.id);
      if (rec) openReplay(rec);
    },
    'rematch': () => act({ t: 'rematch' }),
    'dismiss-overlay': () => { if (app.view) { app.dismissed[app.view.id] = true; renderOverlay(); } },
  };

  document.addEventListener('click', (e) => {
    const menuOpen = !$('#menu').hidden;
    if (menuOpen && !e.target.closest('.menu-wrap')) $('#menu').hidden = true;
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = handlers[b.dataset.act];
    if (fn) { e.preventDefault(); fn(b, e); }
  });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); $('#menu').hidden = true; }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('.stepper input')) {
      const raw = t.value.trim();
      setDraft(+t.dataset.k, raw === '' ? NaN : parseInt(raw, 10), false);
    } else if (t.id === 'join-code') {
      t.value = t.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    } else if (t.id === 'rp-range' && replay) {
      replay.round = +t.value; drawReplay();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('.stepper input')) setDraft(+t.dataset.k, parseInt(t.value, 10), true);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target.matches && e.target.matches('.stepper input')) setDraft(+e.target.dataset.k, parseInt(e.target.value, 10), true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('.stepper input')) {
      setDraft(+e.target.dataset.k, parseInt(e.target.value, 10), true);
      const btn = $('#confirm-bet'); if (btn && !btn.disabled) btn.focus();
    }
  });

  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { settings, colorPref } = readSettingsForm();
    save(K.settings, { settings, colorPref });
    save(K.name, myName());
    if (app.formMode === 'solo') startSolo(settings, colorPref);
    else startHosting(settings, colorPref);
  });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { toast(tr('toast.code4'), 'err'); $('#join-code').focus(); return; }
    save(K.name, myName());
    startJoining(code);
  });
  $('#name').addEventListener('change', () => save(K.name, myName()));

  const svg = $('#board');
  svg.addEventListener('pointermove', (e) => {
    if (!canSelect() || e.pointerType === 'touch') return;
    const c = cellFromEvent(e);
    if (c !== app.sel.hover) { app.sel.hover = c; renderSel(); }
  });
  svg.addEventListener('pointerleave', () => { if (app.sel.hover != null) { app.sel.hover = null; renderSel(); } });
  svg.addEventListener('click', (e) => onCellClick(cellFromEvent(e)));
  document.addEventListener('pointerdown', () => { if (!Sound.muted) Sound.ac(); }, { once: true });

  setInterval(updateTimer, 200);

  // ───────── 처음 열었을 때 ─────────
  window.I18N.applyStatic();
  setSettingsLabels();
  $('#name').value = load(K.name, '') || '';
  writeSettingsForm(load(K.settings, null));
  refreshResume();
  const joinParam = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(joinParam)) {
    $('#join-code').value = joinParam;
    $('#join-form').hidden = false;
    if (myName()) startJoining(joinParam);
    else { $('#name').focus(); toast(tr('toast.enterName')); }
  }

  // 테스트·디버깅용
  window.__po = { app, GameHost, BotSeat };
})();
