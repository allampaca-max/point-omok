/* 포인트오목 규칙 엔진.
 *
 * DOM에 의존하지 않는다. 브라우저에서는 window.PO, 테스트(jsc)에서는 globalThis.PO 로 쓴다.
 * 좌석(seat) 0 = 방장, 1 = 참가자(또는 봇).
 * 판(board)의 값: -1 = 빈 칸, 0/1 = 그 칸을 차지한 좌석.
 *
 * 규칙 요약
 *  - 라운드마다 선택 플레이어가 한 직선 위의 연속된 빈 칸 3개를 고른다(가로·세로·대각선).
 *  - 두 사람은 각자 받은 포인트(10 + 지난 라운드 이월분)를 세 칸에 나눠 건다.
 *    칸마다 1 이상, 정수, 합계는 보유 포인트 이하.
 *  - 칸마다 더 많이 건 사람의 돌이 놓인다. 같으면 선택 플레이어가 아닌 사람의 돌.
 *  - 쓰고 남은 포인트는 절반(내림)만 다음 라운드로 이월된다.
 *  - 세 돌이 모두 놓인 뒤 오목(정확히 5개, 장목 불인정)이 있으면 승부가 난다.
 *    둘 다 있으면 오목 개수가 많은 쪽, 개수도 같으면 그 라운드 3점 중 2점 이상을 딴 쪽이 이긴다.
 *  - 고를 수 있는 3점이 더 없으면 무승부.
 */
(function (root) {
  'use strict';

  const EMPTY = -1;
  const LINE_DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // [dx, dy]
  const DEFAULTS = Object.freeze({ size: 15, selectSec: 90, betSec: 60, grant: 10, exactFive: true });
  const OPTIONS = Object.freeze({ size: [15, 19], selectSec: [60, 90, 120], betSec: [30, 60, 90] });
  const COLS = 'ABCDEFGHJKLMNOPQRST'; // 바둑식 표기(I 생략)

  class RuleError extends Error {}

  const idx = (size, x, y) => y * size + x;
  const xy = (size, i) => [i % size, Math.floor(i / size)];
  const inBounds = (size, x, y) => x >= 0 && y >= 0 && x < size && y < size;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const coordName = (size, i) => { const [x, y] = xy(size, i); return COLS[x] + (size - y); };

  function cleanSettings(s) {
    const out = Object.assign({}, DEFAULTS);
    s = s || {};
    for (const k of Object.keys(OPTIONS)) {
      const v = Number(s[k]);
      if (OPTIONS[k].includes(v)) out[k] = v;
    }
    return out;
  }

  // 세 칸이 한 직선 위에서 연속인지 확인하고, 일정한 순서(x 오름차순, 같으면 y 오름차순)로 돌려준다.
  function normalizeTriple(size, cells) {
    if (!Array.isArray(cells) || cells.length !== 3) return null;
    const pts = [];
    for (const i of cells) {
      if (!Number.isInteger(i) || i < 0 || i >= size * size) return null;
      pts.push(xy(size, i));
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return null;
    if (pts[2][0] - pts[1][0] !== dx || pts[2][1] - pts[1][1] !== dy) return null;
    return pts.map(([x, y]) => idx(size, x, y));
  }

  function emptyTriple(board, size, cells) {
    const t = normalizeTriple(size, cells);
    return t && t.every((i) => board[i] === EMPTY) ? t : null;
  }

  function forEachTriple(board, size, fn) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        for (const [dx, dy] of LINE_DIRS) {
          const x2 = x + 2 * dx, y2 = y + 2 * dy;
          if (!inBounds(size, x2, y2)) continue;
          const a = idx(size, x, y), b = idx(size, x + dx, y + dy), c = idx(size, x2, y2);
          if (board[a] === EMPTY && board[b] === EMPTY && board[c] === EMPTY) {
            if (fn(normalizeTriple(size, [a, b, c])) === false) return;
          }
        }
      }
    }
  }

  function allTriples(board, size) {
    const out = [];
    forEachTriple(board, size, (t) => { out.push(t); });
    return out;
  }

  function hasAnyTriple(board, size) {
    let found = false;
    forEachTriple(board, size, () => { found = true; return false; });
    return found;
  }

  // 화면 보조: 기준점 a를 누른 뒤 b를 눌렀을 때 만들어지는 3점.
  // b가 a에서 두 칸 떨어진 직선 위면 a~b, 바로 옆이면 a·b·(b 다음 칸), 안 되면 (a 이전 칸)·a·b.
  function tripleFromClicks(board, size, a, b) {
    if (a === b) return null;
    const [ax, ay] = xy(size, a), [bx, by] = xy(size, b);
    const dx = bx - ax, dy = by - ay, adx = Math.abs(dx), ady = Math.abs(dy);
    const straight = adx === 0 || ady === 0 || adx === ady;
    const cands = [];
    if (straight && Math.max(adx, ady) === 2) {
      cands.push([a, idx(size, ax + Math.sign(dx), ay + Math.sign(dy)), b]);
    } else if (Math.max(adx, ady) === 1) {
      if (inBounds(size, bx + dx, by + dy)) cands.push([a, b, idx(size, bx + dx, by + dy)]);
      if (inBounds(size, ax - dx, ay - dy)) cands.push([idx(size, ax - dx, ay - dy), a, b]);
    }
    for (const c of cands) {
      const t = emptyTriple(board, size, c);
      if (t) return t;
    }
    return null;
  }

  // 기준점 a에서 누를 수 있는 두 번째 칸들(화면 힌트용).
  function clickTargets(board, size, a) {
    const [ax, ay] = xy(size, a);
    const out = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = ax + dx, y = ay + dy;
        if (!inBounds(size, x, y)) continue;
        const b = idx(size, x, y);
        if (board[b] === EMPTY && tripleFromClicks(board, size, a, b)) out.push(b);
      }
    }
    return out;
  }

  function newGame(settings, black, rng) {
    const s = cleanSettings(settings);
    rng = rng || Math.random;
    return {
      v: 1,
      id: Date.now().toString(36) + '-' + Math.floor(rng() * 1e9).toString(36),
      startedAt: Date.now(),
      size: s.size,
      settings: s,
      names: ['', ''],
      black: black, // 흑을 쥔 좌석. 흑이 1라운드 선택 플레이어.
      board: new Array(s.size * s.size).fill(EMPTY),
      round: 1,
      phase: 'select', // select → bet → reveal → select ... → over
      selector: black,
      triple: null,
      selectAuto: false,
      balance: [s.grant, s.grant],
      bets: [null, null],
      betAuto: [false, false],
      history: [],
      lastReveal: null,
      result: null,
    };
  }

  function applySelect(state, seat, cells, auto) {
    if (state.phase !== 'select') throw new RuleError('지금은 자리를 고르는 단계가 아닙니다.');
    if (seat !== state.selector) throw new RuleError('이번 라운드의 선택 플레이어가 아닙니다.');
    const t = emptyTriple(state.board, state.size, cells);
    if (!t) throw new RuleError('한 줄로 이어진 빈 자리 3개를 골라 주세요.');
    state.triple = t;
    state.selectAuto = !!auto;
    state.bets = [null, null];
    state.betAuto = [false, false];
    state.phase = 'bet';
    return t;
  }

  function randomTriple(state, rng) {
    const all = allTriples(state.board, state.size);
    if (!all.length) return null;
    return all[Math.floor((rng || Math.random)() * all.length)];
  }

  function validateBets(bets, balance) {
    if (!Array.isArray(bets) || bets.length !== 3) return '세 자리 모두에 걸어야 합니다.';
    for (const b of bets) {
      if (!Number.isInteger(b) || b < 1) return '자리마다 1포인트 이상, 정수로 걸어야 합니다.';
    }
    if (sum(bets) > balance) return `가진 포인트(${balance})보다 많이 걸 수 없습니다.`;
    return null;
  }

  // 시간 초과 시 제출할 베팅: 그때까지의 입력을 정리한다(빈 칸은 1, 넘치면 큰 칸부터 깎음).
  function autoBets(draft, balance) {
    const b = [0, 1, 2].map((k) => {
      const v = Math.floor(Number(draft && draft[k]));
      return Number.isFinite(v) && v >= 1 ? v : 1;
    });
    let total = sum(b);
    while (total > balance) {
      const k = b.indexOf(Math.max(...b));
      if (b[k] <= 1) break;
      b[k]--; total--;
    }
    return b;
  }

  // 베팅을 확정한다. 두 사람 모두 확정했으면 true.
  function applyBet(state, seat, bets, auto) {
    if (state.phase !== 'bet') throw new RuleError('지금은 베팅 단계가 아닙니다.');
    if (state.bets[seat]) throw new RuleError('이미 베팅을 확정했습니다.');
    const err = validateBets(bets, state.balance[seat]);
    if (err) throw new RuleError(err);
    state.bets[seat] = bets.slice();
    state.betAuto[seat] = !!auto;
    return !!(state.bets[0] && state.bets[1]);
  }

  // seat의 돌로 이루어진 오목 줄 목록. exact면 정확히 5개인 줄만, 아니면 5개 이상.
  function findFives(board, size, seat, exact) {
    const lines = [];
    for (const [dx, dy] of LINE_DIRS) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (board[idx(size, x, y)] !== seat) continue;
          const px = x - dx, py = y - dy;
          if (inBounds(size, px, py) && board[idx(size, px, py)] === seat) continue; // 줄의 시작점만 센다
          const cells = [];
          let cx = x, cy = y;
          while (inBounds(size, cx, cy) && board[idx(size, cx, cy)] === seat) {
            cells.push(idx(size, cx, cy));
            cx += dx; cy += dy;
          }
          if (exact ? cells.length === 5 : cells.length >= 5) lines.push(cells);
        }
      }
    }
    return lines;
  }

  function checkWin(board, size, exact, roundWinners) {
    const lines = [findFives(board, size, 0, exact), findFives(board, size, 1, exact)];
    const counts = [lines[0].length, lines[1].length];
    if (!counts[0] && !counts[1]) return null;
    let winner, reason;
    if (!counts[1]) { winner = 0; reason = 'omok'; }
    else if (!counts[0]) { winner = 1; reason = 'omok'; }
    else if (counts[0] !== counts[1]) { winner = counts[0] > counts[1] ? 0 : 1; reason = 'more'; }
    else { winner = roundWinners.filter((w) => w === 0).length >= 2 ? 0 : 1; reason = 'majority'; }
    return { winner, reason, counts, lines };
  }

  // 두 베팅이 모두 확정된 뒤 호출. 돌을 놓고, 이월을 계산하고, 승부를 판정한다.
  function resolveRound(state) {
    if (state.phase !== 'bet' || !state.bets[0] || !state.bets[1]) throw new RuleError('아직 두 사람의 베팅이 끝나지 않았습니다.');
    const other = 1 - state.selector;
    const ties = [];
    const winners = state.triple.map((cell, k) => {
      const b0 = state.bets[0][k], b1 = state.bets[1][k];
      if (b0 === b1) { ties.push(k); return other; }
      return b0 > b1 ? 0 : 1;
    });
    winners.forEach((w, k) => { state.board[state.triple[k]] = w; });
    const remaining = [0, 1].map((s) => state.balance[s] - sum(state.bets[s]));
    const carry = remaining.map((r) => Math.floor(r / 2));
    const rec = {
      round: state.round,
      selector: state.selector,
      triple: state.triple.slice(),
      selectAuto: state.selectAuto,
      balance: state.balance.slice(),
      bets: [state.bets[0].slice(), state.bets[1].slice()],
      betAuto: state.betAuto.slice(),
      winners,
      ties,
      remaining,
      carry,
    };
    state.history.push(rec);
    state.lastReveal = { round: state.round, triple: rec.triple, winners };
    const win = checkWin(state.board, state.size, state.settings.exactFive, winners);
    if (win) {
      state.phase = 'over';
      state.result = Object.assign({ round: state.round }, win);
    } else if (!hasAnyTriple(state.board, state.size)) {
      state.phase = 'over';
      state.result = { round: state.round, winner: null, reason: 'full', counts: [0, 0], lines: [[], []] };
    } else {
      state.phase = 'reveal';
    }
    return rec;
  }

  function nextRound(state) {
    if (state.phase !== 'reveal') throw new RuleError('다음 라운드로 넘어갈 수 없습니다.');
    const last = state.history[state.history.length - 1];
    state.round += 1;
    state.selector = 1 - state.selector;
    state.balance = last.carry.map((c) => c + state.settings.grant);
    state.triple = null;
    state.selectAuto = false;
    state.bets = [null, null];
    state.betAuto = [false, false];
    state.phase = 'select';
  }

  function resign(state, seat) {
    if (state.phase === 'over') throw new RuleError('이미 끝난 게임입니다.');
    state.phase = 'over';
    state.result = { round: state.round, winner: 1 - seat, reason: 'resign', counts: [0, 0], lines: [[], []] };
  }

  // 한 좌석에게 보여 줄 상태. 게임이 끝나기 전에는 상대의 베팅·보유·이월 포인트를 지운다.
  function viewFor(state, seat) {
    const over = state.phase === 'over';
    const opp = 1 - seat;
    const hide = (arr) => { const a = arr.slice(); if (!over) a[opp] = null; return a; };
    return {
      id: state.id,
      startedAt: state.startedAt,
      size: state.size,
      settings: state.settings,
      names: state.names.slice(),
      black: state.black,
      board: state.board.slice(),
      round: state.round,
      phase: state.phase,
      selector: state.selector,
      triple: state.triple ? state.triple.slice() : null,
      selectAuto: state.selectAuto,
      me: seat,
      balance: state.balance[seat],
      myBet: state.bets[seat] ? state.bets[seat].slice() : null,
      myBetAuto: state.betAuto[seat],
      oppLocked: !!state.bets[opp],
      lastReveal: state.lastReveal,
      result: state.result,
      history: state.history.map((h) => {
        if (over) return h;
        const r = Object.assign({}, h, {
          balance: hide(h.balance), bets: hide(h.bets), remaining: hide(h.remaining),
          carry: hide(h.carry), betAuto: hide(h.betAuto),
        });
        delete r.ties; // 동점 여부도 베팅 정보이므로 끝날 때까지 숨긴다
        return r;
      }),
    };
  }

  root.PO = {
    EMPTY, LINE_DIRS, DEFAULTS, OPTIONS, COLS, RuleError,
    idx, xy, inBounds, sum, coordName, cleanSettings,
    normalizeTriple, emptyTriple, allTriples, hasAnyTriple, tripleFromClicks, clickTargets,
    newGame, applySelect, randomTriple, validateBets, autoBets, applyBet,
    findFives, checkWin, resolveRound, nextRound, resign, viewFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
