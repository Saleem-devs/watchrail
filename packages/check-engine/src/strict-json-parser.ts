export const STRICT_JSON_LIMITS = {
  /** Maximum number of nested object/array containers, including the root container. */
  maxDepth: 64,
  /** Whole-document budget of parsed values plus decoded object keys. */
  maxTokens: 32_768,
  /** Maximum members in each individual object. */
  maxObjectMembers: 4_096,
  /** Maximum items in each individual array. */
  maxArrayLength: 4_096,
} as const;

export type StrictJsonValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'array'; items: readonly StrictJsonValue[] }
  | { type: 'object'; members: readonly StrictJsonMember[] };

export interface StrictJsonMember {
  key: string;
  value: StrictJsonValue;
}

export type StrictJsonParseResult =
  | { status: 'PARSED'; value: StrictJsonValue }
  | { status: 'FAILED'; reason: 'INVALID_JSON' | 'DUPLICATE_JSON_KEY' };

type FailureReason = Extract<StrictJsonParseResult, { status: 'FAILED' }>['reason'];

class StrictJsonParseFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super('The response does not satisfy Watchrail strict JSON parsing.');
    this.name = 'StrictJsonParseFailure';
  }
}

export function parseStrictJson(source: string): StrictJsonParseResult {
  try {
    return { status: 'PARSED', value: new StrictJsonParser(source).parse() };
  } catch (error) {
    if (error instanceof StrictJsonParseFailure) {
      return { status: 'FAILED', reason: error.reason };
    }
    throw error;
  }
}

class StrictJsonParser {
  private index = 0;
  private tokens = 0;

  constructor(private readonly source: string) {}

  parse(): StrictJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail();
    return value;
  }

  private parseValue(depth: number): StrictJsonValue {
    this.consumeToken();
    const character = this.source[this.index];
    if (character === '"') return { type: 'string', value: this.parseString() };
    if (character === '{') return this.parseObject(depth + 1);
    if (character === '[') return this.parseArray(depth + 1);
    if (character === 't') {
      this.consumeKeyword('true');
      return { type: 'boolean', value: true };
    }
    if (character === 'f') {
      this.consumeKeyword('false');
      return { type: 'boolean', value: false };
    }
    if (character === 'n') {
      this.consumeKeyword('null');
      return { type: 'null' };
    }
    if (character === '-' || isDigit(character)) {
      return { type: 'number', value: this.parseNumber() };
    }
    return this.fail();
  }

  private parseObject(depth: number): StrictJsonValue {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const members: StrictJsonMember[] = [];
    const keys = new Set<string>();
    if (this.consumeIf('}')) return { type: 'object', members };

    while (true) {
      if (members.length >= STRICT_JSON_LIMITS.maxObjectMembers) this.fail();
      if (this.source[this.index] !== '"') this.fail();
      this.consumeToken();
      const key = this.parseString();
      if (keys.has(key)) throw new StrictJsonParseFailure('DUPLICATE_JSON_KEY');
      keys.add(key);
      this.skipWhitespace();
      this.consume(':');
      this.skipWhitespace();
      members.push({ key, value: this.parseValue(depth) });
      this.skipWhitespace();
      if (this.consumeIf('}')) return { type: 'object', members };
      this.consume(',');
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): StrictJsonValue {
    this.assertDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const items: StrictJsonValue[] = [];
    if (this.consumeIf(']')) return { type: 'array', items };

    while (true) {
      if (items.length >= STRICT_JSON_LIMITS.maxArrayLength) this.fail();
      items.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consumeIf(']')) return { type: 'array', items };
      this.consume(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.consume('"');
    let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return value;
      }
      if (character === '\\') {
        this.index += 1;
        value += this.parseEscape();
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) this.fail();
      const codeUnit = character.charCodeAt(0);
      if (isHighSurrogate(codeUnit)) {
        const low = this.source.charCodeAt(this.index + 1);
        if (!isLowSurrogate(low)) this.fail();
        value += character + this.source[this.index + 1];
        this.index += 2;
        continue;
      }
      if (isLowSurrogate(codeUnit)) this.fail();
      value += character;
      this.index += 1;
    }
    return this.fail();
  }

  private parseEscape(): string {
    const escape = this.source[this.index];
    this.index += 1;
    switch (escape) {
      case '"':
      case '\\':
      case '/':
        return escape;
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const high = this.parseHexCodeUnit();
        if (isHighSurrogate(high)) {
          if (this.source.slice(this.index, this.index + 2) !== '\\u') this.fail();
          this.index += 2;
          const low = this.parseHexCodeUnit();
          if (!isLowSurrogate(low)) this.fail();
          return String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
        }
        if (isLowSurrogate(high)) this.fail();
        return String.fromCharCode(high);
      }
      default:
        return this.fail();
    }
  }

  private parseHexCodeUnit(): number {
    const digits = this.source.slice(this.index, this.index + 4);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) this.fail();
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  private parseNumber(): string {
    const negative = this.consumeIf('-');
    const integerStart = this.index;
    if (this.source[this.index] === '0') {
      this.index += 1;
      if (isDigit(this.source[this.index])) this.fail();
    } else {
      if (!isNonZeroDigit(this.source[this.index])) this.fail();
      while (isDigit(this.source[this.index])) this.index += 1;
    }
    const integer = this.source.slice(integerStart, this.index);

    let fraction = '';
    if (this.consumeIf('.')) {
      const fractionStart = this.index;
      if (!isDigit(this.source[this.index])) this.fail();
      while (isDigit(this.source[this.index])) this.index += 1;
      fraction = this.source.slice(fractionStart, this.index);
    }

    let exponent = '0';
    if (this.source[this.index] === 'e' || this.source[this.index] === 'E') {
      this.index += 1;
      const exponentStart = this.index;
      if (this.source[this.index] === '+' || this.source[this.index] === '-') this.index += 1;
      if (!isDigit(this.source[this.index])) this.fail();
      while (isDigit(this.source[this.index])) this.index += 1;
      exponent = this.source.slice(exponentStart, this.index);
    }

    return canonicalizeNumber(negative, integer, fraction, exponent);
  }

  private consumeKeyword(keyword: string): void {
    if (this.source.slice(this.index, this.index + keyword.length) !== keyword) this.fail();
    this.index += keyword.length;
  }

  private consume(expected: string): void {
    if (this.source[this.index] !== expected) this.fail();
    this.index += 1;
  }

  private consumeIf(expected: string): boolean {
    if (this.source[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private skipWhitespace(): void {
    while (isJsonWhitespace(this.source[this.index])) this.index += 1;
  }

  private consumeToken(): void {
    this.tokens += 1;
    if (this.tokens > STRICT_JSON_LIMITS.maxTokens) this.fail();
  }

  private assertDepth(depth: number): void {
    if (depth > STRICT_JSON_LIMITS.maxDepth) this.fail();
  }

  private fail(): never {
    throw new StrictJsonParseFailure('INVALID_JSON');
  }
}

function canonicalizeNumber(
  negative: boolean,
  integer: string,
  fraction: string,
  declaredExponent: string,
): string {
  let digits = `${integer}${fraction}`.replace(/^0+/u, '');
  if (digits.length === 0) return '0';
  let significantEnd = digits.length;
  while (significantEnd > 0 && digits.charCodeAt(significantEnd - 1) === 48) {
    significantEnd -= 1;
  }
  const trailingZeroes = digits.length - significantEnd;
  digits = digits.slice(0, significantEnd);
  const exponent = addSignedDecimals(
    normalizeSignedDecimal(declaredExponent),
    String(trailingZeroes - fraction.length),
  );
  return `${negative ? '-' : ''}${digits}${exponent === '0' ? '' : `e${exponent}`}`;
}

function normalizeSignedDecimal(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/u, '').replace(/^0+/u, '') || '0';
  return unsigned === '0' ? '0' : `${negative ? '-' : ''}${unsigned}`;
}

function addSignedDecimals(left: string, right: string): string {
  const leftNegative = left.startsWith('-');
  const rightNormalized = normalizeSignedDecimal(right);
  const rightNegative = rightNormalized.startsWith('-');
  const leftAbs = left.replace(/^-/, '');
  const rightAbs = rightNormalized.replace(/^-/, '');
  if (leftNegative === rightNegative) {
    const sum = addUnsignedDecimals(leftAbs, rightAbs);
    return sum === '0' ? '0' : `${leftNegative ? '-' : ''}${sum}`;
  }
  const comparison = compareUnsignedDecimals(leftAbs, rightAbs);
  if (comparison === 0) return '0';
  const leftLarger = comparison > 0;
  const difference = leftLarger
    ? subtractUnsignedDecimals(leftAbs, rightAbs)
    : subtractUnsignedDecimals(rightAbs, leftAbs);
  const negative = leftLarger ? leftNegative : rightNegative;
  return `${negative ? '-' : ''}${difference}`;
}

function addUnsignedDecimals(left: string, right: string): string {
  let carry = 0;
  const reversed: string[] = [];
  let leftIndex = left.length - 1;
  let rightIndex = right.length - 1;
  while (leftIndex >= 0 || rightIndex >= 0 || carry > 0) {
    const sum = digitAt(left, leftIndex) + digitAt(right, rightIndex) + carry;
    reversed.push(String(sum % 10));
    carry = Math.floor(sum / 10);
    leftIndex -= 1;
    rightIndex -= 1;
  }
  reversed.reverse();
  const result = reversed.join('');
  return result.replace(/^0+/u, '') || '0';
}

function subtractUnsignedDecimals(larger: string, smaller: string): string {
  let borrow = 0;
  const reversed: string[] = [];
  let smallerIndex = smaller.length - 1;
  for (let largerIndex = larger.length - 1; largerIndex >= 0; largerIndex -= 1) {
    let difference = digitAt(larger, largerIndex) - borrow - digitAt(smaller, smallerIndex);
    if (difference < 0) {
      difference += 10;
      borrow = 1;
    } else {
      borrow = 0;
    }
    reversed.push(String(difference));
    smallerIndex -= 1;
  }
  reversed.reverse();
  const result = reversed.join('');
  return result.replace(/^0+/u, '') || '0';
}

function compareUnsignedDecimals(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

function digitAt(value: string, index: number): number {
  return index < 0 ? 0 : value.charCodeAt(index) - 48;
}

function isJsonWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r';
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isNonZeroDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
