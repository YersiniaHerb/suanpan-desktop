// CoStock 桌面端 - 指标引擎
// 所有指标基于日K收盘序列计算，返回与输入等长的数组（前置不足部分为 null）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoStockIndicator = factory();
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  function closes(klines) { return klines.map(function (k) { return k.close; }); }
  function highs(klines) { return klines.map(function (k) { return k.high; }); }
  function lows(klines) { return klines.map(function (k) { return k.low; }); }
  function vols(klines) { return klines.map(function (k) { return k.volume; }); }

  // 简单移动平均
  function MA(src, n) {
    var out = new Array(src.length).fill(null);
    var sum = 0;
    for (var i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = round3(sum / n);
    }
    return out;
  }

  // 指数移动平均
  function EMA(src, n) {
    var out = new Array(src.length).fill(null);
    var k = 2 / (n + 1);
    var prev = null;
    for (var i = 0; i < src.length; i++) {
      if (src[i] == null) { out[i] = prev; continue; }
      if (prev == null) prev = src[i];
      else prev = src[i] * k + prev * (1 - k);
      out[i] = round3(prev);
    }
    return out;
  }

  // MACD: 返回 { dif, dea, macd }
  function MACD(src, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    var emaFast = EMA(src, fast);
    var emaSlow = EMA(src, slow);
    var dif = src.map(function (_, i) {
      if (emaFast[i] == null || emaSlow[i] == null) return null;
      return round3(emaFast[i] - emaSlow[i]);
    });
    var dea = EMA(dif.map(function (v) { return v == null ? 0 : v; }), signal);
    var macd = src.map(function (_, i) {
      if (dif[i] == null || dea[i] == null) return null;
      return round3((dif[i] - dea[i]) * 2);
    });
    return { dif: dif, dea: dea, macd: macd };
  }

  // KDJ
  function KDJ(klines, n, m1, m2) {
    n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
    var h = highs(klines), l = lows(klines), c = closes(klines);
    var rsv = new Array(klines.length).fill(null);
    for (var i = 0; i < klines.length; i++) {
      if (i < n - 1) continue;
      var hh = -Infinity, ll = Infinity;
      for (var j = i - n + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
      rsv[i] = hh === ll ? 0 : ((c[i] - ll) / (hh - ll)) * 100;
    }
    var k = new Array(klines.length).fill(null);
    var d = new Array(klines.length).fill(null);
    var jj = new Array(klines.length).fill(null);
    var pk = 50, pd = 50;
    for (var x = 0; x < klines.length; x++) {
      if (rsv[x] == null) continue;
      pk = (pk * (m1 - 1) + rsv[x]) / m1;
      pd = (pd * (m2 - 1) + pk) / m2;
      k[x] = round3(pk); d[x] = round3(pd); jj[x] = round3(3 * pk - 2 * pd);
    }
    return { k: k, d: d, j: jj };
  }

  // RSI
  function RSI(src, n) {
    n = n || 14;
    var out = new Array(src.length).fill(null);
    var gain = 0, loss = 0;
    for (var i = 1; i < src.length; i++) {
      var diff = src[i] - src[i - 1];
      var up = diff > 0 ? diff : 0;
      var dn = diff < 0 ? -diff : 0;
      if (i <= n) {
        gain += up; loss += dn;
        if (i === n) {
          gain /= n; loss /= n;
          out[i] = loss === 0 ? 100 : round3(100 - 100 / (1 + gain / loss));
        }
      } else {
        gain = (gain * (n - 1) + up) / n;
        loss = (loss * (n - 1) + dn) / n;
        out[i] = loss === 0 ? 100 : round3(100 - 100 / (1 + gain / loss));
      }
    }
    return out;
  }

  // BOLL
  function BOLL(src, n, k) {
    n = n || 20; k = k || 2;
    var mid = MA(src, n);
    var upper = new Array(src.length).fill(null);
    var lower = new Array(src.length).fill(null);
    for (var i = 0; i < src.length; i++) {
      if (mid[i] == null) continue;
      var sum = 0;
      for (var j = i - n + 1; j <= i; j++) sum += Math.pow(src[j] - mid[i], 2);
      var sd = Math.sqrt(sum / n);
      upper[i] = round3(mid[i] + k * sd);
      lower[i] = round3(mid[i] - k * sd);
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  // 通用序列函数（供公式引擎复用）
  // 前 n 周期最高
  function HHV(src, n) {
    var out = new Array(src.length).fill(null);
    for (var i = 0; i < src.length; i++) {
      if (i < n - 1) continue;
      var m = -Infinity;
      for (var j = i - n + 1; j <= i; j++) m = Math.max(m, src[j]);
      out[i] = m;
    }
    return out;
  }
  function LLV(src, n) {
    var out = new Array(src.length).fill(null);
    for (var i = 0; i < src.length; i++) {
      if (i < n - 1) continue;
      var m = Infinity;
      for (var j = i - n + 1; j <= i; j++) m = Math.min(m, src[j]);
      out[i] = m;
    }
    return out;
  }
  // 引用 n 周期前的值
  function REF(src, n) {
    var out = new Array(src.length).fill(null);
    for (var i = 0; i < src.length; i++) {
      if (i - n >= 0) out[i] = src[i - n];
    }
    return out;
  }
  function SUM(src, n) {
    var out = new Array(src.length).fill(null);
    var sum = 0;
    for (var i = 0; i < src.length; i++) {
      sum += src[i] || 0;
      if (i >= n) sum -= src[i - n] || 0;
      if (i >= n - 1) out[i] = round3(sum);
    }
    return out;
  }

  function round3(n) { return n == null ? null : Math.round(n * 1000) / 1000; }

  return {
    closes: closes, highs: highs, lows: lows, vols: vols,
    MA: MA, EMA: EMA, MACD: MACD, KDJ: KDJ, RSI: RSI, BOLL: BOLL,
    HHV: HHV, LLV: LLV, REF: REF, SUM: SUM
  };
});
