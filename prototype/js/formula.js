// CoStock 桌面端 - 公式 DSL 引擎
// 兼容通达信/国海证券类公式语法子集。安全要求：不使用 eval / new Function。
// 解析为 AST 后由解释器执行；所有函数走白名单。
//
// 支持：
//   字段:   OPEN/O HIGH/H LOW/L CLOSE/C VOL/V AMOUNT
//   赋值:   MA5 := MA(C, 5);
//   输出:   XG: CROSS(MA5, MA(C,20));   (冒号左侧为输出名)
//   运算:   + - * /   > >= < <= = == != <>   AND OR NOT
//   函数:   MA EMA REF CROSS HHV LLV COUNT SUM MAX MIN ABS REF SMA AVEDEV STD IF
//
// 所有"序列"以数组表示（与K线等长），标量自动广播为序列。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./indicators.js'));
  else root.CoStockFormula = factory(root.CoStockIndicator);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (indicator) {
  'use strict';

  // ---------- 词法分析 ----------
  var TT = { NUM: 'NUM', ID: 'ID', OP: 'OP', LP: 'LP', RP: 'RP', COMMA: 'COMMA',
            ASSIGN: 'ASSIGN', COLON: 'COLON', SEMI: 'SEMI', EOF: 'EOF' };

  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;
    function peek() { return src[i]; }
    while (i < n) {
      var c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      // 注释 { ... }
      if (c === '{') { while (i < n && src[i] !== '}') i++; i++; continue; }
      // 数字
      if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        var num = '';
        while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) { num += src[i++]; }
        tokens.push({ t: TT.NUM, v: parseFloat(num) });
        continue;
      }
      // 标识符 / 关键字
      if (/[A-Za-z_\u4e00-\u9fa5]/.test(c)) {
        var id = '';
        while (i < n && /[A-Za-z0-9_\u4e00-\u9fa5]/.test(src[i])) { id += src[i++]; }
        tokens.push({ t: TT.ID, v: id });
        continue;
      }
      // := 赋值
      if (c === ':' && src[i + 1] === '=') { tokens.push({ t: TT.ASSIGN }); i += 2; continue; }
      if (c === ':') { tokens.push({ t: TT.COLON }); i++; continue; }
      if (c === ';') { tokens.push({ t: TT.SEMI }); i++; continue; }
      if (c === '(') { tokens.push({ t: TT.LP }); i++; continue; }
      if (c === ')') { tokens.push({ t: TT.RP }); i++; continue; }
      if (c === ',') { tokens.push({ t: TT.COMMA }); i++; continue; }
      // 多字符运算符
      var two = src.substr(i, 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=' || two === '<>') {
        tokens.push({ t: TT.OP, v: two === '<>' ? '!=' : two }); i += 2; continue;
      }
      if ('+-*/><='.indexOf(c) >= 0) {
        tokens.push({ t: TT.OP, v: c === '=' ? '==' : c }); i++; continue;
      }
      throw new Error('无法识别的字符: "' + c + '" (位置 ' + i + ')');
    }
    tokens.push({ t: TT.EOF });
    return tokens;
  }

  // ---------- 语法分析 (Pratt / 递归下降) ----------
  // 文法:
  //   program   := statement (';' statement)*
  //   statement := ID ':=' expr   | ID ':' expr  | expr
  //   expr      := orExpr
  //   orExpr    := andExpr (OR andExpr)*
  //   andExpr   := notExpr (AND notExpr)*
  //   notExpr   := NOT notExpr | cmpExpr
  //   cmpExpr   := addExpr ((> >= < <= == !=) addExpr)*
  //   addExpr   := mulExpr ((+|-) mulExpr)*
  //   mulExpr   := unary ((*|/) unary)*
  //   unary     := '-' unary | primary
  //   primary   := NUM | ID | ID '(' args ')' | '(' expr ')'

  var KEYWORDS = { 'AND': 1, 'OR': 1, 'NOT': 1 };

  function parse(tokens) {
    var p = 0;
    function cur() { return tokens[p]; }
    function next() { return tokens[p++]; }
    function expect(t) {
      if (cur().t !== t) throw new Error('语法错误：期望 ' + t + '，实际 ' + JSON.stringify(cur()));
      return next();
    }
    function isKw(kw) { return cur().t === TT.ID && cur().v.toUpperCase() === kw; }

    function program() {
      var stmts = [];
      while (cur().t !== TT.EOF) {
        if (cur().t === TT.SEMI) { next(); continue; }
        stmts.push(statement());
        if (cur().t === TT.SEMI) next();
      }
      return { type: 'Program', body: stmts };
    }

    function statement() {
      // 预看：ID := 或 ID :
      if (cur().t === TT.ID && !KEYWORDS[cur().v.toUpperCase()]) {
        var save = p;
        var name = next().v;
        if (cur().t === TT.ASSIGN) { next(); return { type: 'Assign', name: name, value: expr(), output: false }; }
        if (cur().t === TT.COLON) { next(); return { type: 'Assign', name: name, value: expr(), output: true }; }
        p = save; // 回溯
      }
      return { type: 'ExprStmt', value: expr(), output: true, name: '_' };
    }

    function expr() { return orExpr(); }
    function orExpr() {
      var left = andExpr();
      while (isKw('OR')) { next(); left = { type: 'Logical', op: 'OR', left: left, right: andExpr() }; }
      return left;
    }
    function andExpr() {
      var left = notExpr();
      while (isKw('AND')) { next(); left = { type: 'Logical', op: 'AND', left: left, right: notExpr() }; }
      return left;
    }
    function notExpr() {
      if (isKw('NOT')) { next(); return { type: 'Not', value: notExpr() }; }
      return cmpExpr();
    }
    function cmpExpr() {
      var left = addExpr();
      while (cur().t === TT.OP && ['>', '>=', '<', '<=', '==', '!='].indexOf(cur().v) >= 0) {
        var op = next().v;
        left = { type: 'Binary', op: op, left: left, right: addExpr() };
      }
      return left;
    }
    function addExpr() {
      var left = mulExpr();
      while (cur().t === TT.OP && (cur().v === '+' || cur().v === '-')) {
        var op = next().v;
        left = { type: 'Binary', op: op, left: left, right: mulExpr() };
      }
      return left;
    }
    function mulExpr() {
      var left = unary();
      while (cur().t === TT.OP && (cur().v === '*' || cur().v === '/')) {
        var op = next().v;
        left = { type: 'Binary', op: op, left: left, right: unary() };
      }
      return left;
    }
    function unary() {
      if (cur().t === TT.OP && cur().v === '-') { next(); return { type: 'Neg', value: unary() }; }
      return primary();
    }
    function primary() {
      var tk = cur();
      if (tk.t === TT.NUM) { next(); return { type: 'Num', value: tk.v }; }
      if (tk.t === TT.LP) { next(); var e = expr(); expect(TT.RP); return e; }
      if (tk.t === TT.ID) {
        next();
        if (cur().t === TT.LP) {
          next();
          var args = [];
          if (cur().t !== TT.RP) {
            args.push(expr());
            while (cur().t === TT.COMMA) { next(); args.push(expr()); }
          }
          expect(TT.RP);
          return { type: 'Call', name: tk.v.toUpperCase(), args: args };
        }
        return { type: 'Ident', name: tk.v };
      }
      throw new Error('语法错误：意外的 token ' + JSON.stringify(tk));
    }

    return program();
  }

  // ---------- 解释执行 ----------
  // ctx: { klines, ind(=CoStockIndicator), vars{} }
  // 序列运算工具
  var FIELD_NAMES = {
    'OPEN': 1, 'O': 1, 'HIGH': 1, 'H': 1, 'LOW': 1, 'L': 1,
    'CLOSE': 1, 'C': 1, 'VOL': 1, 'V': 1, 'VOLUME': 1, 'AMOUNT': 1, 'AMO': 1
  };
  var FUNCTION_NAMES = {
    'MA': 1, 'SMA': 1, 'EMA': 1, 'REF': 1, 'HHV': 1, 'LLV': 1,
    'SUM': 1, 'COUNT': 1, 'CROSS': 1, 'MAX': 1, 'MIN': 1,
    'ABS': 1, 'IF': 1, 'STD': 1
  };
  var RESERVED_NAMES = {
    '__PROTO__': 1, 'PROTOTYPE': 1, 'CONSTRUCTOR': 1,
    'HASOWNPROPERTY': 1, 'TOSTRING': 1, 'VALUEOF': 1
  };
  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }
  function checkAssignableName(name) {
    var up = String(name || '').toUpperCase();
    if (KEYWORDS[up]) throw new Error('变量名不能使用关键字: ' + name);
    if (FIELD_NAMES[up]) throw new Error('变量名不能覆盖字段: ' + name);
    if (FUNCTION_NAMES[up]) throw new Error('变量名不能覆盖函数: ' + name);
    if (RESERVED_NAMES[up]) throw new Error('变量名不能使用保留名称: ' + name);
  }
  function asSeries(v, len) {
    if (Array.isArray(v)) return v;
    var a = new Array(len);
    for (var i = 0; i < len; i++) a[i] = v;
    return a;
  }
  function zip(a, b, len, fn) {
    var out = new Array(len);
    for (var i = 0; i < len; i++) {
      var x = a[i], y = b[i];
      out[i] = (x == null || y == null) ? null : fn(x, y);
    }
    return out;
  }

  function makeEvaluator(ctx) {
    var len = ctx.klines.length;
    var ind = ctx.ind || indicator;
    if (!ind) throw new Error('CoStockIndicator 未加载');
    var C = ind.closes(ctx.klines);
    var O = ctx.klines.map(function (k) { return k.open; });
    var H = ind.highs(ctx.klines);
    var L = ind.lows(ctx.klines);
    var V = ind.vols(ctx.klines);
    var AMT = ctx.klines.map(function (k) { return k.amount; });

    var FIELDS = {
      'OPEN': O, 'O': O, 'HIGH': H, 'H': H, 'LOW': L, 'L': L,
      'CLOSE': C, 'C': C, 'VOL': V, 'V': V, 'VOLUME': V, 'AMOUNT': AMT, 'AMO': AMT
    };

    // 白名单函数。约定：序列参数为数组，周期参数取标量。
    function scalarOf(v) { return Array.isArray(v) ? v[v.length - 1] : v; }

    var FUNCS = {
      MA: function (s, n) { return ind.MA(asSeries(s, len), scalarOf(n)); },
      SMA: function (s, n, m) {
        // SMA(X,N,M): Y=(X*M+Y'*(N-M))/N
        s = asSeries(s, len); n = scalarOf(n); m = scalarOf(m) || 1;
        var out = new Array(len).fill(null), prev = null;
        for (var i = 0; i < len; i++) {
          if (s[i] == null) { out[i] = prev; continue; }
          prev = prev == null ? s[i] : (s[i] * m + prev * (n - m)) / n;
          out[i] = prev;
        }
        return out;
      },
      EMA: function (s, n) { return ind.EMA(asSeries(s, len), scalarOf(n)); },
      REF: function (s, n) { return ind.REF(asSeries(s, len), scalarOf(n)); },
      HHV: function (s, n) { return ind.HHV(asSeries(s, len), scalarOf(n)); },
      LLV: function (s, n) { return ind.LLV(asSeries(s, len), scalarOf(n)); },
      SUM: function (s, n) { return ind.SUM(asSeries(s, len), scalarOf(n)); },
      COUNT: function (cond, n) {
        cond = asSeries(cond, len); n = scalarOf(n);
        var out = new Array(len).fill(null);
        for (var i = 0; i < len; i++) {
          if (i < n - 1) continue;
          var cnt = 0;
          for (var j = i - n + 1; j <= i; j++) if (truthy(cond[j])) cnt++;
          out[i] = cnt;
        }
        return out;
      },
      CROSS: function (a, b) {
        a = asSeries(a, len); b = asSeries(b, len);
        var out = new Array(len).fill(null);
        for (var i = 1; i < len; i++) {
          if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) { out[i] = 0; continue; }
          out[i] = (a[i - 1] <= b[i - 1] && a[i] > b[i]) ? 1 : 0;
        }
        return out;
      },
      MAX: function (a, b) { return zip(asSeries(a, len), asSeries(b, len), len, Math.max); },
      MIN: function (a, b) { return zip(asSeries(a, len), asSeries(b, len), len, Math.min); },
      ABS: function (a) { return asSeries(a, len).map(function (x) { return x == null ? null : Math.abs(x); }); },
      IF: function (cond, t, f) {
        cond = asSeries(cond, len); t = asSeries(t, len); f = asSeries(f, len);
        var out = new Array(len);
        for (var i = 0; i < len; i++) out[i] = truthy(cond[i]) ? t[i] : f[i];
        return out;
      },
      STD: function (s, n) {
        s = asSeries(s, len); n = scalarOf(n);
        var ma = ind.MA(s, n), out = new Array(len).fill(null);
        for (var i = 0; i < len; i++) {
          if (ma[i] == null) continue;
          var sum = 0;
          for (var j = i - n + 1; j <= i; j++) sum += Math.pow(s[j] - ma[i], 2);
          out[i] = Math.sqrt(sum / n);
        }
        return out;
      }
    };

    function truthy(v) { return v != null && v !== 0 && v !== false; }

    function evalNode(node, vars) {
      switch (node.type) {
        case 'Num': return node.value;
        case 'Ident': {
          var up = node.name.toUpperCase();
          if (FIELDS[up]) return FIELDS[up];
          if (own(vars, node.name)) return vars[node.name];
          if (own(vars, up)) return vars[up];
          throw new Error('未定义的变量或字段: ' + node.name);
        }
        case 'Call': {
          var fn = FUNCS[node.name];
          if (!fn) throw new Error('不支持的函数: ' + node.name + '()');
          var args = node.args.map(function (a) { return evalNode(a, vars); });
          return fn.apply(null, args);
        }
        case 'Neg': {
          var v = evalNode(node.value, vars);
          return asSeries(v, len).map(function (x) { return x == null ? null : -x; });
        }
        case 'Not': {
          var nv = asSeries(evalNode(node.value, vars), len);
          return nv.map(function (x) { return truthy(x) ? 0 : 1; });
        }
        case 'Binary': {
          var l = asSeries(evalNode(node.left, vars), len);
          var r = asSeries(evalNode(node.right, vars), len);
          return zip(l, r, len, function (x, y) {
            switch (node.op) {
              case '+': return x + y; case '-': return x - y;
              case '*': return x * y; case '/': return y === 0 ? null : x / y;
              case '>': return x > y ? 1 : 0; case '>=': return x >= y ? 1 : 0;
              case '<': return x < y ? 1 : 0; case '<=': return x <= y ? 1 : 0;
              case '==': return x === y ? 1 : 0; case '!=': return x !== y ? 1 : 0;
            }
          });
        }
        case 'Logical': {
          var a = asSeries(evalNode(node.left, vars), len);
          var b = asSeries(evalNode(node.right, vars), len);
          return zip(a, b, len, function (x, y) {
            return node.op === 'AND' ? (truthy(x) && truthy(y) ? 1 : 0) : (truthy(x) || truthy(y) ? 1 : 0);
          });
        }
      }
      throw new Error('未知节点: ' + node.type);
    }

    return { evalNode: evalNode, len: len, truthy: truthy };
  }

  // 运行整段公式，返回 { outputs: {name: series}, last: {name: value}, xg: bool }
  function run(source, klines) {
    var ast = parse(tokenize(source));
    semanticCheck(ast);
    var ev = makeEvaluator({ klines: klines });
    var vars = Object.create(null);
    var outputs = {};
    var lastOutputName = null;
    ast.body.forEach(function (stmt) {
      if (stmt.type === 'Assign') checkAssignableName(stmt.name);
      var series = asSeries(ev.evalNode(stmt.value, vars), ev.len);
      vars[stmt.name] = series;
      vars[stmt.name.toUpperCase()] = series;
      if (stmt.output) { outputs[stmt.name] = series; lastOutputName = stmt.name; }
    });
    var last = {};
    Object.keys(outputs).forEach(function (k) {
      var s = outputs[k]; last[k] = s[s.length - 1];
    });
    // 选股命中：约定取最后一个输出（或名为 XG 的输出）末值为真
    var xgName = own(outputs, 'XG') ? 'XG' : lastOutputName;
    var xg = xgName != null && ev.truthy(outputs[xgName][outputs[xgName].length - 1]);
    return { outputs: outputs, last: last, xg: xg, xgName: xgName };
  }

  function semanticCheck(ast) {
    var vars = Object.create(null);
    function visit(node) {
      switch (node.type) {
        case 'Num': return;
        case 'Ident': {
          var up = node.name.toUpperCase();
          if (FIELD_NAMES[up] || own(vars, node.name) || own(vars, up)) return;
          throw new Error('未定义的变量或字段: ' + node.name);
        }
        case 'Call':
          if (!FUNCTION_NAMES[node.name]) throw new Error('不支持的函数: ' + node.name + '()');
          node.args.forEach(visit);
          return;
        case 'Neg':
        case 'Not':
          visit(node.value);
          return;
        case 'Binary':
        case 'Logical':
          visit(node.left);
          visit(node.right);
          return;
      }
      throw new Error('未知节点: ' + node.type);
    }
    ast.body.forEach(function (stmt) {
      if (stmt.type === 'Assign') checkAssignableName(stmt.name);
      visit(stmt.value);
      if (stmt.type === 'Assign') {
        vars[stmt.name] = true;
        vars[stmt.name.toUpperCase()] = true;
      }
    });
  }

  function validate(source) {
    try { semanticCheck(parse(tokenize(source))); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  return { tokenize: tokenize, parse: parse, run: run, validate: validate };
});
