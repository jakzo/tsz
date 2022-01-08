import ts from "typescript";

export enum ValueType {
  EXCEPTION = 1,
  ANY = 2,
  UNDEFINED = 3,
  NULL = 4,
  BOOLEAN = 5,
  NUMBER = 6,
  STRING = 7,
  ARRAY = 8,
  OBJECT = 9,
  FUNCTION = 10,
  SYMBOL = 11,
}

export type ValueConstraint =
  | { type: ValueType.ANY }
  | { type: ValueType.UNDEFINED }
  | { type: ValueType.NULL }
  | { type: ValueType.BOOLEAN; value?: boolean }
  | { type: ValueType.NUMBER; value?: number }
  | { type: ValueType.OBJECT; props?: Record<string, Value> }
  | {
      type: ValueType.FUNCTION;
      hasSideEffects?: boolean;
      handler?: (args: Value[]) => Value;
      node?: ts.Node;
    };
export class Value {
  constructor(public constraints: ValueConstraint[]) {}
}
