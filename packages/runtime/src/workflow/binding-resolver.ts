import type { CanonicalJsonRecord, CanonicalJsonValue } from "@resin/contracts";

/**
 * Evaluates and resolves variable bindings in workflow steps and compensation actions.
 * Enforces schema bounds, prevents code injection, and prevents directory traversal attacks.
 */
export class BindingResolver {
  /**
   * Resolves all variable expressions in an inputs object against the given execution context.
   */
  resolveInputs(
    inputs: CanonicalJsonRecord,
    context: {
      workflowInputs: CanonicalJsonRecord;
      stepResults: CanonicalJsonRecord;
      secrets?: Record<string, string>;
    },
  ): CanonicalJsonRecord {
    const resolved: CanonicalJsonRecord = {};
    for (const [key, val] of Object.entries(inputs)) {
      resolved[key] = this.resolveValue(val, context, `input.${key}`);
    }
    return resolved;
  }

  /**
   * Recursively resolves an individual value or data structure.
   */
  resolveValue(
    val: CanonicalJsonValue,
    context: {
      workflowInputs: CanonicalJsonRecord;
      stepResults: CanonicalJsonRecord;
      secrets?: Record<string, string>;
    },
    location: string,
  ): CanonicalJsonValue {
    if (val === null || val === undefined) {
      return val;
    }

    if (Object.prototype.toString.call(val) === "[object String]") {
      // SAFETY: Object tag check confirms val is a string.
      const strVal = val as string;
      this.validateBindingSafety(strVal, location);

      // Exact single reference matching: ${input.foo} or $input.foo
      if ((strVal.startsWith("${input.") && strVal.endsWith("}")) || strVal.startsWith("$input.")) {
        const pathStr = strVal.startsWith("${") ? strVal.slice(8, -1) : strVal.slice(7);
        return this.getNestedProperty(context.workflowInputs, pathStr);
      }
      if ((strVal.startsWith("${step.") && strVal.endsWith("}")) || strVal.startsWith("$step.")) {
        const pathStr = strVal.startsWith("${") ? strVal.slice(7, -1) : strVal.slice(6);
        const parts = pathStr.split(".");
        const stepId = parts[0];
        const subPath = parts.slice(1).join(".");
        const stepOutput = context.stepResults[stepId];
        return this.getNestedProperty(stepOutput, subPath);
      }
      if ((strVal.startsWith("${env.") && strVal.endsWith("}")) || strVal.startsWith("$env.")) {
        const envVar = strVal.startsWith("${") ? strVal.slice(6, -1) : strVal.slice(5);
        if (context.secrets && envVar in context.secrets) {
          return context.secrets[envVar];
        }
        return process.env[envVar] ?? "";
      }

      // Template string interpolation: "prefix_${input.foo}_suffix"
      if (strVal.includes("${input.") || strVal.includes("${step.") || strVal.includes("${env.")) {
        return strVal.replace(/\$\{(input|step|env)\.([a-zA-Z0-9_.-]+)\}/g, (_, type, pathStr) => {
          if (type === "input") {
            const resolvedProp = this.getNestedProperty(context.workflowInputs, pathStr);
            return resolvedProp !== undefined && resolvedProp !== null ? String(resolvedProp) : "";
          }
          if (type === "step") {
            const parts = pathStr.split(".");
            const stepId = parts[0];
            const subPath = parts.slice(1).join(".");
            const stepOutput = context.stepResults[stepId];
            const resolvedProp = this.getNestedProperty(stepOutput, subPath);
            return resolvedProp !== undefined && resolvedProp !== null ? String(resolvedProp) : "";
          }
          if (type === "env") {
            if (context.secrets && pathStr in context.secrets) {
              return context.secrets[pathStr];
            }
            return process.env[pathStr] ?? "";
          }
          return "";
        });
      }

      return strVal;
    }

    if (Array.isArray(val)) {
      return val.map((item, idx) => this.resolveValue(item, context, `${location}[${idx}]`));
    }

    if (Object.prototype.toString.call(val) === "[object Object]") {
      const resolvedObj: CanonicalJsonRecord = {};
      // SAFETY: Object tag check confirms val is a record.
      for (const [k, v] of Object.entries(val as CanonicalJsonRecord)) {
        resolvedObj[k] = this.resolveValue(v, context, `${location}.${k}`);
      }
      return resolvedObj;
    }

    return val;
  }

  /**
   * Validates that variable binding string does not contain code injection or path traversal.
   */
  validateBindingSafety(val: string, location: string): void {
    const forbiddenPatterns = [
      "eval(",
      "Function(",
      "process.",
      "__proto__",
      "constructor[",
      "<script",
    ];

    for (const pattern of forbiddenPatterns) {
      if (val.includes(pattern)) {
        throw new Error(
          `Security validation failed in ${location}: forbidden pattern "${pattern}" detected.`,
        );
      }
    }

    if (
      (location.toLowerCase().includes("path") || location.toLowerCase().includes("dir")) &&
      (val.includes("../") || val.includes("..\\"))
    ) {
      throw new Error(
        `Security validation failed in ${location}: path traversal attempt ("../") detected.`,
      );
    }
  }

  /**
   * Safely retrieves a nested property using dot-notation path without prototype pollution.
   */
  private getNestedProperty(obj: CanonicalJsonValue, path: string): CanonicalJsonValue {
    if (obj === null || obj === undefined) return undefined;
    if (path.length === 0) return obj;

    const parts = path.split(".");
    let current: CanonicalJsonValue = obj;

    for (const part of parts) {
      if (part === "__proto__" || part === "prototype" || part === "constructor") {
        return undefined;
      }
      if (current && Object.prototype.toString.call(current) === "[object Object]") {
        // SAFETY: Tag check confirms current is a JSON object record.
        const rec = current as CanonicalJsonRecord;
        if (part in rec) {
          current = rec[part];
        } else {
          return undefined;
        }
      } else {
        return undefined;
      }
    }

    return current;
  }
}
