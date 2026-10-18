import { z } from 'zod';
import { AgentContext } from '../../context.js';
import { BaseAgentTool, ToolOutput, ToolUserError } from '../BaseAgentTool.js';

type Token = { t: 'num'; v: number } | { t: 'op'; v: string };

const MAX_LENGTH = 200;
const MAX_DEPTH = 40;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ToolUserError(`Unexpected '${ch}' in expression.`);
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (ch === '*' && src[i + 1] === '*') {
      tokens.push({ t: 'op', v: '^' });
      i += 2;
    } else if ('+-*/%^()'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
    } else {
      throw new ToolUserError(`Unsupported character '${ch}'. Only numbers and + - * / % ^ ( ) are allowed.`);
    }
  }
  return tokens;
}

/** Recursive-descent evaluator: never uses eval / Function. */
export function evaluateExpression(src: string): number {
  if (src.length > MAX_LENGTH) throw new ToolUserError(`Expression is too long (max ${MAX_LENGTH} characters).`);
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new ToolUserError('Expression is empty.');
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t?.t === 'op' && t.v === v;
  };

  function parseExpr(depth: number): number {
    if (depth > MAX_DEPTH) throw new ToolUserError('Expression is nested too deeply.');
    let left = parseTerm(depth);
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseTerm(depth);
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(depth: number): number {
    let left = parseUnary(depth);
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { v: string }).v;
      const right = parseUnary(depth);
      if ((op === '/' || op === '%') && right === 0) throw new ToolUserError('Division by zero.');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }
  function parseUnary(depth: number): number {
    if (isOp('-')) {
      pos++;
      return -parseUnary(depth);
    }
    if (isOp('+')) {
      pos++;
      return parseUnary(depth);
    }
    return parsePower(depth);
  }
  function parsePower(depth: number): number {
    const base = parsePrimary(depth);
    if (isOp('^')) {
      pos++;
      return Math.pow(base, parseUnary(depth)); // right-associative
    }
    return base;
  }
  function parsePrimary(depth: number): number {
    const t = tokens[pos++];
    if (!t) throw new ToolUserError('Unexpected end of expression.');
    if (t.t === 'num') return t.v;
    if (t.v === '(') {
      const v = parseExpr(depth + 1);
      if (!isOp(')')) throw new ToolUserError('Missing closing parenthesis.');
      pos++;
      return v;
    }
    throw new ToolUserError(`Unexpected '${t.v}' in expression.`);
  }

  const result = parseExpr(0);
  if (pos < tokens.length) throw new ToolUserError('Unexpected trailing input in expression.');
  if (!Number.isFinite(result)) throw new ToolUserError('The result is not a finite number.');
  return result;
}

const schema = z.object({
  expression: z.string().min(1).max(MAX_LENGTH).describe('Arithmetic expression, e.g. "(12 + 8) * 3.5". Supports + - * / % ^ and parentheses.'),
});

export class CalculatorTool extends BaseAgentTool<typeof schema> {
  readonly name = 'calculator';
  readonly description = 'Evaluates an arithmetic expression exactly. Use it for any calculation instead of computing in your head.';
  readonly schema = schema;

  protected async run({ expression }: z.infer<typeof schema>, _ctx: AgentContext): Promise<ToolOutput> {
    const result = evaluateExpression(expression);
    return { data: { expression, result }, text: `${expression} = ${result}` };
  }
}
