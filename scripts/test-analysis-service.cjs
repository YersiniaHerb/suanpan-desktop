const assert = require('assert');
const marketSource = require('../prototype/js/market-source.js');
const {
  formula,
  indicatorSummary,
  runFormulaScreener,
  runBuiltinScreener,
  runStrategyScreener,
} = require('../electron/analysis-service.cjs');

const store = marketSource.createStore(marketSource.createMockSnapshot());
const first = store.getSnapshot().stocks[0];

const summary = indicatorSummary(first);
assert.strictEqual(summary.ok, true);
assert.strictEqual(summary.code, first.code);
assert.ok(summary.ma.ma5 != null);
assert.ok(summary.macd.state);

const validation = formula.validate('XG: C > 0;');
assert.strictEqual(validation.ok, true);

const caseInsensitiveVar = formula.validate('ma5 := MA(C,5); XG: MA5 > 0;');
assert.strictEqual(caseInsensitiveVar.ok, true);

const fullDslFunctionFormula = [
  'A1:=SMA(C,3,1)',
  'B1:=STD(C,5)',
  'D1:=COUNT(C>REF(C,1),5)',
  'E1:=SUM(V,5)',
  'F1:=MAX(A1,B1)',
  'G1:=MIN(A1,B1)',
  'H1:=ABS(C-REF(C,1))',
  'I1:=IF(C>O,C,O)',
  'XG: A1>0 AND B1>=0 AND D1>=0 AND E1>0 AND F1>=G1 AND H1>=0 AND I1>0',
].join('; ');
const fullDslFunctionValidation = formula.validate(fullDslFunctionFormula);
assert.strictEqual(fullDslFunctionValidation.ok, true, fullDslFunctionValidation.error);
const fullDslFunctionRun = formula.run(fullDslFunctionFormula, first.klines);
assert.strictEqual(fullDslFunctionRun.xgName, 'XG');
assert.strictEqual(fullDslFunctionRun.xg, true);

const unknownFunctionValidation = formula.validate('XG: UNKNOWN_FN(C);');
assert.strictEqual(unknownFunctionValidation.ok, false);
assert.ok(/不支持的函数/.test(unknownFunctionValidation.error));

const unknownVariableValidation = formula.validate('XG: UNKNOWN_FIELD > 0;');
assert.strictEqual(unknownVariableValidation.ok, false);
assert.ok(/未定义的变量或字段/.test(unknownVariableValidation.error));

['__proto__', 'constructor', 'hasOwnProperty'].forEach((name) => {
  const reserved = formula.validate(`${name} := C; XG: C > 0;`);
  assert.strictEqual(reserved.ok, false, name);
  assert.ok(/保留名称/.test(reserved.error), reserved.error);
});

[
  { source: 'XG: eval(C);', error: /不支持的函数/ },
  { source: 'XG: Function(C);', error: /不支持的函数/ },
  { source: 'XG: constructor(C);', error: /不支持的函数/ },
  { source: 'XG: prototype(C);', error: /不支持的函数/ },
  { source: 'XG: C[`constructor`];', error: /无法识别的字符/ },
  { source: 'XG: C.constructor;', error: /无法识别的字符/ },
].forEach((item) => {
  const hostile = formula.validate(item.source);
  assert.strictEqual(hostile.ok, false, item.source);
  assert.ok(item.error.test(hostile.error), `${item.source}: ${hostile.error}`);
  assert.throws(() => formula.run(item.source, first.klines), item.error, item.source);
});

const screened = runFormulaScreener(store, 'XG: C > 0;', { limit: 5 });
assert.strictEqual(screened.ok, true);
assert.strictEqual(screened.scanned, store.getStatus().count);
assert.ok(screened.matched > 0);
assert.strictEqual(screened.returned.length, 5);

const fullDslScreened = runFormulaScreener(store, fullDslFunctionFormula, { limit: 5 });
assert.strictEqual(fullDslScreened.ok, true);
assert.strictEqual(fullDslScreened.scanned, store.getStatus().count);
assert.ok(fullDslScreened.matched > 0);
assert.ok(fullDslScreened.returned[0].last && fullDslScreened.returned[0].last.XG === 1);

const invalid = runFormulaScreener(store, 'XG: UNKNOWN_FN(C);');
assert.strictEqual(invalid.ok, false);
assert.ok(/不支持的函数/.test(invalid.error));

const builtin = runBuiltinScreener(store, { peMax: 999 }, { limit: 3 });
assert.strictEqual(builtin.ok, true);
assert.strictEqual(builtin.mode, 'builtin');
assert.strictEqual(builtin.scanned, store.getStatus().count);
assert.ok(builtin.matched > 0);
assert.strictEqual(builtin.returned.length, 3);
assert.ok(builtin.returned[0].reasons[0].startsWith('PE '));

const builtinStrategy = runStrategyScreener(store, {
  id: 'builtin-1',
  name: '低估值',
  type: 'builtin',
  criteria: { mode: 'builtin', conditions: { peMax: 999 } },
}, { limit: 2 });
assert.strictEqual(builtinStrategy.ok, true);
assert.strictEqual(builtinStrategy.strategyId, 'builtin-1');
assert.strictEqual(builtinStrategy.returned.length, 2);

const formulaStrategy = runStrategyScreener(store, {
  id: 'formula-1',
  name: '公式策略',
  type: 'formula',
  criteria: { mode: 'formula', formula: 'XG: C > 0;' },
}, { limit: 2 });
assert.strictEqual(formulaStrategy.ok, true);
assert.strictEqual(formulaStrategy.strategyId, 'formula-1');
assert.ok(formulaStrategy.matched > 0);

console.log('analysis-service smoke ok');
