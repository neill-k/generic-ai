export interface ZodParseSuccess<TOutput> {
  success: true;
  data: TOutput;
}

export interface ZodParseFailure {
  success: false;
  error: unknown;
}

export type ZodParseResult<TOutput> = ZodParseSuccess<TOutput> | ZodParseFailure;

export interface ZodTypeLike<TOutput = unknown> {
  optional(): ZodTypeLike<TOutput | undefined>;
  nullable(): ZodTypeLike<TOutput | null>;
  default(value: TOutput): ZodTypeLike<TOutput>;
  describe(description: string): ZodTypeLike<TOutput>;
  refine(check: (value: TOutput) => boolean, message?: string): ZodTypeLike<TOutput>;
  safeParse(value: unknown): ZodParseResult<TOutput>;
}

export interface ZodStringLike extends ZodTypeLike<string> {
  min(length: number, message?: string): ZodStringLike;
  regex(expression: RegExp, message?: string): ZodStringLike;
}

export interface ZodNumberLike extends ZodTypeLike<number> {
  int(message?: string): ZodNumberLike;
  nonnegative(message?: string): ZodNumberLike;
}

export interface ZodArrayLike<TItem> extends ZodTypeLike<TItem[]> {
  min(length: number, message?: string): ZodArrayLike<TItem>;
}

export type ZodShapeLike<TObject extends Record<string, unknown>> = {
  [TKey in keyof TObject]: ZodTypeLike<TObject[TKey]>;
};

export interface ZodObjectLike<TObject extends Record<string, unknown>>
  extends ZodTypeLike<TObject> {
  extend<TExtension extends Record<string, unknown>>(
    shape: ZodShapeLike<TExtension>,
  ): ZodObjectLike<TObject & TExtension>;
  partial(): ZodObjectLike<Partial<TObject>>;
}

export interface ZodNamespaceLike {
  string(): ZodStringLike;
  boolean(): ZodTypeLike<boolean>;
  number(): ZodNumberLike;
  unknown(): ZodTypeLike<unknown>;
  literal<TLiteral extends string | number | boolean>(value: TLiteral): ZodTypeLike<TLiteral>;
  object<TObject extends Record<string, unknown>>(
    shape: ZodShapeLike<TObject>,
  ): ZodObjectLike<TObject>;
  array<TItem>(schema: ZodTypeLike<TItem>): ZodArrayLike<TItem>;
  record<TValue>(valueSchema: ZodTypeLike<TValue>): ZodTypeLike<Record<string, TValue>>;
}
