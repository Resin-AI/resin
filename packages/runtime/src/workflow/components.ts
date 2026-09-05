import { createHash } from "node:crypto";
import {
  type ComponentComposition,
  ComponentCompositionSchema,
  type ComponentContract,
  ComponentContractSchema,
  componentContractDigest,
} from "@resin/contracts";
import ts from "typescript";
import { COMPONENT_RUNTIME_TYPESCRIPT } from "./component-runtime-source.js";
export type { ComponentComposition } from "@resin/contracts";

export interface ComponentArtifact {
  contract: ComponentContract;
  source: string;
}

/** Intentionally self-contained: this function is also embedded in sandboxed tool source. */
export function assertComponentValue(schema: Record<string, unknown>, value: unknown): void {
  function check(rule: Record<string, unknown>, item: unknown, path: string): void {
    const supported = [
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "description",
      "title",
      "default",
    ];
    for (const key of Object.keys(rule))
      if (!supported.includes(key)) throw new Error(`Unsupported component schema keyword: ${key}`);
    if (
      Array.isArray(rule.enum) &&
      !rule.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(item))
    )
      throw new Error(`Component enum mismatch at ${path}`);
    switch (rule.type) {
      case "object": {
        if (!item || typeof item !== "object" || Array.isArray(item))
          throw new Error(`Expected object at ${path}`);
        const record = item as Record<string, unknown>;
        const properties = (rule.properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const key of (rule.required ?? []) as string[])
          if (!Object.hasOwn(record, key))
            throw new Error(`Missing component field ${path}.${key}`);
        for (const [key, child] of Object.entries(record)) {
          if (["__proto__", "prototype", "constructor"].includes(key))
            throw new Error("Unsafe component field");
          if (Object.hasOwn(properties, key)) check(properties[key], child, `${path}.${key}`);
          else if (rule.additionalProperties !== true)
            throw new Error(`Unexpected component field ${path}.${key}`);
        }
        break;
      }
      case "array":
        if (!Array.isArray(item) || !rule.items || typeof rule.items !== "object")
          throw new Error(`Expected bounded array schema at ${path}`);
        if (
          item.length > 10000 ||
          (typeof rule.maxItems === "number" && item.length > rule.maxItems) ||
          (typeof rule.minItems === "number" && item.length < rule.minItems)
        )
          throw new Error(`Component array bounds at ${path}`);
        for (let index = 0; index < item.length; index++)
          check(rule.items as Record<string, unknown>, item[index], `${path}[${index}]`);
        break;
      case "string":
        if (
          typeof item !== "string" ||
          item.length > 1048576 ||
          (typeof rule.minLength === "number" && item.length < rule.minLength) ||
          (typeof rule.maxLength === "number" && item.length > rule.maxLength)
        )
          throw new Error(`Component string bounds at ${path}`);
        break;
      case "number":
      case "integer":
        if (
          typeof item !== "number" ||
          !Number.isFinite(item) ||
          (rule.type === "integer" && !Number.isInteger(item)) ||
          (typeof rule.minimum === "number" && item < rule.minimum) ||
          (typeof rule.maximum === "number" && item > rule.maximum)
        )
          throw new Error(`Component number bounds at ${path}`);
        break;
      case "boolean":
        if (typeof item !== "boolean") throw new Error(`Expected boolean at ${path}`);
        break;
      case "null":
        if (item !== null) throw new Error(`Expected null at ${path}`);
        break;
      default:
        throw new Error(`Unsupported component schema type at ${path}`);
    }
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 1048576)
    throw new Error("Component value size exceeded");
  check(schema, value, "$");
}

/** Resolves data bindings without eval, expression interpolation, or inherited properties. */
export async function executeComponentComposition(
  composition: ComponentComposition,
  input: Record<string, unknown>,
  invoke: (index: number, input: Record<string, unknown>) => Promise<unknown>,
  validate: typeof assertComponentValue = assertComponentValue,
): Promise<Record<string, unknown>> {
  validate(composition.inputSchema, input);
  const completed: Record<string, unknown> = Object.create(null);
  function bind(binding: ComponentComposition["outputs"][string]): unknown {
    if (binding.from === "literal") return structuredClone(binding.value);
    let value: unknown = binding.from === "input" ? input : completed[binding.step];
    for (const key of binding.path) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !value ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key)
      )
        throw new Error("Unresolved component binding");
      value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined) throw new Error("Unresolved component binding");
    return structuredClone(value);
  }
  for (const [index, step] of composition.steps.entries()) {
    if (Object.hasOwn(completed, step.id)) throw new Error("Duplicate component step");
    const inputs = Object.fromEntries(
      Object.entries(step.inputs).map(([key, binding]) => [key, bind(binding)]),
    );
    completed[step.id] = await invoke(index, inputs);
  }
  const output = Object.fromEntries(
    Object.entries(composition.outputs).map(([key, binding]) => [key, bind(binding)]),
  );
  validate(composition.outputSchema, output);
  return output;
}

/** Reject impossible bindings before running any component (including side effects). */
export function validateCompositionBindings(
  composition: ComponentComposition,
  contracts: ComponentContract[],
): void {
  if (contracts.length !== composition.steps.length)
    throw new Error("Component contract count mismatch");
  const preceding: Record<string, Record<string, unknown>> = Object.create(null);
  function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
    if (schema.type !== "object") throw new Error("Component interfaces must be objects");
    return (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  }
  function resolve(
    binding: ComponentComposition["outputs"][string],
  ): Record<string, unknown> | undefined {
    if (binding.from === "literal") return undefined;
    let schema = binding.from === "input" ? composition.inputSchema : preceding[binding.step];
    if (!schema) throw new Error("Binding requires a preceding component");
    for (const name of binding.path) {
      const fields = properties(schema);
      if (!Object.hasOwn(fields, name)) throw new Error(`Unknown component binding field: ${name}`);
      schema = fields[name];
    }
    return schema;
  }
  function checkBindings(
    bindings: ComponentComposition["outputs"],
    target: Record<string, unknown>,
  ): void {
    const fields = properties(target);
    for (const required of (target.required ?? []) as string[]) {
      if (!Object.hasOwn(bindings, required))
        throw new Error(`Missing component binding: ${required}`);
    }
    for (const [name, binding] of Object.entries(bindings)) {
      if (!Object.hasOwn(fields, name)) throw new Error(`Unknown component input: ${name}`);
      if (binding.from === "literal") assertComponentValue(fields[name], binding.value);
      else if (resolve(binding)?.type !== fields[name].type)
        throw new Error(`Component binding type mismatch: ${name}`);
    }
  }
  for (const [index, step] of composition.steps.entries()) {
    checkBindings(step.inputs, contracts[index].inputSchema);
    preceding[step.id] = contracts[index].outputSchema;
  }
  checkBindings(composition.outputs, composition.outputSchema);
}

/**
 * Bundles immutable components into the existing defineTool ABI. The resulting tool
 * still requires full static review, qualification, signed activation and broker grants.
 * It introduces no runtime download, dynamic import, command runner or harness injection.
 */
export function compileComponentComposition(
  raw: ComponentComposition,
  artifacts: ComponentArtifact[],
): string {
  const composition = ComponentCompositionSchema.parse(raw);
  if (artifacts.length !== composition.steps.length)
    throw new Error("Component artifact count mismatch");
  validateCompositionBindings(
    composition,
    artifacts.map((artifact) => artifact.contract),
  );
  const handlers = artifacts.map((artifact, index) => {
    const contract = ComponentContractSchema.parse(artifact.contract);
    const ref = composition.steps[index].component;
    if (
      componentContractDigest(contract) !== ref.contractDigest ||
      createHash("sha256").update(artifact.source).digest("hex") !== ref.sourceDigest
    )
      throw new Error("Component digest mismatch");
    const file = ts.createSourceFile(
      "component.ts",
      artifact.source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    let hasDefault = false;
    const statements: string[] = [];
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          statement.moduleSpecifier.text !== "@resin/runtime" ||
          !statement.importClause?.namedBindings ||
          !ts.isNamedImports(statement.importClause.namedBindings)
        )
          throw new Error("Component imports must use the tool SDK only");
        for (const specifier of statement.importClause.namedBindings.elements) {
          if (
            !statement.importClause.isTypeOnly &&
            !specifier.isTypeOnly &&
            (specifier.name.text !== "defineTool" || specifier.propertyName)
          )
            throw new Error("Unsupported component SDK import");
        }
        continue;
      }
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        if (hasDefault) throw new Error("Duplicate component handler");
        hasDefault = true;
        statements.push(`return ${statement.expression.getText(file)};`);
      } else {
        if (
          ts.isExportDeclaration(statement) ||
          (ts.canHaveModifiers(statement) &&
            ts
              .getModifiers(statement)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
        )
          throw new Error("Component must export one default handler");
        statements.push(statement.getText(file));
      }
    }
    if (!hasDefault) throw new Error("Missing component default handler");
    return `(() => {\n${statements.join("\n")}\n})()`;
  });
  const source = `import { defineTool, type ToolContext, type ComponentComposition } from "@resin/runtime";
${COMPONENT_RUNTIME_TYPESCRIPT}
const composition: ComponentComposition = ${JSON.stringify(composition)};
const contracts = ${JSON.stringify(artifacts.map((artifact) => artifact.contract))};
const handlers: unknown[] = [${handlers.join(",\n")}];
export default defineTool(async (context: ToolContext<Record<string, unknown>>) => executeComponentComposition(composition, context.input, async (index, input) => {
  assertComponentValue(contracts[index].inputSchema, input);
  const handler = handlers[index];
  if (typeof handler !== "function") throw new Error("Invalid component handler");
  const output: unknown = await handler({ ...context, input });
  assertComponentValue(contracts[index].outputSchema, output);
  return output;
}));`;
  return source;
}
