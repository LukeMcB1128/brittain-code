'use strict';

const { all, create } = require('mathjs');

const MAX_CALCULATIONS = 20;
const MAX_EXPRESSION_LENGTH = 500;
const MAX_ROWS_PER_CALCULATION = 50;
const MAX_TOTAL_ROWS = 200;
const MAX_AST_NODES = 200;
const DEFAULT_PRECISION = 14;

// Keep the expression language small and deterministic. The calculator does
// not expose mathjs helpers that parse more code, change the math instance, or
// allocate a caller-selected large matrix.
const ALLOWED_FUNCTIONS = new Set([
  'abs', 'acos', 'acosh', 'acot', 'acoth', 'acsc', 'acsch', 'arg',
  'asec', 'asech', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt',
  'ceil', 'complex', 'conj', 'cos', 'cosh', 'cot', 'coth', 'cross',
  'csc', 'csch', 'det', 'dot', 'exp', 'fix', 'floor', 'gcd', 'hypot',
  'im', 'inv', 'lcm', 'log', 'log10', 'log2', 'max', 'mean', 'median',
  'min', 'mod', 'norm', 'nthRoot', 'prod', 're', 'round', 'sec', 'sech',
  'sign', 'sin', 'sinh', 'sqrt', 'std', 'sum', 'tan', 'tanh', 'trace',
  'transpose', 'variance',
]);

const ALLOWED_NODE_TYPES = new Set([
  'ArrayNode',
  'ConstantNode',
  'FunctionNode',
  'OperatorNode',
  'ParenthesisNode',
  'SymbolNode',
]);

const FORBIDDEN_SYMBOLS = new Set(['__proto__', 'constructor', 'prototype']);

function calculatorError(message) {
  return `Error: ${message}`;
}

function numericText(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('variable values must be finite numbers.');
    return String(value);
  }
  if (typeof value !== 'string') throw new Error('variable values must be numbers or numeric strings.');
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    throw new Error(`"${text}" is not a numeric value.`);
  }
  const exponent = text.match(/e([+-]?\d+)$/i);
  if (exponent && Math.abs(Number(exponent[1])) > 1000) {
    throw new Error('variable exponents must be between -1000 and 1000.');
  }
  return text;
}

function validateExpression(math, expression) {
  const text = String(expression || '').trim();
  if (!text) throw new Error('each calculation needs an expression.');
  if (text.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`expressions must not exceed ${MAX_EXPRESSION_LENGTH} characters.`);
  }

  let node;
  try { node = math.parse(text); }
  catch (err) { throw new Error(`invalid expression: ${err.message}`); }

  let count = 0;
  node.traverse((child) => {
    count += 1;
    if (count > MAX_AST_NODES) throw new Error(`expressions must not exceed ${MAX_AST_NODES} operations and values.`);
    if (!ALLOWED_NODE_TYPES.has(child.type)) {
      throw new Error(`${child.type} is not allowed. Use a read-only numeric expression.`);
    }
    if (child.type === 'FunctionNode' && !ALLOWED_FUNCTIONS.has(child.name)) {
      throw new Error(`function "${child.name}" is not allowed.`);
    }
    if (child.type === 'SymbolNode' && (FORBIDDEN_SYMBOLS.has(child.name) || child.name.startsWith('_'))) {
      throw new Error(`symbol "${child.name}" is not allowed.`);
    }
  });
  return { text, node };
}

function normalizedVariables(math, rawVariables) {
  if (rawVariables === undefined) return { names: [], values: new Map(), rowCount: 1 };
  if (!rawVariables || typeof rawVariables !== 'object' || Array.isArray(rawVariables)) {
    throw new Error('variables must be an object whose values are numbers or arrays of numbers.');
  }

  const names = Object.keys(rawVariables);
  if (names.length > 20) throw new Error('a calculation can use at most 20 variables.');
  const values = new Map();
  let rowCount = 1;
  for (const name of names) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name) || FORBIDDEN_SYMBOLS.has(name)) {
      throw new Error(`invalid variable name "${name}".`);
    }
    const raw = rawVariables[name];
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.length) throw new Error(`variable "${name}" has an empty value array.`);
    if (list.length > MAX_ROWS_PER_CALCULATION) {
      throw new Error(`variable arrays must not exceed ${MAX_ROWS_PER_CALCULATION} values.`);
    }
    if (Array.isArray(raw)) {
      if (rowCount !== 1 && rowCount !== list.length) {
        throw new Error('all variable arrays in one calculation must have the same length.');
      }
      rowCount = list.length;
    }
    values.set(name, list.map((value) => math.bignumber(numericText(value))));
  }

  for (const [name, list] of values) {
    if (list.length !== 1 && list.length !== rowCount) {
      throw new Error(`variable "${name}" must be a scalar or have ${rowCount} values.`);
    }
  }
  return { names, values, rowCount };
}

function serializeValue(math, value, precision) {
  if (math.isBigNumber(value) || math.isFraction(value) || math.isUnit(value)) {
    return math.format(value, { precision });
  }
  if (math.isComplex(value)) {
    return {
      re: serializeValue(math, value.re, precision),
      im: serializeValue(math, value.im, precision),
    };
  }
  if (math.isMatrix(value)) return serializeValue(math, value.toArray(), precision);
  if (Array.isArray(value)) return value.map((item) => serializeValue(math, item, precision));
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function calculate(args = {}) {
  const calculations = args.calculations;
  if (!Array.isArray(calculations) || !calculations.length) {
    return calculatorError('calculations must be a non-empty array.');
  }
  if (calculations.length > MAX_CALCULATIONS) {
    return calculatorError(`a call can contain at most ${MAX_CALCULATIONS} calculations.`);
  }

  const requestedPrecision = Number(args.precision);
  const precision = Number.isInteger(requestedPrecision)
    ? Math.min(Math.max(requestedPrecision, 2), 64)
    : DEFAULT_PRECISION;
  const math = create(all, { number: 'BigNumber', precision, predictable: true });

  const output = [];
  let totalRows = 0;
  try {
    for (let index = 0; index < calculations.length; index += 1) {
      const calculation = calculations[index];
      if (!calculation || typeof calculation !== 'object' || Array.isArray(calculation)) {
        throw new Error(`calculation ${index + 1} must be an object.`);
      }
      const { text, node } = validateExpression(math, calculation.expression);
      const variables = normalizedVariables(math, calculation.variables);
      totalRows += variables.rowCount;
      if (totalRows > MAX_TOTAL_ROWS) throw new Error(`a call can return at most ${MAX_TOTAL_ROWS} result rows.`);

      const rows = [];
      let resultType = '';
      for (let rowIndex = 0; rowIndex < variables.rowCount; rowIndex += 1) {
        const scope = new Map();
        const rowVariables = {};
        for (const name of variables.names) {
          const list = variables.values.get(name);
          const value = list[list.length === 1 ? 0 : rowIndex];
          scope.set(name, value);
          rowVariables[name] = serializeValue(math, value, precision);
        }
        let result;
        try { result = node.evaluate(scope); }
        catch (err) { throw new Error(`calculation ${index + 1}, row ${rowIndex + 1}: ${err.message}`); }
        if (!resultType) resultType = math.typeOf(result);
        rows.push({ variables: rowVariables, result: serializeValue(math, result, precision) });
      }
      output.push({
        id: calculation.id === undefined ? String(index + 1) : String(calculation.id).slice(0, 80),
        expression: text,
        result_type: resultType,
        rows,
      });
    }
  } catch (err) {
    return calculatorError(err.message);
  }

  return JSON.stringify({ precision, calculations: output }, null, 2);
}

module.exports = {
  ALLOWED_FUNCTIONS,
  calculate,
};
