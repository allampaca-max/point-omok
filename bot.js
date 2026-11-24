/* 연습용 봇. 자기 화면(viewFor 결과)만 보고 판단하므로 상대 베팅은 모른다. */
(function (root) {
  'use strict';
  const PO = root.PO;

  // 칸 c에 seat의 돌을 놓았을 때 그 돌이 만드는 가장 센 줄의 점수.
  function cellPower(board, size, seat, c, exact) {
    const [x, y] = PO.xy(size, c);
    let best = 0, second = 0;
    for (const [dx, dy] of PO.LINE_DIRS) {
      let run = 1, open = 0;
      for (const sgn of [1, -1]) {
        let cx = x + dx * sgn, cy = y + dy * sgn;
        while (PO.inBounds(size, cx, cy) && board[PO.idx(size, cx, cy)] === seat) { run++; cx += dx * sgn; cy += dy * sgn; }
        if (PO.inBounds(size, cx, cy) && board[PO.idx(size, cx, cy)] === PO.EMPTY) open++;
      }
      let v;
      if (run === 5 || (!exact && run > 5)) v = 1000;
      else if (run > 5) v = 0;
      else if (run === 4) v = open === 2 ? 140 : open ? 45 : 1;
      else if (run === 3) v = open === 2 ? 28 : open ? 8 : 0.5;
      else if (run === 2) v = open === 2 ? 6 : open ? 2 : 0.3;
      else v = open ? 1 : 0.1;
      if (v > best) { second = best; best = v; } else if (v > second) second = v;
    }
    return best + second * 0.35;
  }

  function nearStones(board, size, c, r) {
    const [x, y] = PO.xy(size, c);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (PO.inBounds(size, nx, ny) && board[PO.idx(size, nx, ny)] !== PO.EMPTY) return true;
    }
    return false;
  }

  function chooseTriple(view, rng) {
    rng = rng || Math.random;
    const { board, size, me } = view;
    const opp = 1 - me, exact = view.settings.exactFive;
    const all = PO.allTriples(board, size);
    const anyStone = board.some((v) => v !== PO.EMPTY);
    const mid = (size - 1) / 2;
    let best = null, bestScore = -Infinity;
    for (const t of all) {
      let score;
      if (!anyStone) {
        const [x, y] = PO.xy(size, t[1]);
        score = -Math.hypot(x - mid, y - mid) + rng() * 2;
      } else {
        if (!t.some((c) => nearStones(board, size, c, 2))) continue;
        // 선택자는 동점에 불리하므로, 내게 크고 상대에게는 작은 자리를 고른다.
        score = 0;
        for (const c of t) score += cellPower(board, size, me, c, exact) - 0.55 * cellPower(board, size, opp, c, exact);
        score += rng() * 4;
      }
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best || all[Math.floor(rng() * all.length)];
  }

  function chooseBets(view, rng) {
    rng = rng || Math.random;
    const { board, size, me, triple, balance } = view;
    const opp = 1 - me, exact = view.settings.exactFive;
    const w = triple.map((c) => 1 + cellPower(board, size, me, c, exact) + 0.9 * cellPower(board, size, opp, c, exact));
    const critical = Math.max(...w) >= 100;
    const frac = critical ? 1 : 0.55 + rng() * 0.35;
    const total = Math.max(3, Math.min(balance, Math.round(balance * frac)));
    const bets = [1, 1, 1];
    const spare = total - 3;
    const wsum = w.reduce((a, b) => a + b, 0);
    let given = 0;
    for (let k = 0; k < 3; k++) { const add = Math.floor((spare * w[k]) / wsum); bets[k] += add; given += add; }
    const order = [0, 1, 2].sort((a, b) => w[b] - w[a]);
    for (let r = spare - given, i = 0; r > 0; r--, i++) bets[order[i % 3]]++;
    return bets;
  }

  root.PointOmokBot = { cellPower, chooseTriple, chooseBets };
})(typeof window !== 'undefined' ? window : globalThis);
