import { EOL } from "os";

import ts from "typescript";

import { ValueConstraint, ValueType } from ".";
import { Value } from "./value";

declare module "typescript" {
  export interface Node {
    tsz?: {};
  }
}

export class CompileError extends Error {
  constructor(message: string, public node?: ts.Node) {
    super(message);
  }
}

export class Scope {
  constructor(
    public parent?: Scope,
    public bindings: Map<string, Value> = new Map()
  ) {}

  lookupVar(name: string): Value | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope | undefined = this;
    while (scope) {
      const value = scope.bindings.get(name);
      if (value) return value;
      scope = scope.parent;
    }
    return undefined;
  }

  setVar(name: string, value: Value): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let scope: Scope = this;
    while (scope.parent && !scope.bindings.has(name)) {
      scope = scope.parent;
    }
    scope.bindings.set(name, value);
  }
}

interface ExecResult {
  value?: Value;
  exception?: Value;
  identifier?: string;
}

export interface CompileResult {
  diagnostics: ts.Diagnostic[];
}

const unsupported = (node: ts.Node): CompileError =>
  new CompileError("Unsupported JS code encountered", node);

export const compile = (code: string): CompileResult => {
  const diagnostics: ts.Diagnostic[] = [];

  const sourceFile = ts.createSourceFile("input", code, ts.ScriptTarget.Latest);
  const addDiagnostic = (
    message: string,
    node?: ts.Node,
    category: ts.DiagnosticCategory = ts.DiagnosticCategory.Error
  ): void => {
    diagnostics.push({
      file: sourceFile,
      start: node?.getFullStart(),
      length: node?.getFullWidth(),
      category,
      // Hack to output TSZ instead of TS1234 in the error message (since any
      // error codes we use would not appear in the TypeScript documentation)
      code: "Z" as unknown as number,
      messageText: message,
    });
  };

  const globalScope = createGlobalScope();
  const sideEffects: unknown[] = [];

  const execNode = (node: ts.Node, scope: Scope): ExecResult => {
    if (ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        const result = execNode(statement, scope);
        if (result.exception) break;
      }
    } else if (ts.isVariableStatement(node)) {
      const isLet = (node.declarationList.flags & ts.NodeFlags.Let) !== 0;
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (isLet || isConst) throw unsupported(node);
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isArrayBindingPattern(declaration.name) ||
          ts.isObjectBindingPattern(declaration.name)
        )
          throw new CompileError(
            "destructuring is not supported",
            declaration.name
          );
        const name = declaration.name.escapedText as string;
        let value: Value | undefined;
        if (declaration.initializer) {
          const result = execNode(declaration.initializer, scope);
          if (result.exception) return result;
          value = result.value;
        }
        if (!value) value = new Value([{ type: ValueType.UNDEFINED }]);
        scope.bindings.set(name, value);
      }
    } else if (ts.isCallExpression(node)) {
      const expression = execNode(node.expression, scope);
      if (expression.exception || !expression.value) return expression;
      const args: Value[] = [];
      for (const arg of node.arguments) {
        const result = execNode(arg, scope);
        if (result.exception || !result.value) return result;
        args.push(result.value);
      }
      return {
        value: applyToValue(expression.value, (constraint) => {
          // TODO: I need to make values somehow also possibly be thrown exceptions
          if (constraint.type !== ValueType.FUNCTION)
            throw new CompileError("Called value may not be a function", node);
          if (constraint.handler) {
            if (constraint.hasSideEffects) sideEffects.push({ args });
            return constraint.handler(args).constraints;
          }
          if (constraint.node) {
            // TODO
          }
          return [{ type: ValueType.ANY }];
        }),
      };
    } else if (ts.isExpressionStatement(node)) {
      return execNode(node.expression, scope);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
        if (node.left.kind !== ts.SyntaxKind.Identifier)
          throw unsupported(node.left);
        const identifier = (node.left as ts.Identifier).escapedText as string;
        if (!scope.lookupVar(identifier))
          return { exception: new Value([{ type: ValueType.UNDEFINED }]) };
        const result = execNode(node.right, scope);
        if (!result.exception && result.value)
          scope.setVar(identifier, result.value);
        return result;
      } else {
        throw unsupported(node);
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const expression = execNode(node.expression, scope);
      if (expression.exception || !expression.value) return expression;
      const name = node.name.escapedText as string;
      return {
        value: applyToValue(expression.value, (constraint) => {
          if (constraint.type !== ValueType.OBJECT)
            throw new CompileError(
              "Only objects support property access",
              node
            );
          if (!constraint.props) return [{ type: ValueType.ANY }];
          return constraint.props[name]?.constraints ?? [];
        }),
      };
    } else if (ts.isNumericLiteral(node)) {
      return {
        value: new Value([{ type: ValueType.NUMBER, value: +node.text }]),
      };
    } else if (ts.isIdentifier(node)) {
      const identifier = node.text;
      if (identifier === "undefined")
        return { value: new Value([{ type: ValueType.UNDEFINED }]) };
      const value = scope.lookupVar(identifier);
      if (!value)
        return { exception: new Value([{ type: ValueType.UNDEFINED }]) };
      return { identifier, value };
    } else if (node.kind === ts.SyntaxKind.NullKeyword) {
      return { value: new Value([{ type: ValueType.NULL }]) };
    } else if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return { value: new Value([{ type: ValueType.BOOLEAN, value: true }]) };
    } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return { value: new Value([{ type: ValueType.BOOLEAN, value: false }]) };
    } else {
      console.log(node);
      throw unsupported(node);
    }
    return {};
  };

  try {
    execNode(sourceFile, globalScope);
  } catch (err) {
    if (err && err instanceof CompileError)
      addDiagnostic(err.message, err.node);
    else throw err;
  }
  return { diagnostics };
};

export const compileAndLog = (code: string): void => {
  const { diagnostics } = compile(code);
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => EOL,
    })
  );
};

const createGlobalScope = (): Scope =>
  new Scope(
    undefined,
    new Map([
      [
        "console",
        new Value([
          {
            type: ValueType.OBJECT,
            props: {
              log: new Value([
                {
                  type: ValueType.FUNCTION,
                  hasSideEffects: true,
                  handler: () => new Value([{ type: ValueType.UNDEFINED }]),
                },
              ]),
            },
          },
        ]),
      ],
    ])
  );

const applyToValue = (
  value: Value,
  callback: (constraint: ValueConstraint) => ValueConstraint[]
): Value => {
  const constraintsByType: {
    [T in ValueType]?: Extract<ValueConstraint, { type: T }>[] | true;
  } = {};
  for (const constraint of value.constraints) {
    for (const result of callback(constraint)) {
      if (result.type === ValueType.ANY) return new Value([result]);
      const existing = constraintsByType[result.type];
      if (existing) {
        if (existing === true) continue;
        const entries = Object.entries(result).filter(
          ([key]) => key !== "type"
        );
        if (entries.length === 0) {
          constraintsByType[result.type] = true;
        } else if (
          !existing.some(
            (c2) =>
              Object.keys(c2).length === entries.length + 1 &&
              entries.every(
                ([key, value]) => (c2 as Record<string, unknown>)[key] === value
              )
          )
        ) {
          existing.push(result as any);
        }
      } else {
        constraintsByType[result.type] = [result as any];
      }
    }
  }
  return new Value(
    Object.entries(constraintsByType).flatMap(([type, constraints]) =>
      constraints === true ? [{ type: +type }] : constraints
    )
  );
};
