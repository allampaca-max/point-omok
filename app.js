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
      this.names = [o.myName || '방장', ''];
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
      this.names[1] = name || '참가자';
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
        if (e instanceof PO.RuleError) this.sendTo(seat, { t: 'err', msg: e.message });
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
  const colorName = (v, seat) => (seat === v.black ? '흑' : '백');
  const nameOf = (v, seat) => v.names[seat] || (seat === 0 ? '방장' : '참가자');

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
        toast(m.msg, 'err');
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
    document.title = (need ? '● ' : '') + '포인트오목';
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
        tags.push(seat === v.selector ? '<span class="tag sel">선택</span>' : '<span class="tag tie" title="동점이면 이 사람의 돌이 놓입니다">동점 유리</span>');
      } else if (v.result && v.result.winner === seat) {
        tags.push('<span class="tag tie">승리</span>');
      }
      let status = '', cls = '';
      if (!me && !m.oppConnected) { status = '연결 끊김'; cls = 'bad'; }
      else if (v.phase === 'select') status = seat === v.selector ? '자리 고르는 중' : '기다리는 중';
      else if (v.phase === 'bet') {
        const locked = me ? !!v.myBet : v.oppLocked;
        status = locked ? '✓ 베팅 확정' : '베팅 중';
        if (locked) cls = 'ok';
      } else if (v.phase === 'reveal') status = '공개 중';
      else if (v.phase === 'over') {
        if (m.rematch[seat]) { status = '✓ 다시 하기'; cls = 'ok'; }
      }
      const pts = me
        ? `<div class="ppoints">${v.balance}<small>P</small></div>`
        : `<div class="ppoints hidden" title="상대 포인트는 비공개">?<small>P</small></div>`;
      return `<div class="pcard ${me ? 'me' : ''}" data-seat="${seat}">
        <div class="pcard-top"><span class="pstone ${kindOf(v, seat)}"></span><span class="pname">${esc(nameOf(v, seat))}</span>${me ? '<span class="pyou">나</span>' : ''}</div>
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
    el.textContent = e;
    $('#bubbles').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  const PHASE_NAME = { select: '자리 선택', bet: '베팅', reveal: '공개', over: '종료' };
  function phaseTotal(v) {
    if (v.phase === 'select') return v.settings.selectSec * 1000;
    if (v.phase === 'bet') return v.settings.betSec * 1000;
    if (v.phase === 'reveal') return REVEAL_MS;
    return 0;
  }
  function renderPhaseLabel() {
    const v = app.view;
    $('#phase-label').innerHTML = v.phase === 'over'
      ? `게임 종료 <small>· ${v.round}라운드</small>`
      : `라운드 ${v.round} <small>· ${PHASE_NAME[v.phase]}</small>`;
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
      el.textContent = '일시정지';
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
        return `<h3>자리 고르기</h3>
          <p>한 줄(가로·세로·대각선)로 이어진 빈 자리 3개를 고르세요. 첫 자리를 누르고, <b>두 칸 떨어진 끝자리</b>나 <b>바로 옆 칸</b>을 누르면 됩니다.</p>
          ${t ? tripleChips(v, t) : '<div class="sel-chips"><span class="sel-chip empty">아직 고르지 않았습니다</span></div>'}
          <div class="row">
            <button class="btn primary" data-act="confirm-sel" ${t ? '' : 'disabled'}>이 3점으로 확정</button>
            <button class="btn ghost" data-act="clear-sel" ${t || app.sel.anchor != null ? '' : 'disabled'}>다시 고르기</button>
          </div>
          <p class="hint">동점이면 <b>${esc(nameOf(v, opp))}</b>의 돌이 놓입니다. 시간이 다 되면 지금 고른 3점(없으면 무작위 3점)으로 확정됩니다.</p>`;
      }
      return `<h3>${esc(nameOf(v, v.selector))} 님이 자리를 고르는 중</h3>
        <p>세 자리가 정해지면 바로 베팅이 시작됩니다. 이번 라운드 내 포인트는 <b>${v.balance}P</b>.</p>
        <p class="hint">이번 라운드는 동점이면 <b>내 돌</b>이 놓입니다.</p>`;
    }
    if (v.phase === 'bet') {
      const tieTo = v.selector === v.me ? `${esc(nameOf(v, opp))}의 돌` : '내 돌';
      if (v.myBet) {
        const spent = PO.sum(v.myBet), rem = v.balance - spent;
        return `<h3>베팅 완료</h3>
          ${tripleChips(v, v.triple)}
          <div class="locked">${v.myBet.map((b, k) => `<span class="num">${k + 1}</span><span class="v">${b}</span>`).join('')}</div>
          <p>남은 <b>${rem}P</b> → 다음 라운드 이월 <b>${Math.floor(rem / 2)}P</b>${v.myBetAuto ? ' <span class="auto-mark">(시간 초과 자동 제출)</span>' : ''}</p>
          <p class="hint">${v.oppLocked ? '상대도 확정했습니다. 곧 공개됩니다.' : '상대가 베팅하는 중입니다…'}</p>`;
      }
      return `<h3>베팅</h3>
        <p>보유 <b>${v.balance}P</b>를 세 자리에 나눠 거세요. 자리마다 1P 이상. 동점이면 <b>${tieTo}</b>이 놓입니다.</p>
        <div class="bet-rows">${[0, 1, 2].map((k) => `
          <div class="bet-row" data-k="${k}">
            <span class="num">${k + 1}</span><span class="bet-coord">${PO.coordName(v.size, v.triple[k])}</span>
            <div class="stepper">
              <button data-act="bet-dec" data-k="${k}" aria-label="${k + 1}번 자리 1 줄이기">−</button>
              <input type="number" inputmode="numeric" min="1" step="1" data-k="${k}" aria-label="${k + 1}번 자리 베팅">
              <button data-act="bet-inc" data-k="${k}" aria-label="${k + 1}번 자리 1 늘리기">+</button>
            </div>
          </div>`).join('')}
        </div>
        <div class="quick">
          <button data-act="bet-reset" title="세 자리 모두 1포인트">1·1·1</button>
          <button data-act="bet-even" title="가진 포인트를 전부 고르게">고르게</button>
          <button data-act="bet-all" data-k="0" title="나머지는 1씩, 남은 포인트 전부 ①에">①올인</button>
          <button data-act="bet-all" data-k="1" title="나머지는 1씩, 남은 포인트 전부 ②에">②올인</button>
          <button data-act="bet-all" data-k="2" title="나머지는 1씩, 남은 포인트 전부 ③에">③올인</button>
        </div>
        <div class="bet-sum">
          <div><b id="bs-spent">3</b><span>베팅</span></div>
          <div id="bs-rem-box"><b id="bs-rem">0</b><span>남음</span></div>
          <div class="carry"><b id="bs-carry">0</b><span>다음 라운드 이월</span></div>
        </div>
        <button class="btn primary wide" data-act="confirm-bet" id="confirm-bet">베팅 확정</button>
        <p class="hint">남긴 포인트는 절반(내림)만 넘어갑니다. 시간이 다 되면 지금 입력한 값으로 제출됩니다.</p>`;
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
            <span class="mine">내 베팅 ${h.bets[v.me][k]}</span>
            <span class="who"><span class="pstone ${kindOf(v, w)}"></span>${esc(nameOf(v, w))}</span></li>`;
        }).join('')}</ul>`;
      }
      if (v.phase === 'reveal') {
        const carry = h.carry[v.me];
        return `<h3>결과 공개</h3>${list}
          <p>남은 ${h.remaining[v.me]}P → 이월 <b>${carry}P</b>. 다음 라운드 내 포인트 <b>${carry + v.settings.grant}P</b>.</p>
          <p class="hint">다음 라운드 선택: <b>${esc(nameOf(v, 1 - v.selector))}</b></p>`;
      }
      // over
      const r = v.result, m = app.msg;
      const head = r.winner == null ? '무승부' : r.winner === v.me ? '승리!' : '패배';
      const sub = r.winner == null ? reasonText(v) : `${colorName(v, r.winner)} ${esc(nameOf(v, r.winner))} 승 · ${reasonText(v)}`;
      const iWant = m.rematch[v.me], theyWant = m.rematch[opp];
      return `${list}
        <div class="win-text">${head}</div>
        <p>${sub}</p>
        <button class="btn wide" data-act="snapshot">스냅샷 보기 · 모든 베팅 공개</button>
        <button class="btn primary wide" data-act="rematch" ${iWant ? 'disabled' : ''}>${iWant ? '상대를 기다리는 중…' : '다시 하기 (흑백 바꿔서)'}</button>
        ${theyWant && !iWant ? `<p class="hint">${esc(nameOf(v, opp))} 님이 다시 하기를 원합니다.</p>` : ''}
        <button class="btn ghost wide" data-act="leave">로비로</button>`;
    }
    return '';
  }

  function reasonText(v) {
    const r = v.result;
    switch (r.reason) {
      case 'omok': return `${r.round}라운드에 오목 완성`;
      case 'more': return `둘 다 오목 — ${Math.max(...r.counts)}개 대 ${Math.min(...r.counts)}개`;
      case 'majority': return `둘 다 오목 ${r.counts[0]}개 — 그 라운드 3점 중 2점 이상을 가져감`;
      case 'resign': return `${esc(nameOf(v, 1 - r.winner))} 기권`;
      case 'full': return '더 고를 3점이 없어 무승부';
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
        <span>선택 ${esc(nameOf(v, h.selector))}${h.selectAuto ? ' <span class="auto-mark">자동</span>' : ''}</span>
        <small>내 베팅 ${mine ? mine.join('·') : '-'} · 이월 ${h.carry[v.me]}</small></li>`;
    }).join('') || '<li><small>아직 기록이 없습니다.</small></li>';
  }

  function renderOverlay() {
    const v = app.view, m = app.msg, el = $('#overlay');
    let html = '';
    if (app.mode === 'guest' && app.netStatus !== 'connected') {
      html = `<div class="overlay-card"><h2>연결이 끊겼습니다</h2><p>방장과 다시 연결하는 중<span class="dots"></span><br>타이머는 멈춰 있습니다.</p>
        <button class="btn ghost" data-act="leave">나가기</button></div>`;
    } else if (v.phase !== 'over' && !m.oppConnected) {
      html = `<div class="overlay-card"><h2>상대 연결 끊김</h2><p>${esc(nameOf(v, 1 - v.me))} 님이 돌아오기를 기다리는 중<span class="dots"></span><br>타이머는 멈춰 있습니다. 같은 방 코드(<b>${esc(m.code)}</b>)로 다시 들어오면 이어집니다.</p></div>`;
    } else if (v.phase === 'over' && animStep() >= 4 && !app.dismissed[v.id]) {
      const r = v.result;
      const head = r.winner == null ? '무승부' : r.winner === v.me ? '승리!' : '패배';
      const sub = r.winner == null ? reasonText(v) : `${colorName(v, r.winner)} ${esc(nameOf(v, r.winner))} 승 · ${reasonText(v)}`;
      html = `<div class="overlay-card win"><h2>${head}</h2><p>${sub}</p>
        <div class="row center"><button class="btn primary" data-act="snapshot">스냅샷 보기</button><button class="btn ghost" data-act="dismiss-overlay">판 보기</button></div></div>`;
    } else if (m.paused && m.pauses && m.pauses.manual != null) {
      const by = m.pauses.manual;
      html = `<div class="overlay-card"><h2>일시정지</h2><p>${esc(nameOf(v, by))} 님이 멈췄습니다.</p><button class="btn primary" data-act="pause">다시 시작</button></div>`;
    }
    if (html === app.overlaySig) return;
    app.overlaySig = html;
    el.innerHTML = html;
    el.hidden = !html;
  }

  function renderBar() {
    const v = app.view, m = app.msg;
    $('#code-chip').textContent = app.mode === 'solo' ? '연습' : (m.code || '');
    const net = $('#net');
    if (app.mode === 'solo') { net.textContent = ''; net.className = 'net'; }
    else if (app.mode === 'guest') {
      const ok = app.netStatus === 'connected';
      net.textContent = ok ? '연결됨' : '재연결 중';
      net.className = 'net ' + (ok ? 'ok' : 'bad');
    } else {
      net.textContent = m.oppConnected ? '상대 연결됨' : '상대 없음';
      net.className = 'net ' + (m.oppConnected ? 'ok' : 'bad');
    }
    const manual = !!(m.pauses && m.pauses.manual != null);
    const pb = $('#pause-btn');
    pb.classList.toggle('on', manual);
    pb.disabled = v.phase === 'over';
    pb.title = manual ? '다시 시작' : '일시정지';
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
    const color = colorPref ? ` · 방장 돌 ${{ random: '랜덤', black: '흑', white: '백' }[colorPref]}` : '';
    return `${s.size}×${s.size} · 선택 ${s.selectSec}초 · 베팅 ${s.betSec}초${color} · 장목 불인정`;
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
      if (app.netStatus === 'opening') status = '방을 여는 중<span class="dots"></span>';
      else if (app.netStatus === 'waitid') status = '이전 연결이 정리되기를 기다리는 중<span class="dots"></span>';
      else if (m && m.guestHere) status = `<b>${esc(m.names[1])}</b> 님이 들어왔습니다. 게임을 시작하세요.`;
      else status = '상대를 기다리는 중<span class="dots"></span> 코드나 링크를 보내 주세요.';
    } else {
      status = {
        connecting: '방에 연결하는 중<span class="dots"></span>',
        connected: '방장이 게임을 시작하기를 기다리는 중<span class="dots"></span>',
        reconnecting: '연결이 끊겨 다시 연결하는 중<span class="dots"></span>',
        notfound: '방을 찾지 못했습니다. 코드를 확인하거나 방장이 방을 열었는지 확인하세요.',
        full: '이미 다른 사람이 들어와 있는 방입니다.',
      }[app.netStatus] || '연결 중<span class="dots"></span>';
    }
    $('#room-status').innerHTML = status;
    const names = m ? m.names : [isHost ? myName() : '', ''];
    const me = isHost ? 0 : 1;
    const here = isHost ? !!(m && m.guestHere) : !!m;
    $('#room-players').innerHTML = [0, 1].map((seat) => {
      const present = seat === 0 ? (isHost || !!m) : here;
      if (!present) return `<li class="empty">${seat === 0 ? '방장' : '빈 자리'}</li>`;
      return `<li><span>${esc(names[seat] || (seat === 0 ? '방장' : '참가자'))}${seat === me ? ' <small>(나)</small>' : ''}</span><small>${seat === 0 ? '방장' : '참가자'}</small></li>`;
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
        toast(`${name || '참가자'} 님이 들어왔습니다.`);
      },
      onMessage: (m) => { if (app.host) app.host.handle(1, m); },
      onDrop: () => {
        if (!app.host) return;
        app.host.guestLeft();
        toast('상대 연결이 끊겼습니다.', 'err');
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
          toast('이 브라우저는 실시간 연결(WebRTC)을 지원하지 않습니다.', 'err');
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          toast('연결 서버와 통신이 불안정합니다. 다시 시도하는 중…', 'err');
          setTimeout(() => { if (app.net && app.net.peer && app.net.peer.destroyed) app.net.start(); }, 4000);
        } else {
          console.warn('peer error', err.type, err);
        }
      },
    };
  }

  function startHosting(settings, colorPref) {
    if (!window.Peer) { toast('연결 라이브러리(PeerJS)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.', 'err'); return; }
    teardown();
    app.mode = 'host';
    const code = makeCode();
    const net = new HostNet(code, hostCallbacks());
    app.net = net;
    app.host = new GameHost({
      code, settings, colorPref, myName: myName() || '방장',
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
    if (!window.Peer) { toast('연결 라이브러리(PeerJS)를 불러오지 못했습니다.', 'err'); return; }
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
    app.host = new GameHost({ code: '', settings, colorPref, myName: myName() || '나', remote: bot, onLocal: onMessage, persist: false });
    bot.host = app.host;
    app.host.names[1] = '봇';
    app.host.startGame();
  }

  function startJoining(code) {
    if (!window.Peer) { toast('연결 라이브러리(PeerJS)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.', 'err'); return; }
    teardown();
    app.mode = 'guest';
    const map = load(K.client, {});
    const cid = map[code] || rid();
    map[code] = cid;
    save(K.client, map);
    history.replaceState(null, '', location.pathname + '?join=' + code);
    app.netStatus = 'connecting';
    app.msg = null;
    const net = new GuestNet(code, cid, myName() || '참가자', {
      onMessage,
      onStatus: (s) => {
        const was = app.netStatus;
        app.netStatus = s;
        if (s === 'connected' && was === 'reconnecting') toast('다시 연결되었습니다.');
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
    document.title = '포인트오목';
  }

  function leave() {
    const v = app.view;
    const inGame = v && v.phase !== 'over' && app.mode !== 'solo';
    if (inGame && !confirm(app.mode === 'host' ? '나가면 이 방이 닫힙니다. 나갈까요?\n(나중에 로비에서 "이어하기"로 다시 열 수 있습니다)' : '게임에서 나갈까요? 같은 코드로 다시 들어오면 이어집니다.')) return;
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
      $('#resume-meta').textContent = `${data.names[0]} vs ${data.names[1] || '?'} · ${data.state.round}라운드 · ${fmtDate(data.savedAt)} 저장`;
    }
  }

  function hideForms() { $('#settings-form').hidden = true; $('#join-form').hidden = true; }
  function showSettings(mode) {
    app.formMode = mode;
    $('#join-form').hidden = true;
    $('#settings-form').hidden = false;
    $('#settings-title').textContent = mode === 'solo' ? '연습 설정' : '방 설정';
    $('#settings-submit').textContent = mode === 'solo' ? '연습 시작' : '방 열기';
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
      const who = res.winner == null ? '무승부' : `${r.names[res.winner]} 승`;
      const mine = res.winner == null ? '' : res.winner === r.me ? ' · 내 승리' : ' · 내 패배';
      return `<li><button data-act="open-record" data-id="${esc(r.id)}"><span><b>${esc(r.names[r.black])}</b>(흑) vs <b>${esc(r.names[1 - r.black])}</b>(백)${r.mode === 'solo' ? ' <small>연습</small>' : ''}</span>
        <small>${fmtDate(r.at)} · ${r.history.length}라운드 · ${esc(who)}${mine}</small></button></li>`;
    }).join('');
    openModal(`<h2>지난 게임 스냅샷</h2><p class="hint" style="color:var(--muted);margin:6px 0 0">이 기기에 저장된 게임입니다. 끝난 게임은 두 사람의 모든 베팅이 공개됩니다.</p>
      ${items ? `<ul class="rec-list">${items}</ul>` : '<p style="color:var(--muted)">아직 끝난 게임이 없습니다.</p>'}`);
  }

  let replay = null;
  function openReplay(rec) {
    const N = rec.history.length;
    const b = rec.black, wseat = 1 - rec.black;
    const r = rec.result;
    const resText = r.winner == null ? '무승부' : `${r.winner === b ? '흑' : '백'} ${esc(rec.names[r.winner])} 승리`;
    const reasonMap = { omok: '오목 완성', more: `오목 ${Math.max(...r.counts)}개 대 ${Math.min(...r.counts)}개`, majority: '오목 수 동점 → 그 라운드 3점 중 2점 이상', resign: '기권', full: '둘 곳 없음' };
    const ledger = rec.history.map((h) => {
      const cell = (k) => {
        const bb = h.bets[b][k], ww = h.bets[wseat][k], tie = bb === ww;
        return `<td><span class="${h.winners[k] === b ? 'win' : 'lose'}">${bb}</span> : <span class="${h.winners[k] === wseat ? 'win' : 'lose'}">${ww}</span>${tie ? ' <span class="tie-mark">동점</span>' : ''}</td>`;
      };
      const money = (s) => `${h.balance[s]} → ${h.remaining[s]} <small>(+${h.carry[s]})</small>${h.betAuto[s] ? ' <span class="auto-mark">자동</span>' : ''}`;
      return `<tr><td><b>${h.round}</b></td><td>${h.selector === b ? '흑' : '백'}${h.selectAuto ? ' <span class="auto-mark">자동</span>' : ''}</td>${cell(0)}${cell(1)}${cell(2)}<td>${money(b)}</td><td>${money(wseat)}</td></tr>`;
    }).join('');
    openModal(`<h2>스냅샷 · ${fmtDate(rec.at)}</h2>
      <p style="color:var(--muted);margin:6px 0 0">흑 <b style="color:var(--fg)">${esc(rec.names[b])}</b> vs 백 <b style="color:var(--fg)">${esc(rec.names[wseat])}</b> — ${resText}${r.reason ? ` (${reasonMap[r.reason] || ''}, ${r.round}라운드)` : ''}</p>
      <div class="replay">
        <div class="replay-board"><svg id="rp-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${boardW(rec.size)} ${boardW(rec.size)}">${boardStatic(rec.size, 'r-')}<g id="rp-dyn"></g></svg></div>
        <div>
          <div class="replay-ctrl">
            <button class="icon-btn" data-act="rp-prev" aria-label="이전 라운드">◀</button>
            <input type="range" id="rp-range" min="1" max="${Math.max(1, N)}" value="${Math.max(1, N)}" aria-label="라운드">
            <button class="icon-btn" data-act="rp-next" aria-label="다음 라운드">▶</button>
            <span class="lab" id="rp-lab"></span>
          </div>
          <div id="rp-detail"></div>
        </div>
      </div>
      <div class="ledger-wrap"><table class="ledger">
        <thead><tr><th>R</th><th>선택</th><th>① 흑:백</th><th>② 흑:백</th><th>③ 흑:백</th><th>흑 보유→남음 (이월)</th><th>백 보유→남음 (이월)</th></tr></thead>
        <tbody>${ledger || '<tr><td colspan="7">기록 없음</td></tr>'}</tbody></table></div>`);
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
    if (!h) { $('#rp-detail').innerHTML = '<p style="color:var(--muted)">라운드 기록이 없습니다.</p>'; return; }
    const b = rec.black, w = 1 - rec.black;
    const rows = h.triple.map((c, k) => {
      const tie = h.bets[b][k] === h.bets[w][k];
      return `<tr><td><span class="num">${k + 1}</span> ${PO.coordName(size, c)}</td>
        <td class="${h.winners[k] === b ? 'win' : 'lose'}">${h.bets[b][k]}</td>
        <td class="${h.winners[k] === w ? 'win' : 'lose'}">${h.bets[w][k]}</td>
        <td>${h.winners[k] === b ? '흑' : '백'}${tie ? ' <span class="tie-mark">동점→비선택자</span>' : ''}</td></tr>`;
    }).join('');
    $('#rp-detail').innerHTML = `
      <p style="margin:0 0 8px;color:var(--muted)">선택: <b style="color:var(--fg)">${h.selector === b ? '흑' : '백'} ${esc(rec.names[h.selector])}</b>${h.selectAuto ? ' <span class="auto-mark">시간 초과 자동</span>' : ''}</p>
      <table class="detail"><thead><tr><th>자리</th><th>흑 ${esc(rec.names[b])}</th><th>백 ${esc(rec.names[w])}</th><th>착수</th></tr></thead><tbody>${rows}
        <tr><td><small>보유</small></td><td>${h.balance[b]}</td><td>${h.balance[w]}</td><td></td></tr>
        <tr><td><small>남음</small></td><td>${h.remaining[b]}</td><td>${h.remaining[w]}</td><td></td></tr>
        <tr><td><small>이월</small></td><td>${h.carry[b]}</td><td>${h.carry[w]}</td><td></td></tr>
      </tbody></table>`;
  }

  // ───────── 이벤트 ─────────
  const handlers = {
    'show-create': () => showSettings('create'),
    'show-solo': () => showSettings('solo'),
    'show-join': () => { $('#settings-form').hidden = true; $('#join-form').hidden = false; $('#join-code').focus(); },
    'hide-forms': hideForms,
    'resume': () => { save(K.name, myName()); resumeHosting(); },
    'discard-resume': () => { if (confirm('저장된 방을 버릴까요?')) { localStorage.removeItem(K.host); refreshResume(); } },
    'rules': () => { $('#menu').hidden = true; openModal($('#rules-tpl').innerHTML); },
    'records': openRecords,
    'open-record': (b) => { const rec = load(K.records, []).find((r) => r.id === b.dataset.id); if (rec) openReplay(rec); },
    'close-modal': closeModal,
    'rp-prev': () => { if (replay && replay.round > 1) { replay.round--; drawReplay(); } },
    'rp-next': () => { if (replay && replay.round < replay.rec.history.length) { replay.round++; drawReplay(); } },
    'copy-link': async (b) => {
      const url = $('#share-link').value;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try { await navigator.share({ title: '포인트오목', text: `포인트오목 한 판! 방 코드 ${app.host.code}`, url }); return; } catch (e) { /* 취소 */ }
      }
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {
        const inp = $('#share-link'); inp.select();
        try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      }
      toast(ok ? '링크를 복사했습니다.' : '복사하지 못했습니다. 주소를 직접 복사해 주세요.');
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
    'resign': () => { $('#menu').hidden = true; if (app.view && app.view.phase !== 'over' && confirm('정말 기권할까요?')) act({ t: 'resign' }); },
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
      if (err) { toast(err, 'err'); return; }
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
    if (!/^[A-Z0-9]{4}$/.test(code)) { toast('방 코드는 4자리입니다.', 'err'); $('#join-code').focus(); return; }
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
  $('#name').value = load(K.name, '') || '';
  writeSettingsForm(load(K.settings, null));
  refreshResume();
  const joinParam = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(joinParam)) {
    $('#join-code').value = joinParam;
    $('#join-form').hidden = false;
    if (myName()) startJoining(joinParam);
    else { $('#name').focus(); toast('이름을 적고 입장을 누르세요.'); }
  }

  // 테스트·디버깅용
  window.__po = { app, GameHost, BotSeat };
})();
