/**
 * Evaluates and resolves variable bindings in workflow steps and compensation actions.
 * Enforces schema bounds, prevents code injection, and prevents directory traversal attacks.
 */
export class BindingResolver {
  /**
   * Resolves all variable expressions in an inputs object against the given execution context.
   */
  resolveInputs(
    inputs: Record<string, unknown>,
    context: {
      workflowInputs: Record<string, unknown>;
      stepResults: Record<string, unknown>;
      secrets?: Record<string, string>;
    },
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(inputs)) {
      resolved[key] = this.resolveValue(val, context, `input.${key}`);
    }
    return resolved;
  }

  /**
   * Recursively resolves an individual value or data structure.
   */
  resolveValue(
    val: unknown,
    context: {
      workflowInputs: Record<string, unknown>;
      stepResults: Record<string, unknown>;
      secrets?: Record<string, string>;
    },
    location: string,
  ): unknown {
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === "string") {
      this.validateBindingSafety(val, location);

      // Exact single reference matching: ${input.foo} or $input.foo
      if ((val.startsWith("${input.") && val.endsWith("}")) || val.startsWith("$input.")) {
        const varPath = val.startsWith("${") ? val.slice(8, -1) : val.slice(7);
        return this.getNestedProperty(context.workflowInputs, varPath);
      }

      // Exact single step reference: ${step.id.output} or $step.id.output
      if ((val.startsWith("${step.") && val.endsWith("}")) || val.startsWith("$step.")) {
        const fullPath = val.startsWith("${") ? val.slice(7, -1) : val.slice(6);
        const parts = fullPath.split(".");
        const stepId = parts[0];
        const propertyPath = parts.slice(1).join(".");
        const stepResult = context.stepResults[stepId];
        if (propertyPath.length === 0) {
          return stepResult;
        }
        return this.getNestedProperty(stepResult, propertyPath);
      }

      // Exact secret reference: ${env.SECRET} or $env.SECRET
      if ((val.startsWith("${env.") && val.endsWith("}")) || val.startsWith("$env.")) {
        const secretName = val.startsWith("${") ? val.slice(6, -1) : val.slice(5);
        return context.secrets?.[secretName] ?? `\${env.${secretName}}`;
      }

      // String template interpolation: "prefix_${input.name}_suffix"
      if (val.includes("${input.") || val.includes("${step.") || val.includes("${env.")) {
        return val.replace(/\$\{(input|step|env)\.([a-zA-Z0-9_.-]+)\}/g, (_, type, pathStr) => {
          if (type === "input") {
            const resolvedProp = this.getNestedProperty(context.workflowInputs, pathStr);
            return resolvedProp !== undefined ? String(resolvedProp) : "";
          }
          if (type === "step") {
            const parts = pathStr.split(".");
            const stepId = parts[0];
            const propertyPath = parts.slice(1).join(".");
            const stepResult = context.stepResults[stepId];
            const resolvedProp =
              propertyPath.length > 0
                ? this.getNestedProperty(stepResult, propertyPath)
                : stepResult;
            return resolvedProp !== undefined ? String(resolvedProp) : "";
          }
          if (type === "env") {
            const secretVal = context.secrets?.[pathStr];
            return secretVal !== undefined ? secretVal : "";
          }
          return "";
        });
      }

      return val;
    }

    if (Array.isArray(val)) {
      return val.map((item, idx) => this.resolveValue(item, context, `${location}[${idx}]`));
    }

    if (typeof val === "object") {
      const resolvedObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
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
  private getNestedProperty(obj: unknown, path: string): unknown {
    if (obj === null || obj === undefined) return undefined;
    if (path.length === 0) return obj;

    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      if (part === "__proto__" || part === "prototype" || part === "constructor") {
        return undefined;
      }
      if (current && typeof current === "object" && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }
}
