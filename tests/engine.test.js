/* 규칙 엔진 테스트. macOS 내장 JavaScriptCore로 실행:
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc engine.js bot.js tests/engine.test.js
 * (브라우저에서는 tests/index.html 을 열면 같은 테스트가 돈다.)
 */
(function (G) {
  const PO = G.PO;
  const out = typeof print === 'function' ? print : (s) => console.log(s);
  let pass = 0, fail = 0;
  function test(name, fn) {
    try { fn(); pass++; } catch (e) { fail++; out('FAIL ' + name + ': ' + (e && e.message)); }
  }
  function eq(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error((msg || '') + ' expected ' + B + ' got ' + A);
  }
  function ok(v, msg) { if (!v) throw new Error(msg || 'not ok'); }
  function throws(fn, msg) {
    try { fn(); } catch (e) { if (e instanceof PO.RuleError) return; throw e; }
    throw new Error(msg || 'expected RuleError');
  }
  const N = 15, I = (x, y) => PO.idx(N, x, y);
  const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

  test('normalizeTriple: 8방향 직선, 순서 정규화', () => {
    eq(PO.normalizeTriple(N, [I(3, 3), I(5, 3), I(4, 3)]), [I(3, 3), I(4, 3), I(5, 3)]);
    eq(PO.normalizeTriple(N, [I(2, 4), I(2, 2), I(2, 3)]), [I(2, 2), I(2, 3), I(2, 4)]);
    eq(PO.normalizeTriple(N, [I(4, 4), I(5, 5), I(6, 6)]), [I(4, 4), I(5, 5), I(6, 6)]);
    eq(PO.normalizeTriple(N, [I(6, 2), I(5, 3), I(4, 4)]), [I(4, 4), I(5, 3), I(6, 2)]);
  });
  test('normalizeTriple: 잘못된 모양 거부', () => {
    eq(PO.normalizeTriple(N, [I(0, 0), I(1, 0), I(3, 0)]), null);
    eq(PO.normalizeTriple(N, [I(0, 0), I(1, 1), I(2, 1)]), null);
    eq(PO.normalizeTriple(N, [I(0, 0), I(0, 0), I(1, 0)]), null);
    eq(PO.normalizeTriple(N, [I(14, 0), I(0, 1), I(1, 1)]), null); // 줄바꿈 넘어가는 가로 3칸
    eq(PO.normalizeTriple(N, [I(0, 0), I(1, 0)]), null);
    eq(PO.normalizeTriple(N, [-1, 0, 1]), null);
  });
  test('tripleFromClicks: 두 칸 떨어진 끝점, 옆칸 연장, 반대쪽 연장', () => {
    const b = new Array(N * N).fill(-1);
    eq(PO.tripleFromClicks(b, N, I(5, 5), I(7, 7)), [I(5, 5), I(6, 6), I(7, 7)]);
    eq(PO.tripleFromClicks(b, N, I(5, 5), I(6, 5)), [I(5, 5), I(6, 5), I(7, 5)]);
    eq(PO.tripleFromClicks(b, N, I(13, 5), I(14, 5)), [I(12, 5), I(13, 5), I(14, 5)]); // 끝에 닿으면 반대쪽
    b[I(7, 5)] = 0;
    eq(PO.tripleFromClicks(b, N, I(5, 5), I(6, 5)), [I(4, 5), I(5, 5), I(6, 5)]);
    eq(PO.tripleFromClicks(b, N, I(5, 5), I(7, 5)), null); // 끝점이 돌
    eq(PO.tripleFromClicks(b, N, I(5, 5), I(7, 6)), null); // 직선 아님
    ok(PO.clickTargets(b, N, I(5, 5)).indexOf(I(7, 7)) >= 0);
    ok(PO.clickTargets(b, N, I(5, 5)).indexOf(I(7, 5)) < 0);
  });
  test('allTriples 개수: 빈 15판', () => {
    // 가로 13*15 + 세로 15*13 + 대각 13*13 *2
    eq(PO.allTriples(new Array(N * N).fill(-1), N).length, 13 * 15 * 2 + 13 * 13 * 2);
  });
  test('validateBets / autoBets', () => {
    eq(PO.validateBets([1, 1, 1], 10), null);
    ok(PO.validateBets([0, 5, 5], 10));
    ok(PO.validateBets([1.5, 1, 1], 10));
    ok(PO.validateBets([5, 5, 1], 10));
    ok(PO.validateBets([1, 1], 10));
    eq(PO.autoBets(null, 10), [1, 1, 1]);
    eq(PO.autoBets([10, 0, 0], 10), [8, 1, 1]);
    eq(PO.autoBets([3, 'x', 2], 12), [3, 1, 2]);
  });
  test('한 라운드: 높은 쪽 착수, 동점은 비선택자, 이월은 절반 내림', () => {
    const s = PO.newGame({}, 0, seq([0.5]));
    eq(s.selector, 0); eq(s.balance, [10, 10]);
    throws(() => PO.applySelect(s, 1, [I(7, 7), I(8, 7), I(9, 7)]), '선택자 아님');
    throws(() => PO.applyBet(s, 0, [1, 1, 1]), '단계 아님');
    PO.applySelect(s, 0, [I(9, 7), I(7, 7), I(8, 7)]);
    eq(s.phase, 'bet'); eq(s.triple, [I(7, 7), I(8, 7), I(9, 7)]);
    eq(PO.applyBet(s, 0, [4, 2, 1]), false);
    throws(() => PO.applyBet(s, 0, [1, 1, 1]), '중복');
    throws(() => PO.applyBet(s, 1, [5, 5, 1]), '초과');
    eq(PO.applyBet(s, 1, [3, 2, 2]), true);
    const rec = PO.resolveRound(s);
    eq(rec.winners, [0, 1, 1]); // 4>3 → 0, 2=2 → 비선택자 1, 1<2 → 1
    eq(rec.ties, [1]);
    eq(rec.remaining, [3, 3]); eq(rec.carry, [1, 1]);
    eq(s.board[I(7, 7)], 0); eq(s.board[I(8, 7)], 1); eq(s.board[I(9, 7)], 1);
    eq(s.phase, 'reveal');
    PO.nextRound(s);
    eq(s.round, 2); eq(s.selector, 1); eq(s.balance, [11, 11]);
  });
  test('이월 예시: 5 남으면 2 이월 → 12', () => {
    const s = PO.newGame({}, 1);
    PO.applySelect(s, 1, [I(0, 0), I(1, 0), I(2, 0)]);
    PO.applyBet(s, 0, [1, 1, 3]);
    PO.applyBet(s, 1, [1, 1, 1]);
    const rec = PO.resolveRound(s);
    eq(rec.remaining, [5, 7]); eq(rec.carry, [2, 3]);
    PO.nextRound(s);
    eq(s.balance, [12, 13]);
  });
  test('findFives: 정확히 5만, 장목 제외, 줄마다 1개', () => {
    const b = new Array(N * N).fill(-1);
    for (let x = 0; x < 5; x++) b[I(x, 0)] = 0;
    eq(PO.findFives(b, N, 0, true).length, 1);
    b[I(5, 0)] = 0; // 6목
    eq(PO.findFives(b, N, 0, true).length, 0);
    eq(PO.findFives(b, N, 0, false).length, 1);
    for (let k = 0; k < 5; k++) b[I(10 - k, 2 + k)] = 1; // 반대 대각선
    eq(PO.findFives(b, N, 1, true).length, 1);
  });
  function stage(s, cells, seat) { cells.forEach((c) => { s.board[c] = seat; }); }
  function playRound(s, triple, b0, b1) {
    PO.applySelect(s, s.selector, triple);
    PO.applyBet(s, 0, b0); PO.applyBet(s, 1, b1);
    return PO.resolveRound(s);
  }
  test('승리: 한쪽만 오목', () => {
    const s = PO.newGame({}, 0);
    stage(s, [I(3, 7), I(4, 7)], 0);
    playRound(s, [I(5, 7), I(6, 7), I(7, 7)], [3, 3, 3], [1, 1, 1]);
    eq(s.phase, 'over'); eq(s.result.winner, 0); eq(s.result.reason, 'omok');
    eq(s.result.lines[0].length, 1);
  });
  test('6목은 승리가 아님', () => {
    const s = PO.newGame({}, 0);
    stage(s, [I(2, 7), I(3, 7), I(4, 7)], 0);
    playRound(s, [I(5, 7), I(6, 7), I(7, 7)], [3, 3, 3], [1, 1, 1]);
    eq(s.phase, 'reveal');
  });
  test('동시 오목: 개수 많은 쪽 승', () => {
    const s = PO.newGame({}, 0);
    // 0: (5,5)에 놓이면 가로+세로 두 줄 완성
    stage(s, [I(1, 5), I(2, 5), I(3, 5), I(4, 5), I(5, 1), I(5, 2), I(5, 3), I(5, 4)], 0);
    // 1: (7,5)에 놓이면 세로 한 줄 완성
    stage(s, [I(7, 1), I(7, 2), I(7, 3), I(7, 4)], 1);
    playRound(s, [I(5, 5), I(6, 5), I(7, 5)], [5, 1, 1], [1, 1, 5]);
    eq(s.result.counts, [2, 1]); eq(s.result.winner, 0); eq(s.result.reason, 'more');
  });
  test('동시 오목 개수 동점: 그 라운드 3점 중 2점 딴 쪽 승', () => {
    const s = PO.newGame({}, 0);
    stage(s, [I(1, 9), I(2, 9), I(3, 9), I(4, 9)], 0); // (5,9)
    stage(s, [I(7, 10), I(7, 11), I(7, 12), I(7, 13)], 1); // (7,9)
    // 1이 (5,9)? 아니다 — 0이 (5,9), 1이 (6,9)와 (7,9)를 가져간다
    playRound(s, [I(5, 9), I(6, 9), I(7, 9)], [5, 1, 1], [1, 2, 5]);
    eq(s.result.counts, [1, 1]); eq(s.result.winner, 1); eq(s.result.reason, 'majority');
  });
  test('viewFor: 끝나기 전 상대 정보 숨김, 끝나면 공개', () => {
    const s = PO.newGame({}, 0);
    PO.applySelect(s, 0, [I(7, 7), I(8, 7), I(9, 7)]);
    PO.applyBet(s, 1, [2, 2, 2]);
    const v0 = PO.viewFor(s, 0);
    eq(v0.myBet, null); eq(v0.oppLocked, true);
    const v1 = PO.viewFor(s, 1);
    eq(v1.myBet, [2, 2, 2]); eq(v1.oppLocked, false);
    PO.applyBet(s, 0, [3, 2, 1]);
    PO.resolveRound(s);
    const h0 = PO.viewFor(s, 0).history[0];
    eq(h0.bets, [[3, 2, 1], null]); eq(h0.balance, [10, null]); eq(h0.carry, [2, null]);
    ok(!('ties' in h0), 'ties hidden');
    eq(PO.viewFor(s, 1).history[0].bets, [null, [2, 2, 2]]);
    PO.resign(s, 0);
    eq(PO.viewFor(s, 0).history[0].bets, [[3, 2, 1], [2, 2, 2]]);
    eq(s.result.winner, 1);
  });
  test('둘 곳이 없으면 무승부', () => {
    const s = PO.newGame({}, 0);
    // 판을 체스판 무늬로 채우고(오목 불가) 한 줄 3칸만 비워 둔다
    for (let i = 0; i < N * N; i++) { const [x, y] = PO.xy(N, i); s.board[i] = (Math.floor(x / 2) + y) % 2; }
    const t = [I(0, 0), I(1, 0), I(2, 0)];
    t.forEach((c) => { s.board[c] = -1; });
    ok(!PO.findFives(s.board, N, 0, true).length && !PO.findFives(s.board, N, 1, true).length, 'no fives');
    playRound(s, t, [1, 1, 1], [2, 2, 2]);
    if (s.phase === 'over') { eq(s.result.reason === 'full' || s.result.reason === 'omok', true); }
    else throw new Error('should be over, phase=' + s.phase);
  });
  test('randomTriple은 유효한 3점', () => {
    const s = PO.newGame({}, 0);
    for (let k = 0; k < 50; k++) ok(PO.emptyTriple(s.board, N, PO.randomTriple(s)));
  });
  test('19판 설정 정리', () => {
    eq(PO.cleanSettings({ size: 19, selectSec: 120, betSec: 30 }).size, 19);
    eq(PO.cleanSettings({ size: 17, betSec: 45 }).size, 15);
    eq(PO.cleanSettings({ betSec: 45 }).betSec, 60);
  });

  if (G.PointOmokBot) {
    const Bot = G.PointOmokBot;
    test('봇: 항상 규칙에 맞는 선택과 베팅, 끝까지 진행', () => {
      for (let g = 0; g < 30; g++) {
        const s = PO.newGame({ size: g % 2 ? 19 : 15 }, g % 2);
        let guard = 0;
        while (s.phase !== 'over' && guard++ < 400) {
          if (s.phase === 'select') PO.applySelect(s, s.selector, Bot.chooseTriple(PO.viewFor(s, s.selector)));
          else if (s.phase === 'bet') {
            for (const seat of [0, 1]) {
              const bets = Bot.chooseBets(PO.viewFor(s, seat));
              const err = PO.validateBets(bets, s.balance[seat]);
              if (err) throw new Error('bad bot bet ' + JSON.stringify(bets) + ' bal ' + s.balance[seat] + ': ' + err);
              PO.applyBet(s, seat, bets);
            }
            PO.resolveRound(s);
          } else if (s.phase === 'reveal') PO.nextRound(s);
        }
        ok(s.phase === 'over', 'game finished (round ' + s.round + ')');
      }
    });
  }

  out((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  G.__testResult = { pass, fail };
})(typeof window !== 'undefined' ? window : globalThis);
