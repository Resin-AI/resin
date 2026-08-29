// Resin Standalone Install Helper V1.0.0
// Cryptographically verified, standalone bootstrap installer.
// Generated deterministically by build-install-helper.

var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// apps/cli/src/installer/bootstrap-entry.ts
import child_process from "node:child_process";
import os2 from "node:os";
import path3 from "node:path";
import process3 from "node:process";
import { pathToFileURL } from "node:url";

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path4, errorMaps, issueData } = params;
  const fullPath = [...path4, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/.pnpm/zod@3.25.76/node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path4, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path4;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// packages/contracts/dist/common.js
var SchemaVersionSchema = external_exports.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/, "Invalid semantic version string");
var UUIDSchema = external_exports.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Invalid UUID string");
var ULIDSchema = external_exports.string().regex(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i, "Invalid ULID string");
var IdentifierSchema = external_exports.string().min(1, "Identifier cannot be empty").max(128, "Identifier exceeds maximum length of 128 characters").regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,127}$/, "Identifier contains invalid characters");
var ISOTimestampSchema = external_exports.string().datetime({ offset: true, message: "Invalid ISO 8601 timestamp string" });
var EpochMsSchema = external_exports.number().int("Epoch timestamp must be an integer").nonnegative("Epoch timestamp must be non-negative");
var Sha256DigestSchema = external_exports.string().regex(/^(sha256:)?[a-f0-9]{64}$/i, "Invalid SHA-256 digest format (expected 64 hex characters or sha256:<hex>)");
var PrefixedSha256DigestSchema = external_exports.string().regex(/^sha256:[a-f0-9]{64}$/i, "Invalid prefixed SHA-256 digest format (expected sha256:<64-hex>)");
var CausalRefSchema = external_exports.object({
  parentId: IdentifierSchema.nullable().optional(),
  rootId: IdentifierSchema.nullable().optional(),
  causalSequence: external_exports.number().int("Causal sequence must be an integer").nonnegative("Causal sequence must be non-negative"),
  turnIndex: external_exports.number().int("Turn index must be an integer").nonnegative("Turn index must be non-negative").optional(),
  stepIndex: external_exports.number().int("Step index must be an integer").nonnegative("Step index must be non-negative").optional(),
  traceId: external_exports.string().min(1).max(128).optional(),
  spanId: external_exports.string().min(1).max(128).optional()
});
var RedactionStrategySchema = external_exports.enum(["mask", "tokenize", "drop", "synthetic", "none"]);
var RedactionMetaSchema = external_exports.object({
  isRedacted: external_exports.boolean(),
  redactedFields: external_exports.array(external_exports.string()).default([]),
  redactionStrategy: RedactionStrategySchema.default("none"),
  scrubbedPatterns: external_exports.array(external_exports.string()).default([]),
  redactedAt: ISOTimestampSchema.optional()
});
function normalizeSha256(digest, prefix = false) {
  const cleanHex = digest.toLowerCase().replace(/^sha256:/, "");
  if (cleanHex.length !== 64 || !/^[a-f0-9]{64}$/.test(cleanHex)) {
    throw new Error(`Invalid SHA-256 digest: ${digest}`);
  }
  return prefix ? `sha256:${cleanHex}` : cleanHex;
}

// packages/contracts/dist/canonical.js
import { createHash } from "node:crypto";
function canonicalJsonStringify(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  function serialize(val) {
    if (val === null) {
      return "null";
    }
    if (val === void 0 || typeof val === "symbol" || typeof val === "function") {
      return void 0;
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false";
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new TypeError(`Cannot canonically serialize non-finite number: ${val}`);
      }
      return JSON.stringify(val);
    }
    if (typeof val === "string") {
      return JSON.stringify(val);
    }
    if (typeof val === "bigint") {
      throw new TypeError("Cannot canonically serialize BigInt without explicit conversion");
    }
    if (typeof val === "object") {
      const toJSONObj = val;
      if (typeof toJSONObj.toJSON === "function") {
        return serialize(toJSONObj.toJSON());
      }
      if (seen.has(val)) {
        throw new TypeError("Cyclic reference detected during canonical JSON serialization");
      }
      seen.add(val);
      try {
        if (Array.isArray(val)) {
          const serializedElements = [];
          for (let i = 0; i < val.length; i++) {
            const itemStr = serialize(val[i]);
            serializedElements.push(itemStr === void 0 ? "null" : itemStr);
          }
          return `[${serializedElements.join(",")}]`;
        }
        const keys = Object.keys(val).sort();
        const entries = [];
        for (const key of keys) {
          const propVal = val[key];
          const serializedProp = serialize(propVal);
          if (serializedProp !== void 0) {
            entries.push(`${JSON.stringify(key)}:${serializedProp}`);
          }
        }
        return `{${entries.join(",")}}`;
      } finally {
        seen.delete(val);
      }
    }
    throw new TypeError(`Unsupported data type encountered: ${typeof val}`);
  }
  const result = serialize(value);
  return result === void 0 ? "undefined" : result;
}
function hashCanonicalContent(value, options = {}) {
  const serialized = canonicalJsonStringify(value);
  const hashHex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return options.prefix ? `sha256:${hashHex}` : hashHex;
}
var hashCanonical = hashCanonicalContent;

// packages/contracts/dist/events.js
var ProviderUsageAvailabilitySchema = external_exports.enum(["complete", "partial", "unavailable"]);
var ProviderReportedUsageSchema = external_exports.object({
  provider: external_exports.string().min(1),
  model: external_exports.string().min(1).optional().nullable(),
  accountingVersion: external_exports.string().min(1),
  availability: ProviderUsageAvailabilitySchema,
  inputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  outputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  reasoningTokens: external_exports.number().int().nonnegative().optional().nullable(),
  cachedInputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  totalTokens: external_exports.number().int().nonnegative().optional().nullable(),
  costMicroUsd: external_exports.number().int().nonnegative().optional().nullable(),
  durationMs: external_exports.number().int().nonnegative().optional().nullable()
}).strict().superRefine((val, ctx) => {
  if (val.availability === "complete") {
    if (val.totalTokens === void 0 || val.totalTokens === null) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Complete provider usage requires totalTokens to be present",
        path: ["totalTokens"]
      });
    }
  } else if (val.availability === "unavailable") {
    const metricFields = [
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cachedInputTokens",
      "totalTokens",
      "costMicroUsd",
      "durationMs"
    ];
    for (const field of metricFields) {
      if (val[field] !== void 0 && val[field] !== null) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          message: `Unavailable provider usage cannot specify ${field}`,
          path: [field]
        });
      }
    }
  }
});
var BaseEventFields = {
  eventId: IdentifierSchema,
  schemaVersion: SchemaVersionSchema,
  sessionId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  causalRef: CausalRefSchema,
  redaction: RedactionMetaSchema,
  metadata: external_exports.record(external_exports.unknown()).optional(),
  providerUsage: ProviderReportedUsageSchema.optional()
};
var MessageContentPartSchema = external_exports.object({
  type: external_exports.enum(["text", "image", "resource", "json"]),
  text: external_exports.string().optional(),
  data: external_exports.string().optional(),
  mimeType: external_exports.string().optional(),
  metadata: external_exports.record(external_exports.unknown()).optional()
});
var NormalizedMessageEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("message"),
  role: external_exports.enum(["user", "assistant", "system", "tool"]),
  content: external_exports.string(),
  contentParts: external_exports.array(MessageContentPartSchema).optional(),
  model: external_exports.string().optional()
});
var NormalizedModelReasoningEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("model_reasoning"),
  reasoningContent: external_exports.string(),
  signature: external_exports.string().optional(),
  tokenCount: external_exports.number().int().nonnegative().optional(),
  model: external_exports.string().optional(),
  durationMs: external_exports.number().nonnegative().optional()
});
var DiscoveredToolEntrySchema = external_exports.object({
  name: external_exports.string().min(1),
  description: external_exports.string().optional(),
  inputSchema: external_exports.record(external_exports.unknown()).optional(),
  provider: external_exports.string().optional()
});
var NormalizedToolDiscoveryEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("tool_discovery"),
  tools: external_exports.array(DiscoveredToolEntrySchema),
  provider: external_exports.string().optional(),
  source: external_exports.enum(["mcp", "builtin", "dynamic", "harness"]).default("mcp")
});
var NormalizedToolCallEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("tool_call"),
  callId: IdentifierSchema,
  toolName: external_exports.string().min(1),
  parameters: external_exports.record(external_exports.unknown()),
  candidateRef: IdentifierSchema.optional(),
  isShadow: external_exports.boolean().default(false)
});
var NormalizedToolResultEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("tool_result"),
  callId: IdentifierSchema,
  toolName: external_exports.string().min(1),
  result: external_exports.unknown(),
  isError: external_exports.boolean(),
  executionDurationMs: external_exports.number().nonnegative(),
  outputSizeBytes: external_exports.number().int().nonnegative().optional(),
  isShadow: external_exports.boolean().default(false)
});
var NormalizedCommandExecEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("command_exec"),
  command: external_exports.string(),
  args: external_exports.array(external_exports.string()).default([]),
  cwd: external_exports.string().optional(),
  exitCode: external_exports.number().int(),
  stdout: external_exports.string().optional(),
  stderr: external_exports.string().optional(),
  durationMs: external_exports.number().nonnegative()
});
var FileDiffStatsSchema = external_exports.object({
  linesAdded: external_exports.number().int().nonnegative(),
  linesRemoved: external_exports.number().int().nonnegative()
});
var NormalizedFileEditEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("file_edit"),
  filePath: external_exports.string().min(1),
  operation: external_exports.enum(["create", "update", "delete", "patch"]),
  patch: external_exports.string().optional(),
  beforeHash: Sha256DigestSchema.optional(),
  afterHash: Sha256DigestSchema.optional(),
  diffStats: FileDiffStatsSchema.optional()
});
var NormalizedErrorEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("error"),
  errorType: external_exports.string().min(1),
  message: external_exports.string(),
  stack: external_exports.string().optional(),
  recoverable: external_exports.boolean(),
  details: external_exports.record(external_exports.unknown()).optional()
});
var NormalizedCompactionEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("compaction"),
  triggerReason: external_exports.enum(["context_limit", "manual", "scheduled", "turn_threshold"]),
  tokensBefore: external_exports.number().int().nonnegative(),
  tokensAfter: external_exports.number().int().nonnegative(),
  preservedContextSummary: external_exports.string().optional()
});
var NormalizedBranchForkEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("branch_fork"),
  sourceSessionId: IdentifierSchema,
  branchPointEventId: IdentifierSchema,
  forkReason: external_exports.string().optional(),
  branchName: external_exports.string().optional()
});
var NormalizedSubagentLifecycleEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("subagent_lifecycle"),
  subagentId: IdentifierSchema,
  lifecycleType: external_exports.enum(["spawn", "start", "pause", "resume", "terminate", "settle"]),
  parentId: IdentifierSchema.optional(),
  role: external_exports.string().optional(),
  reason: external_exports.string().optional()
});
var NormalizedSessionLifecycleEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("session_lifecycle"),
  lifecycleType: external_exports.enum(["start", "pause", "resume", "end", "crash"]),
  exitReason: external_exports.string().optional(),
  harnessName: external_exports.string().optional(),
  workspaceId: IdentifierSchema.optional()
});
var NormalizedUnknownPassthroughEventSchema = external_exports.object({
  ...BaseEventFields,
  type: external_exports.literal("unknown_passthrough"),
  rawEventType: external_exports.string().min(1),
  rawPayload: external_exports.record(external_exports.unknown())
});
var NormalizedSessionEventSchema = external_exports.discriminatedUnion("type", [
  NormalizedMessageEventSchema,
  NormalizedModelReasoningEventSchema,
  NormalizedToolDiscoveryEventSchema,
  NormalizedToolCallEventSchema,
  NormalizedToolResultEventSchema,
  NormalizedCommandExecEventSchema,
  NormalizedFileEditEventSchema,
  NormalizedErrorEventSchema,
  NormalizedCompactionEventSchema,
  NormalizedBranchForkEventSchema,
  NormalizedSubagentLifecycleEventSchema,
  NormalizedSessionLifecycleEventSchema,
  NormalizedUnknownPassthroughEventSchema
]);

// packages/contracts/dist/capabilities.js
var FsCapabilitySchema = external_exports.object({
  readPaths: external_exports.array(external_exports.string()).default([]),
  writePaths: external_exports.array(external_exports.string()).default([]),
  allowWorkspaceRoot: external_exports.boolean().default(true),
  allowTemp: external_exports.boolean().default(true),
  denyPaths: external_exports.array(external_exports.string()).default([]),
  maxFileSizeBytes: external_exports.number().int().positive().default(10485760)
  // 10MB
});
var NetCapabilitySchema = external_exports.object({
  allowOutbound: external_exports.boolean().default(false),
  allowedDomains: external_exports.array(external_exports.string()).default([]),
  allowedHosts: external_exports.array(external_exports.string()).default([]),
  allowedPorts: external_exports.array(external_exports.number().int().min(1).max(65535)).default([]),
  allowedProtocols: external_exports.array(external_exports.enum(["http", "https", "ws", "wss"])).default(["https"]),
  allowLocalhost: external_exports.boolean().default(false),
  denyPrivateRanges: external_exports.boolean().default(true)
});
var CommandCapabilitySchema = external_exports.object({
  allowShellExecution: external_exports.boolean().default(false),
  allowedCommands: external_exports.array(external_exports.string()).default([]),
  allowedBinaries: external_exports.array(external_exports.string()).default([]),
  forbiddenPatterns: external_exports.array(external_exports.string()).default([]),
  allowEnvPassthrough: external_exports.array(external_exports.string()).default([])
});
var SecretCapabilitySchema = external_exports.object({
  allowedSecretNames: external_exports.array(external_exports.string()).default([]),
  allowedPrefixes: external_exports.array(external_exports.string()).default([]),
  denyDirectRead: external_exports.boolean().default(true),
  injectAsEnv: external_exports.boolean().default(true)
});
var CapabilityLimitsSchema = external_exports.object({
  maxConcurrentExecutions: external_exports.number().int().positive().default(4),
  maxCpuUsagePercent: external_exports.number().int().min(1).max(100).default(100),
  maxMemoryMb: external_exports.number().int().positive().default(128),
  maxExecutionTimeMs: external_exports.number().int().positive().default(3e4),
  maxOutputSizeBytes: external_exports.number().int().positive().default(1048576)
  // 1MB
});
var CapabilityManifestSchema = external_exports.object({
  manifestId: IdentifierSchema.optional(),
  fs: FsCapabilitySchema.default({}),
  net: NetCapabilitySchema.default({}),
  command: CommandCapabilitySchema.default({}),
  secrets: SecretCapabilitySchema.default({}),
  limits: CapabilityLimitsSchema.default({})
});
var CapabilityGrantSchema = external_exports.object({
  grantId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  grantedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema.optional(),
  grantType: external_exports.enum(["implicit", "explicit", "policy"]),
  capabilities: CapabilityManifestSchema,
  actor: external_exports.object({
    type: external_exports.enum(["user", "admin", "policy_engine", "default"]),
    id: external_exports.string()
  }),
  reason: external_exports.string().optional()
});
var CapabilityEnvelopeSchema = external_exports.object({
  envelopeId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  version: SchemaVersionSchema,
  fs: FsCapabilitySchema.default({}),
  net: NetCapabilitySchema.default({}),
  command: CommandCapabilitySchema.default({}),
  secrets: SecretCapabilitySchema.default({}),
  limits: CapabilityLimitsSchema.default({}),
  isFrozen: external_exports.boolean().default(false),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
});

// packages/contracts/dist/tools.js
var ToolScopeSchema = external_exports.enum(["workspace", "user", "global", "session"]);
var ToolParameterSchema = external_exports.object({
  type: external_exports.literal("object").default("object"),
  properties: external_exports.record(external_exports.record(external_exports.unknown())).default({}),
  required: external_exports.array(external_exports.string()).default([]),
  additionalProperties: external_exports.boolean().default(false),
  description: external_exports.string().optional()
});
var ToolOutputSchema = external_exports.object({
  type: external_exports.string().default("object"),
  properties: external_exports.record(external_exports.record(external_exports.unknown())).optional(),
  description: external_exports.string().optional(),
  schema: external_exports.record(external_exports.unknown()).optional()
});
var ToolRuntimeRequirementSchema = external_exports.object({
  runtime: external_exports.enum(["deno", "node", "python", "wasm", "shell", "builtin"]),
  minRuntimeVersion: external_exports.string().optional(),
  memoryLimitMb: external_exports.number().int().positive().default(128),
  timeoutMs: external_exports.number().int().positive().default(3e4),
  cpuLimitPercent: external_exports.number().int().min(1).max(100).default(100),
  maxOutputSizeBytes: external_exports.number().int().positive().default(1048576)
  // 1MB
});
var ToolLimitConfigSchema = external_exports.object({
  timeoutMs: external_exports.number().int().positive().default(3e4),
  maxOutputBytes: external_exports.number().int().positive().default(1048576),
  maxMemoryBytes: external_exports.number().int().positive().default(134217728),
  // 128MB
  maxConcurrentInvocations: external_exports.number().int().positive().default(4)
});
var ToolManifestSchema = external_exports.object({
  id: IdentifierSchema,
  name: external_exports.string().min(1).max(128),
  version: SchemaVersionSchema,
  description: external_exports.string().min(1).max(4096),
  parameters: ToolParameterSchema,
  outputSchema: ToolOutputSchema.optional(),
  runtime: ToolRuntimeRequirementSchema,
  capabilities: CapabilityManifestSchema,
  limits: ToolLimitConfigSchema.default({}),
  scope: ToolScopeSchema.default("workspace"),
  digest: Sha256DigestSchema,
  metadata: external_exports.record(external_exports.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
});

// packages/contracts/dist/secrets.js
var SecretMediationModeSchema = external_exports.enum([
  "header_template",
  "bearer_token",
  "query_template",
  "command_stdin",
  "command_env"
]);
var SecretReferenceSchema = external_exports.object({
  kind: external_exports.literal("secret_reference").default("secret_reference"),
  /** Secret alias/name in the store (e.g. "GITHUB_TOKEN", "DATABASE_KEY") */
  name: external_exports.string().min(1),
  /** Opaque reference identifier / handle */
  ref: external_exports.string().min(1),
  /** Workspace boundary where this reference is valid */
  workspaceId: external_exports.string().min(1).default("default"),
  /** Permitted mediation modes for this reference */
  permittedModes: external_exports.array(SecretMediationModeSchema).default(["header_template", "bearer_token", "query_template", "command_stdin", "command_env"]),
  /** Optional tool ID bound to this reference */
  toolId: external_exports.string().optional(),
  /** Optional account ID bound to this reference */
  accountId: external_exports.string().optional(),
  /** Optional installation ID bound to this reference */
  installationId: external_exports.string().optional(),
  /** Optional grant ID bound to this reference */
  grantId: external_exports.string().optional(),
  /** Optional expiration timestamp (ISO 8601) */
  expiresAt: ISOTimestampSchema.optional(),
  /** Non-sensitive metadata (never contains secret values) */
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var SecretMediationRequestSchema = external_exports.object({
  reference: external_exports.union([SecretReferenceSchema, external_exports.string().min(1)]),
  mode: SecretMediationModeSchema,
  template: external_exports.string().optional(),
  targetKey: external_exports.string().optional(),
  context: external_exports.object({
    workspaceId: external_exports.string().min(1).optional(),
    toolId: external_exports.string().optional(),
    invocationId: external_exports.string().optional(),
    accountId: external_exports.string().optional(),
    installationId: external_exports.string().optional(),
    grantId: external_exports.string().optional()
  }).optional()
});
var SecretMediationResultSchema = external_exports.object({
  success: external_exports.boolean(),
  mode: SecretMediationModeSchema,
  secretName: external_exports.string(),
  referenceId: external_exports.string().optional(),
  appliedTo: external_exports.string().optional()
});

// packages/contracts/dist/qualification.js
var CURRENT_QUALIFICATION_VERSION = "1.0.0";
var NormalizedSha256DigestSchema = external_exports.string().regex(/^(sha256:)?[a-f0-9]{64}$/i, "Invalid SHA-256 digest format (expected 64 hex characters or sha256:<hex>)").transform((val) => normalizeSha256(val, false));
var QUALIFICATION_ERROR_CODES = {
  INSUFFICIENT_ENVIRONMENTS: "INSUFFICIENT_ENVIRONMENTS",
  MIXED_REVISIONS: "MIXED_REVISIONS",
  MISSING_REVIEWERS: "MISSING_REVIEWERS",
  REVIEWER_VERDICT_FAILED: "REVIEWER_VERDICT_FAILED",
  HISTORY_LEAKAGE: "HISTORY_LEAKAGE",
  BUNDLE_MISMATCH: "BUNDLE_MISMATCH",
  REPLAY_MISMATCH: "REPLAY_MISMATCH",
  APPROVAL_MISMATCH: "APPROVAL_MISMATCH",
  INVALID_SIGNATURE: "INVALID_SIGNATURE"
};
var FrozenToolIntentSchema = external_exports.object({
  intentId: IdentifierSchema,
  schemaVersion: external_exports.literal(CURRENT_QUALIFICATION_VERSION),
  goal: external_exports.string().min(1, "Goal cannot be empty"),
  successCriteria: external_exports.array(external_exports.string().min(1, "Success criterion cannot be empty")).min(1, "successCriteria cannot be empty"),
  inputSchemaDigest: NormalizedSha256DigestSchema,
  constraints: external_exports.array(external_exports.string()),
  createdAt: ISOTimestampSchema,
  createdBy: external_exports.string().min(1, "CreatedBy cannot be empty"),
  intentDigest: NormalizedSha256DigestSchema
}).strict();
function computeFrozenIntentDigest(intent, options = {}) {
  const { intentDigest: _, ...projection } = intent;
  return hashCanonical({
    domain: "resin/frozen-intent/v1",
    constraints: projection.constraints,
    createdAt: projection.createdAt,
    createdBy: projection.createdBy,
    goal: projection.goal,
    inputSchemaDigest: normalizeSha256(projection.inputSchemaDigest, false),
    intentId: projection.intentId,
    schemaVersion: projection.schemaVersion,
    successCriteria: projection.successCriteria
  }, options);
}
var EffectObservationStatusSchema = external_exports.enum(["complete", "unknown"]);
var ConsequentialActionSchema = external_exports.object({
  actionType: external_exports.string().min(1, "actionType cannot be empty"),
  target: external_exports.string().min(1, "target cannot be empty"),
  description: external_exports.string().min(1, "description cannot be empty"),
  requiresExplicitAuthorization: external_exports.literal(true),
  authorizationEvidence: external_exports.string().min(1, "authorizationEvidence cannot be empty").optional()
}).strict();
var ObservedEffectProfileSchema = external_exports.object({
  filesRead: external_exports.object({
    observation: EffectObservationStatusSchema,
    paths: external_exports.array(external_exports.string())
  }).strict(),
  filesCreated: external_exports.object({
    observation: EffectObservationStatusSchema,
    paths: external_exports.array(external_exports.string())
  }).strict(),
  filesModified: external_exports.object({
    observation: EffectObservationStatusSchema,
    paths: external_exports.array(external_exports.string())
  }).strict(),
  filesDeleted: external_exports.object({
    observation: EffectObservationStatusSchema,
    paths: external_exports.array(external_exports.string())
  }).strict(),
  processTree: external_exports.object({
    observation: EffectObservationStatusSchema,
    spawnedProcesses: external_exports.array(external_exports.string())
  }).strict(),
  network: external_exports.object({
    observation: EffectObservationStatusSchema,
    destinations: external_exports.array(external_exports.string()),
    methods: external_exports.array(external_exports.string())
  }).strict(),
  environmentVariables: external_exports.object({
    observation: EffectObservationStatusSchema,
    names: external_exports.array(external_exports.string())
  }).strict(),
  credentials: external_exports.object({
    observation: EffectObservationStatusSchema,
    names: external_exports.array(external_exports.string())
  }).strict(),
  dependencyChanges: external_exports.object({
    observation: EffectObservationStatusSchema,
    changes: external_exports.array(external_exports.string())
  }).strict(),
  artifacts: external_exports.object({
    observation: EffectObservationStatusSchema,
    items: external_exports.array(external_exports.object({
      name: external_exports.string().min(1),
      digest: NormalizedSha256DigestSchema
    }).strict())
  }).strict(),
  validationChecks: external_exports.object({
    observation: EffectObservationStatusSchema,
    checks: external_exports.array(external_exports.object({
      checkId: external_exports.string().min(1),
      name: external_exports.string().min(1),
      passed: external_exports.boolean(),
      details: external_exports.string().optional()
    }).strict())
  }).strict(),
  resourceEnvelope: external_exports.object({
    observation: EffectObservationStatusSchema,
    maxMemoryBytes: external_exports.number().int().nonnegative(),
    cpuTimeMs: external_exports.number().nonnegative(),
    wallDurationMs: external_exports.number().nonnegative()
  }).strict(),
  consequentialActions: external_exports.object({
    observation: EffectObservationStatusSchema,
    actions: external_exports.array(ConsequentialActionSchema)
  }).strict(),
  determinism: external_exports.enum(["deterministic", "non_deterministic", "pseudo_deterministic"]),
  profileDigest: NormalizedSha256DigestSchema.optional()
}).strict();
function computeObservedEffectProfileDigest(profile, options = {}) {
  const { profileDigest: _, ...projection } = profile;
  return hashCanonical({
    domain: "resin/observed-effect-profile/v1",
    ...projection
  }, options);
}
var StructuredCheckSchema = external_exports.object({
  checkId: external_exports.string().min(1, "checkId cannot be empty"),
  name: external_exports.string().min(1, "name cannot be empty"),
  status: external_exports.enum(["passed", "failed", "error"]),
  message: external_exports.string().optional(),
  actualDigest: NormalizedSha256DigestSchema.optional(),
  expectedDigest: NormalizedSha256DigestSchema.optional()
}).strict().superRefine((data, ctx) => {
  if (data.status === "passed") {
    if (data.expectedDigest !== void 0 && data.actualDigest === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Check with status 'passed' specifying expectedDigest must also bind actualDigest",
        path: ["actualDigest"]
      });
    }
    if (data.actualDigest !== void 0 && data.expectedDigest === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Check with status 'passed' specifying actualDigest must also bind expectedDigest",
        path: ["expectedDigest"]
      });
    }
    if (data.actualDigest !== void 0 && data.expectedDigest !== void 0 && normalizeSha256(data.actualDigest, false) !== normalizeSha256(data.expectedDigest, false)) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: `Check with status 'passed' has mismatched actualDigest '${data.actualDigest}' and expectedDigest '${data.expectedDigest}'`,
        path: ["actualDigest"]
      });
    }
  }
});
var QualificationCostsSchema = external_exports.object({
  modelUsageObservation: external_exports.enum(["complete", "not-applicable", "unknown"]),
  inputTokens: external_exports.number().int().nonnegative().optional(),
  outputTokens: external_exports.number().int().nonnegative().optional(),
  cacheReadTokens: external_exports.number().int().nonnegative().optional(),
  costUsd: external_exports.number().nonnegative().optional()
}).strict().superRefine((data, ctx) => {
  if (data.modelUsageObservation === "complete") {
    if (data.inputTokens === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "inputTokens is required when modelUsageObservation is 'complete'",
        path: ["inputTokens"]
      });
    }
    if (data.outputTokens === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "outputTokens is required when modelUsageObservation is 'complete'",
        path: ["outputTokens"]
      });
    }
    if (data.cacheReadTokens === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "cacheReadTokens is required when modelUsageObservation is 'complete'",
        path: ["cacheReadTokens"]
      });
    }
    if (data.costUsd === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "costUsd is required when modelUsageObservation is 'complete'",
        path: ["costUsd"]
      });
    }
  } else if (data.modelUsageObservation === "not-applicable") {
    if (data.inputTokens !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "inputTokens must be absent when modelUsageObservation is 'not-applicable'",
        path: ["inputTokens"]
      });
    }
    if (data.outputTokens !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "outputTokens must be absent when modelUsageObservation is 'not-applicable'",
        path: ["outputTokens"]
      });
    }
    if (data.cacheReadTokens !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "cacheReadTokens must be absent when modelUsageObservation is 'not-applicable'",
        path: ["cacheReadTokens"]
      });
    }
    if (data.costUsd !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "costUsd must be absent when modelUsageObservation is 'not-applicable'",
        path: ["costUsd"]
      });
    }
  }
});
var QualificationRunRecordBaseSchema = external_exports.object({
  runId: IdentifierSchema,
  sequence: external_exports.number().int().nonnegative(),
  candidateId: IdentifierSchema,
  environment: external_exports.string().min(1, "Environment identifier cannot be empty"),
  status: external_exports.enum(["passed", "failed", "error"]),
  sourceDigest: NormalizedSha256DigestSchema,
  dependencyDigest: NormalizedSha256DigestSchema,
  intentDigest: NormalizedSha256DigestSchema,
  environmentDigest: NormalizedSha256DigestSchema,
  inputDigest: NormalizedSha256DigestSchema,
  traceDigest: NormalizedSha256DigestSchema,
  beforeStateDigest: NormalizedSha256DigestSchema,
  afterStateDigest: NormalizedSha256DigestSchema,
  outputDigest: NormalizedSha256DigestSchema,
  checkDigest: NormalizedSha256DigestSchema,
  effectDigest: NormalizedSha256DigestSchema,
  observedEffectProfile: ObservedEffectProfileSchema,
  structuredChecks: external_exports.array(StructuredCheckSchema),
  costs: QualificationCostsSchema,
  previousRecordDigest: NormalizedSha256DigestSchema.nullable().optional(),
  recordDigest: NormalizedSha256DigestSchema,
  startedAt: ISOTimestampSchema,
  completedAt: ISOTimestampSchema,
  logsUri: external_exports.string().optional()
}).strict();
var QualificationRunRecordSchema = QualificationRunRecordBaseSchema.superRefine((data, ctx) => {
  if (data.status === "passed") {
    const profile = data.observedEffectProfile;
    const axes = [
      "filesRead",
      "filesCreated",
      "filesModified",
      "filesDeleted",
      "processTree",
      "network",
      "environmentVariables",
      "credentials",
      "dependencyChanges",
      "artifacts",
      "validationChecks",
      "resourceEnvelope",
      "consequentialActions"
    ];
    for (const axis of axes) {
      const section = profile[axis];
      if (section && section.observation !== "complete") {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          message: `Run with status 'passed' requires axis '${axis}' observation to be 'complete', found '${section.observation}'`,
          path: ["observedEffectProfile", axis, "observation"]
        });
      }
    }
    if (profile.validationChecks && profile.validationChecks.checks) {
      for (let i = 0; i < profile.validationChecks.checks.length; i++) {
        const check = profile.validationChecks.checks[i];
        if (!check.passed) {
          ctx.addIssue({
            code: external_exports.ZodIssueCode.custom,
            message: `Run with status 'passed' has failing validationCheck '${check.checkId}'`,
            path: ["observedEffectProfile", "validationChecks", "checks", i, "passed"]
          });
        }
      }
    }
    if (data.costs.modelUsageObservation === "unknown") {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Run with status 'passed' cannot have unknown modelUsageObservation",
        path: ["costs", "modelUsageObservation"]
      });
    }
    if (data.structuredChecks.length === 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Run with status 'passed' must contain at least one structured check",
        path: ["structuredChecks"]
      });
    }
    for (let i = 0; i < data.structuredChecks.length; i++) {
      const check = data.structuredChecks[i];
      if (check.status !== "passed") {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          message: `Run with status 'passed' contains non-passed structured check '${check.checkId}' with status '${check.status}'`,
          path: ["structuredChecks", i, "status"]
        });
      }
      if (check.actualDigest !== void 0 && check.expectedDigest !== void 0 && normalizeSha256(check.actualDigest, false) !== normalizeSha256(check.expectedDigest, false)) {
        ctx.addIssue({
          code: external_exports.ZodIssueCode.custom,
          message: `Run with status 'passed' structured check '${check.checkId}' actualDigest '${check.actualDigest}' does not match expectedDigest '${check.expectedDigest}'`,
          path: ["structuredChecks", i, "actualDigest"]
        });
      }
    }
    if (profile.consequentialActions && profile.consequentialActions.actions) {
      for (let i = 0; i < profile.consequentialActions.actions.length; i++) {
        const action = profile.consequentialActions.actions[i];
        if (!action.authorizationEvidence || action.authorizationEvidence.trim() === "") {
          ctx.addIssue({
            code: external_exports.ZodIssueCode.custom,
            message: `Run with status 'passed' contains unauthorized consequential action '${action.actionType}' on '${action.target}' (missing authorizationEvidence)`,
            path: [
              "observedEffectProfile",
              "consequentialActions",
              "actions",
              i,
              "authorizationEvidence"
            ]
          });
        }
      }
    }
  }
});
function computeQualificationRunDigest(run, options = {}) {
  const { recordDigest: _, ...projection } = run;
  return hashCanonical({
    domain: "resin/qualification-run-record/v1",
    afterStateDigest: normalizeSha256(projection.afterStateDigest, false),
    beforeStateDigest: normalizeSha256(projection.beforeStateDigest, false),
    candidateId: projection.candidateId,
    checkDigest: normalizeSha256(projection.checkDigest, false),
    completedAt: projection.completedAt,
    costs: projection.costs,
    dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
    effectDigest: normalizeSha256(projection.effectDigest, false),
    environment: projection.environment,
    environmentDigest: normalizeSha256(projection.environmentDigest, false),
    inputDigest: normalizeSha256(projection.inputDigest, false),
    intentDigest: normalizeSha256(projection.intentDigest, false),
    logsUri: projection.logsUri,
    observedEffectProfile: projection.observedEffectProfile,
    outputDigest: normalizeSha256(projection.outputDigest, false),
    previousRecordDigest: projection.previousRecordDigest ? normalizeSha256(projection.previousRecordDigest, false) : null,
    runId: projection.runId,
    sequence: projection.sequence,
    sourceDigest: normalizeSha256(projection.sourceDigest, false),
    startedAt: projection.startedAt,
    status: projection.status,
    structuredChecks: projection.structuredChecks,
    traceDigest: normalizeSha256(projection.traceDigest, false)
  }, options);
}
var ReviewerVerdictSchema = external_exports.object({
  verdictId: IdentifierSchema,
  sequence: external_exports.number().int().nonnegative(),
  sessionId: IdentifierSchema,
  reviewerId: external_exports.string().min(1, "ReviewerId cannot be empty"),
  reviewerRole: external_exports.enum(["correctness-usefulness", "adversarial-safety"]),
  verdict: external_exports.enum(["approved", "rejected"]),
  noGeneratorHistory: external_exports.literal(true),
  sourceDigest: NormalizedSha256DigestSchema,
  dependencyDigest: NormalizedSha256DigestSchema,
  intentDigest: NormalizedSha256DigestSchema,
  rawEvidenceDigest: NormalizedSha256DigestSchema,
  findings: external_exports.array(external_exports.string()),
  comments: external_exports.string().optional(),
  previousRecordDigest: NormalizedSha256DigestSchema.nullable().optional(),
  recordDigest: NormalizedSha256DigestSchema,
  reviewedAt: ISOTimestampSchema
}).strict();
function computeReviewerVerdictDigest(verdict, options = {}) {
  const { recordDigest: _, ...projection } = verdict;
  return hashCanonical({
    domain: "resin/reviewer-verdict/v1",
    comments: projection.comments,
    dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
    findings: projection.findings,
    intentDigest: normalizeSha256(projection.intentDigest, false),
    noGeneratorHistory: projection.noGeneratorHistory,
    previousRecordDigest: projection.previousRecordDigest ? normalizeSha256(projection.previousRecordDigest, false) : null,
    rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
    reviewedAt: projection.reviewedAt,
    reviewerId: projection.reviewerId,
    reviewerRole: projection.reviewerRole,
    sequence: projection.sequence,
    sessionId: projection.sessionId,
    sourceDigest: normalizeSha256(projection.sourceDigest, false),
    verdict: projection.verdict,
    verdictId: projection.verdictId
  }, options);
}
var IndependentReplayRecordSchema = external_exports.object({
  replayId: IdentifierSchema,
  candidateId: IdentifierSchema,
  targetRunId: IdentifierSchema,
  replayEnvironment: external_exports.string().min(1, "Replay environment cannot be empty"),
  status: external_exports.enum(["passed", "failed"]),
  sourceDigest: NormalizedSha256DigestSchema,
  dependencyDigest: NormalizedSha256DigestSchema,
  intentDigest: NormalizedSha256DigestSchema,
  rawEvidenceDigest: NormalizedSha256DigestSchema,
  outputDigest: NormalizedSha256DigestSchema,
  checkDigest: NormalizedSha256DigestSchema,
  recordDigest: NormalizedSha256DigestSchema,
  durationMs: external_exports.number().nonnegative(),
  completedAt: ISOTimestampSchema
}).strict();
function computeIndependentReplayDigest(replay, options = {}) {
  const { recordDigest: _, ...projection } = replay;
  return hashCanonical({
    domain: "resin/independent-replay-record/v1",
    candidateId: projection.candidateId,
    checkDigest: normalizeSha256(projection.checkDigest, false),
    completedAt: projection.completedAt,
    dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
    durationMs: projection.durationMs,
    intentDigest: normalizeSha256(projection.intentDigest, false),
    outputDigest: normalizeSha256(projection.outputDigest, false),
    rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
    replayEnvironment: projection.replayEnvironment,
    replayId: projection.replayId,
    sourceDigest: normalizeSha256(projection.sourceDigest, false),
    status: projection.status,
    targetRunId: projection.targetRunId
  }, options);
}
var ApprovalSignatureSchema = external_exports.object({
  keyId: external_exports.string().min(1, "keyId cannot be empty"),
  algorithm: external_exports.literal("ed25519"),
  signature: external_exports.string().min(1, "signature cannot be empty"),
  signedDigest: NormalizedSha256DigestSchema
}).strict();
var ToolQualificationApprovalSchema = external_exports.object({
  approvalId: IdentifierSchema,
  approverId: external_exports.string().min(1, "approverId cannot be empty"),
  decision: external_exports.enum(["approved", "rejected"]),
  sourceDigest: NormalizedSha256DigestSchema,
  dependencyDigest: NormalizedSha256DigestSchema,
  intentDigest: NormalizedSha256DigestSchema,
  rawEvidenceDigest: NormalizedSha256DigestSchema,
  artifactBundleDigest: NormalizedSha256DigestSchema,
  approvalDigest: NormalizedSha256DigestSchema,
  signature: ApprovalSignatureSchema,
  signedAt: ISOTimestampSchema,
  comments: external_exports.string().optional()
}).strict();
function computeApprovalDigest(approval, options = {}) {
  const { approvalDigest: _, signature: __, ...projection } = approval;
  return hashCanonical({
    domain: "resin/qualification-approval/v1",
    approvalId: projection.approvalId,
    approverId: projection.approverId,
    artifactBundleDigest: normalizeSha256(projection.artifactBundleDigest, false),
    comments: projection.comments,
    decision: projection.decision,
    dependencyDigest: normalizeSha256(projection.dependencyDigest, false),
    intentDigest: normalizeSha256(projection.intentDigest, false),
    rawEvidenceDigest: normalizeSha256(projection.rawEvidenceDigest, false),
    signedAt: projection.signedAt,
    sourceDigest: normalizeSha256(projection.sourceDigest, false)
  }, options);
}
function computeApprovalSigningPayload(artifactBundleDigest, approvalDigest) {
  return canonicalJsonStringify({
    domain: "resin/qualification-approval-signature/v1",
    approvalDigest: normalizeSha256(approvalDigest, false),
    artifactBundleDigest: normalizeSha256(artifactBundleDigest, false)
  });
}
var RawBundleDescriptorSchema = external_exports.object({
  rawBundleDigest: NormalizedSha256DigestSchema,
  uri: external_exports.string().min(1).optional(),
  sizeBytes: external_exports.number().int().nonnegative().optional(),
  format: external_exports.enum(["js_bundle", "zip", "tar_gz", "embedded", "wasm", "directory"]).default("js_bundle")
}).strict();
var QualificationArtifactBundleBaseSchema = external_exports.object({
  bundleId: IdentifierSchema,
  schemaVersion: external_exports.literal(CURRENT_QUALIFICATION_VERSION),
  candidateId: IdentifierSchema,
  previousBundleDigest: NormalizedSha256DigestSchema.nullable().optional(),
  frozenIntent: FrozenToolIntentSchema,
  rawEvidenceDigest: NormalizedSha256DigestSchema,
  rawBundle: RawBundleDescriptorSchema.optional(),
  runs: external_exports.array(QualificationRunRecordSchema).min(2, "Qualification requires at least two qualification runs"),
  reviewers: external_exports.array(ReviewerVerdictSchema).min(2, "Qualification requires at least two reviewer verdicts"),
  replay: IndependentReplayRecordSchema,
  approval: ToolQualificationApprovalSchema,
  createdAt: ISOTimestampSchema,
  metadata: external_exports.record(external_exports.unknown()).optional()
}).strict();
function computeRawEvidenceDigest(bundle, options = {}) {
  return hashCanonical({
    domain: "resin/raw-evidence/v1",
    candidateId: bundle.candidateId,
    frozenIntent: bundle.frozenIntent,
    ...bundle.rawBundle ? { rawBundle: bundle.rawBundle } : {},
    runs: bundle.runs,
    schemaVersion: bundle.schemaVersion
  }, options);
}
function computeQualificationBundleDigest(bundle, options = {}) {
  const { approval: _, ...unsignedBundle } = bundle;
  return hashCanonical({
    domain: "resin/qualification-bundle/v1",
    bundleId: unsignedBundle.bundleId,
    candidateId: unsignedBundle.candidateId,
    createdAt: unsignedBundle.createdAt,
    frozenIntent: unsignedBundle.frozenIntent,
    metadata: unsignedBundle.metadata,
    previousBundleDigest: unsignedBundle.previousBundleDigest ? normalizeSha256(unsignedBundle.previousBundleDigest, false) : null,
    rawBundle: unsignedBundle.rawBundle,
    rawEvidenceDigest: normalizeSha256(unsignedBundle.rawEvidenceDigest, false),
    replay: unsignedBundle.replay,
    reviewers: unsignedBundle.reviewers,
    runs: unsignedBundle.runs,
    schemaVersion: unsignedBundle.schemaVersion
  }, options);
}
function checkQualificationBundleInvariants(bundle, options) {
  const issues = [];
  if (bundle.schemaVersion !== CURRENT_QUALIFICATION_VERSION) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Bundle schemaVersion '${bundle.schemaVersion}' does not match expected '${CURRENT_QUALIFICATION_VERSION}'`,
      path: ["schemaVersion"]
    });
  }
  if (bundle.frozenIntent.schemaVersion !== CURRENT_QUALIFICATION_VERSION) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Frozen intent schemaVersion '${bundle.frozenIntent.schemaVersion}' does not match expected '${CURRENT_QUALIFICATION_VERSION}'`,
      path: ["frozenIntent", "schemaVersion"]
    });
  }
  bundle.runs.forEach((run, index) => {
    if (run.candidateId !== bundle.candidateId) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] candidateId '${run.candidateId}' does not match bundle candidateId '${bundle.candidateId}'`,
        path: ["runs", index.toString(), "candidateId"]
      });
    }
  });
  if (bundle.replay.candidateId !== bundle.candidateId) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay candidateId '${bundle.replay.candidateId}' does not match bundle candidateId '${bundle.candidateId}'`,
      path: ["replay", "candidateId"]
    });
  }
  const computedIntentDigest = computeFrozenIntentDigest(bundle.frozenIntent);
  if (normalizeSha256(bundle.frozenIntent.intentDigest, false) !== computedIntentDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Frozen intent digest '${bundle.frozenIntent.intentDigest}' does not match computed digest '${computedIntentDigest}'`,
      path: ["frozenIntent", "intentDigest"]
    });
  }
  const expectedIntent = normalizeSha256(bundle.frozenIntent.intentDigest, false);
  const expectedSource = bundle.runs.length > 0 ? normalizeSha256(bundle.runs[0].sourceDigest, false) : "";
  const expectedDep = bundle.runs.length > 0 ? normalizeSha256(bundle.runs[0].dependencyDigest, false) : "";
  bundle.runs.forEach((run, index) => {
    if (normalizeSha256(run.sourceDigest, false) !== expectedSource) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] sourceDigest '${run.sourceDigest}' does not match expected '${expectedSource}'`,
        path: ["runs", index.toString(), "sourceDigest"]
      });
    }
    if (normalizeSha256(run.dependencyDigest, false) !== expectedDep) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] dependencyDigest '${run.dependencyDigest}' does not match expected '${expectedDep}'`,
        path: ["runs", index.toString(), "dependencyDigest"]
      });
    }
    if (normalizeSha256(run.intentDigest, false) !== expectedIntent) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Run[${index}] intentDigest '${run.intentDigest}' does not match frozen intent '${expectedIntent}'`,
        path: ["runs", index.toString(), "intentDigest"]
      });
    }
  });
  bundle.reviewers.forEach((reviewer, index) => {
    if (normalizeSha256(reviewer.sourceDigest, false) !== expectedSource) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] sourceDigest '${reviewer.sourceDigest}' does not match expected '${expectedSource}'`,
        path: ["reviewers", index.toString(), "sourceDigest"]
      });
    }
    if (normalizeSha256(reviewer.dependencyDigest, false) !== expectedDep) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] dependencyDigest '${reviewer.dependencyDigest}' does not match expected '${expectedDep}'`,
        path: ["reviewers", index.toString(), "dependencyDigest"]
      });
    }
    if (normalizeSha256(reviewer.intentDigest, false) !== expectedIntent) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
        message: `Reviewer[${index}] intentDigest '${reviewer.intentDigest}' does not match frozen intent '${expectedIntent}'`,
        path: ["reviewers", index.toString(), "intentDigest"]
      });
    }
  });
  if (normalizeSha256(bundle.replay.sourceDigest, false) !== expectedSource) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay sourceDigest '${bundle.replay.sourceDigest}' does not match expected '${expectedSource}'`,
      path: ["replay", "sourceDigest"]
    });
  }
  if (normalizeSha256(bundle.replay.dependencyDigest, false) !== expectedDep) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay dependencyDigest '${bundle.replay.dependencyDigest}' does not match expected '${expectedDep}'`,
      path: ["replay", "dependencyDigest"]
    });
  }
  if (normalizeSha256(bundle.replay.intentDigest, false) !== expectedIntent) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Replay intentDigest '${bundle.replay.intentDigest}' does not match frozen intent '${expectedIntent}'`,
      path: ["replay", "intentDigest"]
    });
  }
  if (normalizeSha256(bundle.approval.sourceDigest, false) !== expectedSource) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval sourceDigest '${bundle.approval.sourceDigest}' does not match expected '${expectedSource}'`,
      path: ["approval", "sourceDigest"]
    });
  }
  if (normalizeSha256(bundle.approval.dependencyDigest, false) !== expectedDep) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval dependencyDigest '${bundle.approval.dependencyDigest}' does not match expected '${expectedDep}'`,
      path: ["approval", "dependencyDigest"]
    });
  }
  if (normalizeSha256(bundle.approval.intentDigest, false) !== expectedIntent) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MIXED_REVISIONS,
      message: `Approval intentDigest '${bundle.approval.intentDigest}' does not match frozen intent '${expectedIntent}'`,
      path: ["approval", "intentDigest"]
    });
  }
  const computedRawEvidenceDigest = computeRawEvidenceDigest(bundle);
  const expectedRawEvidence = normalizeSha256(bundle.rawEvidenceDigest, false);
  if (expectedRawEvidence !== computedRawEvidenceDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Bundle rawEvidenceDigest '${expectedRawEvidence}' does not match computed raw evidence digest '${computedRawEvidenceDigest}'`,
      path: ["rawEvidenceDigest"]
    });
  }
  bundle.reviewers.forEach((reviewer, index) => {
    if (normalizeSha256(reviewer.rawEvidenceDigest, false) !== expectedRawEvidence) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] rawEvidenceDigest '${reviewer.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
        path: ["reviewers", index.toString(), "rawEvidenceDigest"]
      });
    }
  });
  if (normalizeSha256(bundle.replay.rawEvidenceDigest, false) !== expectedRawEvidence) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay rawEvidenceDigest '${bundle.replay.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
      path: ["replay", "rawEvidenceDigest"]
    });
  }
  if (normalizeSha256(bundle.approval.rawEvidenceDigest, false) !== expectedRawEvidence) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Approval rawEvidenceDigest '${bundle.approval.rawEvidenceDigest}' does not match expected '${expectedRawEvidence}'`,
      path: ["approval", "rawEvidenceDigest"]
    });
  }
  const seenRunIds = /* @__PURE__ */ new Set();
  bundle.runs.forEach((run, index) => {
    if (seenRunIds.has(run.runId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Duplicate runId '${run.runId}' found at index ${index}`,
        path: ["runs", index.toString(), "runId"]
      });
    }
    seenRunIds.add(run.runId);
    if (run.sequence !== index) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] sequence '${run.sequence}' must be '${index}'`,
        path: ["runs", index.toString(), "sequence"]
      });
    }
    const computedRunDigest = computeQualificationRunDigest(run);
    if (normalizeSha256(run.recordDigest, false) !== computedRunDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] recordDigest '${run.recordDigest}' does not match computed digest '${computedRunDigest}'`,
        path: ["runs", index.toString(), "recordDigest"]
      });
    }
    const expectedPrevDigest = index === 0 ? null : normalizeSha256(bundle.runs[index - 1].recordDigest, false);
    const actualPrevDigest = run.previousRecordDigest ? normalizeSha256(run.previousRecordDigest, false) : null;
    if (actualPrevDigest !== expectedPrevDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] previousRecordDigest '${actualPrevDigest}' does not match prior run digest '${expectedPrevDigest}'`,
        path: ["runs", index.toString(), "previousRecordDigest"]
      });
    }
    const computedProfileDigest = computeObservedEffectProfileDigest(run.observedEffectProfile);
    if (run.observedEffectProfile.profileDigest) {
      if (normalizeSha256(run.observedEffectProfile.profileDigest, false) !== computedProfileDigest) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] observedEffectProfile.profileDigest '${run.observedEffectProfile.profileDigest}' does not match computed digest '${computedProfileDigest}'`,
          path: ["runs", index.toString(), "observedEffectProfile", "profileDigest"]
        });
      }
    }
    const expectedEffectDigest = run.observedEffectProfile.profileDigest ? normalizeSha256(run.observedEffectProfile.profileDigest, false) : computedProfileDigest;
    if (normalizeSha256(run.effectDigest, false) !== expectedEffectDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Run[${index}] effectDigest '${run.effectDigest}' does not match observedEffectProfile.profileDigest '${run.observedEffectProfile.profileDigest ?? computedProfileDigest}'`,
        path: ["runs", index.toString(), "effectDigest"]
      });
    }
    if (run.status === "passed") {
      const axes = [
        "filesRead",
        "filesCreated",
        "filesModified",
        "filesDeleted",
        "processTree",
        "network",
        "environmentVariables",
        "credentials",
        "dependencyChanges",
        "artifacts",
        "validationChecks",
        "resourceEnvelope",
        "consequentialActions"
      ];
      for (const axis of axes) {
        const section = run.observedEffectProfile[axis];
        if (section && section.observation !== "complete") {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] has status 'passed' but observedEffectProfile axis '${axis}' observation is '${section.observation}' (must be 'complete')`,
            path: ["runs", index.toString(), "observedEffectProfile", axis, "observation"]
          });
        }
      }
      if (run.observedEffectProfile.validationChecks && run.observedEffectProfile.validationChecks.checks) {
        run.observedEffectProfile.validationChecks.checks.forEach((check, checkIdx) => {
          if (!check.passed) {
            issues.push({
              code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
              message: `Run[${index}] has status 'passed' but validationCheck[${checkIdx}] '${check.checkId}' has passed=false`,
              path: [
                "runs",
                index.toString(),
                "observedEffectProfile",
                "validationChecks",
                "checks",
                checkIdx.toString(),
                "passed"
              ]
            });
          }
        });
      }
      if (run.costs.modelUsageObservation === "unknown") {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] has status 'passed' but costs.modelUsageObservation is 'unknown'`,
          path: ["runs", index.toString(), "costs", "modelUsageObservation"]
        });
      }
      if (run.structuredChecks.length === 0) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
          message: `Run[${index}] has status 'passed' but contains no structured checks`,
          path: ["runs", index.toString(), "structuredChecks"]
        });
      }
      run.structuredChecks.forEach((check, checkIdx) => {
        if (check.status !== "passed") {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] has status 'passed' but structuredCheck[${checkIdx}] '${check.checkId}' has status '${check.status}'`,
            path: ["runs", index.toString(), "structuredChecks", checkIdx.toString(), "status"]
          });
        }
        if (check.actualDigest !== void 0 && check.expectedDigest !== void 0 && normalizeSha256(check.actualDigest, false) !== normalizeSha256(check.expectedDigest, false)) {
          issues.push({
            code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
            message: `Run[${index}] structuredCheck[${checkIdx}] '${check.checkId}' actualDigest '${check.actualDigest}' does not match expectedDigest '${check.expectedDigest}'`,
            path: [
              "runs",
              index.toString(),
              "structuredChecks",
              checkIdx.toString(),
              "actualDigest"
            ]
          });
        }
      });
      if (run.observedEffectProfile.consequentialActions && run.observedEffectProfile.consequentialActions.actions) {
        run.observedEffectProfile.consequentialActions.actions.forEach((action, actionIdx) => {
          if (!action.authorizationEvidence || action.authorizationEvidence.trim() === "") {
            issues.push({
              code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
              message: `Run[${index}] has status 'passed' but contains unauthorized consequential action '${action.actionType}' on '${action.target}' (missing authorizationEvidence)`,
              path: [
                "runs",
                index.toString(),
                "observedEffectProfile",
                "consequentialActions",
                "actions",
                actionIdx.toString(),
                "authorizationEvidence"
              ]
            });
          }
        });
      }
    }
  });
  const passedRuns = bundle.runs.filter((r) => r.status === "passed");
  if (passedRuns.length < 2) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
      message: `Qualification requires at least 2 passed runs, found ${passedRuns.length}`,
      path: ["runs"]
    });
  }
  const distinctEnvs = new Set(passedRuns.map((r) => r.environment));
  if (distinctEnvs.size < 2) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
      message: `Qualification requires at least 2 distinct passed environments, found ${distinctEnvs.size} (${Array.from(distinctEnvs).join(", ")})`,
      path: ["runs"]
    });
  }
  const seenVerdictIds = /* @__PURE__ */ new Set();
  const seenSessionIds = /* @__PURE__ */ new Set();
  const creatorId = bundle.frozenIntent.createdBy;
  bundle.reviewers.forEach((reviewer, index) => {
    if (seenVerdictIds.has(reviewer.verdictId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Duplicate verdictId '${reviewer.verdictId}' found at index ${index}`,
        path: ["reviewers", index.toString(), "verdictId"]
      });
    }
    seenVerdictIds.add(reviewer.verdictId);
    if (seenSessionIds.has(reviewer.sessionId)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer sessionId '${reviewer.sessionId}' is reused at index ${index}; reviewer sessions must be globally unique`,
        path: ["reviewers", index.toString(), "sessionId"]
      });
    }
    seenSessionIds.add(reviewer.sessionId);
    if (reviewer.sequence !== index) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] sequence '${reviewer.sequence}' must be '${index}'`,
        path: ["reviewers", index.toString(), "sequence"]
      });
    }
    const computedVerdictDigest = computeReviewerVerdictDigest(reviewer);
    if (normalizeSha256(reviewer.recordDigest, false) !== computedVerdictDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] recordDigest '${reviewer.recordDigest}' does not match computed digest '${computedVerdictDigest}'`,
        path: ["reviewers", index.toString(), "recordDigest"]
      });
    }
    const expectedPrevDigest = index === 0 ? null : normalizeSha256(bundle.reviewers[index - 1].recordDigest, false);
    const actualPrevDigest = reviewer.previousRecordDigest ? normalizeSha256(reviewer.previousRecordDigest, false) : null;
    if (actualPrevDigest !== expectedPrevDigest) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
        message: `Reviewer[${index}] previousRecordDigest '${actualPrevDigest}' does not match prior reviewer digest '${expectedPrevDigest}'`,
        path: ["reviewers", index.toString(), "previousRecordDigest"]
      });
    }
    if (reviewer.reviewerId === creatorId) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer[${index}] reviewerId '${reviewer.reviewerId}' cannot equal frozenIntent createdBy '${creatorId}'`,
        path: ["reviewers", index.toString(), "reviewerId"]
      });
    }
    if (reviewer.noGeneratorHistory !== true) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer[${index}] must explicitly declare noGeneratorHistory: true`,
        path: ["reviewers", index.toString(), "noGeneratorHistory"]
      });
    }
  });
  const correctnessReviews = bundle.reviewers.filter((r) => r.reviewerRole === "correctness-usefulness");
  if (correctnessReviews.length === 0) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS,
      message: "Qualification requires at least one correctness-usefulness reviewer verdict",
      path: ["reviewers"]
    });
  } else {
    const passedCorrectness = correctnessReviews.some((r) => r.verdict === "approved");
    if (!passedCorrectness) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED,
        message: "correctness-usefulness reviewer verdict must be approved",
        path: ["reviewers"]
      });
    }
  }
  const adversarialReviews = bundle.reviewers.filter((r) => r.reviewerRole === "adversarial-safety");
  if (adversarialReviews.length === 0) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.MISSING_REVIEWERS,
      message: "Qualification requires at least one adversarial-safety reviewer verdict",
      path: ["reviewers"]
    });
  } else {
    const passedAdversarial = adversarialReviews.some((r) => r.verdict === "approved");
    if (!passedAdversarial) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REVIEWER_VERDICT_FAILED,
        message: "adversarial-safety reviewer verdict must be approved",
        path: ["reviewers"]
      });
    }
  }
  if (correctnessReviews.length > 0 && adversarialReviews.length > 0) {
    const correctnessReviewerIds = new Set(correctnessReviews.map((r) => r.reviewerId));
    const adversarialReviewerIds = new Set(adversarialReviews.map((r) => r.reviewerId));
    const reviewerIntersection = [...correctnessReviewerIds].filter((id) => adversarialReviewerIds.has(id));
    if (reviewerIntersection.length > 0) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer identity '${reviewerIntersection.join(", ")}' cannot serve as both correctness-usefulness and adversarial-safety reviewer`,
        path: ["reviewers"]
      });
    }
    const correctnessSessionIds = new Set(correctnessReviews.map((r) => r.sessionId));
    const adversarialSessionIds = new Set(adversarialReviews.map((r) => r.sessionId));
    const sessionIntersection = [...correctnessSessionIds].filter((id) => adversarialSessionIds.has(id));
    if (sessionIntersection.length > 0) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.HISTORY_LEAKAGE,
        message: `Reviewer session '${sessionIntersection.join(", ")}' cannot be reused across correctness-usefulness and adversarial-safety reviewer roles`,
        path: ["reviewers"]
      });
    }
  }
  const computedReplayDigest = computeIndependentReplayDigest(bundle.replay);
  if (normalizeSha256(bundle.replay.recordDigest, false) !== computedReplayDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.BUNDLE_MISMATCH,
      message: `Replay recordDigest '${bundle.replay.recordDigest}' does not match computed digest '${computedReplayDigest}'`,
      path: ["replay", "recordDigest"]
    });
  }
  if (bundle.replay.status !== "passed") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
      message: `Independent replay status must be 'passed', found '${bundle.replay.status}'`,
      path: ["replay", "status"]
    });
  }
  const targetRun = bundle.runs.find((r) => r.runId === bundle.replay.targetRunId);
  if (!targetRun) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
      message: `Independent replay targetRunId '${bundle.replay.targetRunId}' not found in bundle runs`,
      path: ["replay", "targetRunId"]
    });
  } else {
    if (targetRun.status !== "passed") {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay target run '${targetRun.runId}' did not pass (status: '${targetRun.status}')`,
        path: ["replay", "targetRunId"]
      });
    }
    if (bundle.replay.replayEnvironment === targetRun.environment) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.INSUFFICIENT_ENVIRONMENTS,
        message: `Independent replay environment '${bundle.replay.replayEnvironment}' must be fresh and distinct from target run environment '${targetRun.environment}'`,
        path: ["replay", "replayEnvironment"]
      });
    }
    if (normalizeSha256(bundle.replay.outputDigest, false) !== normalizeSha256(targetRun.outputDigest, false)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay output digest '${bundle.replay.outputDigest}' does not match target run output digest '${targetRun.outputDigest}'`,
        path: ["replay", "outputDigest"]
      });
    }
    if (normalizeSha256(bundle.replay.checkDigest, false) !== normalizeSha256(targetRun.checkDigest, false)) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Independent replay check digest '${bundle.replay.checkDigest}' does not match target run check digest '${targetRun.checkDigest}'`,
        path: ["replay", "checkDigest"]
      });
    }
  }
  if (bundle.approval.decision !== "approved") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval decision must be 'approved', found '${bundle.approval.decision}'`,
      path: ["approval", "decision"]
    });
  } else {
    bundle.runs.forEach((run, index) => {
      if (run.status !== "passed") {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
          message: `Bundle approval decision is 'approved' but run[${index}] has status '${run.status}' (failed/incomplete runs cannot be approved)`,
          path: ["approval", "decision"]
        });
      }
    });
    if (bundle.replay.status !== "passed") {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.REPLAY_MISMATCH,
        message: `Bundle approval decision is 'approved' but replay status is '${bundle.replay.status}'`,
        path: ["replay", "status"]
      });
    }
  }
  const computedArtifactBundleDigest = computeQualificationBundleDigest(bundle);
  if (normalizeSha256(bundle.approval.artifactBundleDigest, false) !== computedArtifactBundleDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval artifactBundleDigest '${bundle.approval.artifactBundleDigest}' does not match computed bundle digest '${computedArtifactBundleDigest}'`,
      path: ["approval", "artifactBundleDigest"]
    });
  }
  const computedApprovalDigest = computeApprovalDigest(bundle.approval);
  if (normalizeSha256(bundle.approval.approvalDigest, false) !== computedApprovalDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval approvalDigest '${bundle.approval.approvalDigest}' does not match computed approval digest '${computedApprovalDigest}'`,
      path: ["approval", "approvalDigest"]
    });
  }
  const normalizedSignedDigest = normalizeSha256(bundle.approval.signature.signedDigest, false);
  if (normalizedSignedDigest !== computedArtifactBundleDigest && normalizedSignedDigest !== computedApprovalDigest) {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.APPROVAL_MISMATCH,
      message: `Approval signature signedDigest '${bundle.approval.signature.signedDigest}' must bind to artifactBundleDigest '${computedArtifactBundleDigest}' or approvalDigest '${computedApprovalDigest}'`,
      path: ["approval", "signature", "signedDigest"]
    });
  }
  if (bundle.approval.signature.algorithm !== "ed25519") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: `Unsupported signature algorithm '${bundle.approval.signature.algorithm}', only 'ed25519' is supported`,
      path: ["approval", "signature", "algorithm"]
    });
  }
  if (!bundle.approval.signature.signature || bundle.approval.signature.signature.trim() === "") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: "Approval signature is empty or whitespace",
      path: ["approval", "signature", "signature"]
    });
  }
  if (!bundle.approval.signature.keyId || bundle.approval.signature.keyId.trim() === "") {
    issues.push({
      code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
      message: "Approval keyId is empty or whitespace",
      path: ["approval", "signature", "keyId"]
    });
  }
  if (options?.verifier) {
    try {
      const signingPayload = computeApprovalSigningPayload(computedArtifactBundleDigest, computedApprovalDigest);
      const isSigValid = options.verifier({
        keyId: bundle.approval.signature.keyId,
        algorithm: bundle.approval.signature.algorithm,
        signature: bundle.approval.signature.signature,
        payload: signingPayload,
        signedDigest: normalizedSignedDigest
      });
      if (!isSigValid) {
        issues.push({
          code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
          message: "Cryptographic signature verification failed for approval",
          path: ["approval", "signature"]
        });
      }
    } catch (err) {
      issues.push({
        code: QUALIFICATION_ERROR_CODES.INVALID_SIGNATURE,
        message: `Signature verification threw an error: ${err instanceof Error ? err.message : String(err)}`,
        path: ["approval", "signature"]
      });
    }
  }
  return issues;
}
var QualificationArtifactBundleSchema = QualificationArtifactBundleBaseSchema.superRefine((data, ctx) => {
  const issues = checkQualificationBundleInvariants(data);
  for (const issue of issues) {
    ctx.addIssue({
      code: external_exports.ZodIssueCode.custom,
      message: `[${issue.code}] ${issue.message}`,
      params: { code: issue.code },
      path: issue.path ?? []
    });
  }
});

// packages/contracts/dist/candidates.js
var CandidateStateSchema = external_exports.enum([
  "detected",
  "synthesizing",
  "synthesized",
  "evaluating",
  "evaluated",
  "approved",
  "rejected",
  "superseded",
  "failed"
]);
var CandidateTriggerReasonSchema = external_exports.enum([
  "repeated_pattern",
  "latency_bottleneck",
  "failure_recovery",
  "missing_abstraction",
  "manual_request"
]);
var CandidateTriggerSchema = external_exports.object({
  reason: CandidateTriggerReasonSchema,
  evidenceEventIds: external_exports.array(IdentifierSchema).min(1),
  sessionOccurrences: external_exports.number().int().positive().default(1),
  detectedAt: ISOTimestampSchema,
  patternFrequency: external_exports.number().nonnegative().default(1),
  estimatedLatencySavingsMs: external_exports.number().nonnegative().optional(),
  estimatedTokenSavings: external_exports.number().nonnegative().optional()
});
var CandidateEvaluationSummarySchema = external_exports.object({
  benchmarkScore: external_exports.number().min(0).max(1),
  replaySuccessRate: external_exports.number().min(0).max(1),
  latencyImprovementPercent: external_exports.number(),
  tokenSavingsPercent: external_exports.number(),
  securityVerdict: external_exports.enum(["passed", "failed", "requires_review"]),
  evaluatorVersion: SchemaVersionSchema,
  evaluatedAt: ISOTimestampSchema
});
var EvolutionCandidateSchema = external_exports.object({
  id: IdentifierSchema,
  opportunityId: IdentifierSchema.optional(),
  workspaceId: IdentifierSchema,
  state: CandidateStateSchema,
  trigger: CandidateTriggerSchema,
  proposedTool: ToolManifestSchema,
  requiredCapabilities: CapabilityManifestSchema,
  evaluationSummary: CandidateEvaluationSummarySchema.optional(),
  sourceCode: external_exports.string().optional(),
  rejectionReason: external_exports.string().optional(),
  frozenIntent: FrozenToolIntentSchema.optional(),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
});

// packages/contracts/dist/versions.js
var BundleReferenceSchema = external_exports.object({
  uri: external_exports.string().min(1),
  hash: Sha256DigestSchema,
  sizeBytes: external_exports.number().int().nonnegative(),
  format: external_exports.enum(["js_bundle", "zip", "tar_gz", "embedded", "wasm"])
});
var ToolArtifactSchema = external_exports.object({
  artifactDigest: Sha256DigestSchema,
  bundleReference: BundleReferenceSchema,
  entrypoint: external_exports.string().min(1),
  sourceCode: external_exports.string().optional(),
  sourceMap: external_exports.string().optional(),
  checksums: external_exports.record(external_exports.string()).default({})
});
var ProvenanceMetadataSchema = external_exports.object({
  sourceCandidateId: IdentifierSchema.optional(),
  synthesizedAt: ISOTimestampSchema,
  synthesizerModel: external_exports.string().min(1),
  promptHash: Sha256DigestSchema.optional(),
  gitCommitSha: external_exports.string().optional(),
  deterministicBuildHash: Sha256DigestSchema,
  environment: external_exports.record(external_exports.string()).default({})
});
var SignatureMetadataSchema = external_exports.object({
  signature: external_exports.string().min(1),
  keyId: external_exports.string().min(1),
  algorithm: external_exports.enum(["ed25519", "ecdsa_p256_sha256", "rsa_pss_sha256"]),
  signedAt: ISOTimestampSchema,
  certificateChain: external_exports.array(external_exports.string()).optional()
});
var ToolVersionStatusSchema = external_exports.enum(["draft", "active", "deprecated", "revoked"]);
var ToolVersionSchema = external_exports.object({
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  manifestDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  manifest: ToolManifestSchema,
  artifact: ToolArtifactSchema,
  provenance: ProvenanceMetadataSchema,
  signature: SignatureMetadataSchema.optional(),
  status: ToolVersionStatusSchema.default("draft"),
  supersededBy: SchemaVersionSchema.nullable().optional(),
  createdAt: ISOTimestampSchema,
  createdBy: external_exports.string().min(1)
});

// packages/contracts/dist/deployments.js
var DeploymentStateSchema = external_exports.enum([
  "drafted",
  "validating",
  "rejected",
  "replaying",
  "eligible",
  "canary",
  "promoted",
  "suspended",
  "rolling_back",
  "rolled_back",
  "retired"
]);
var DeploymentTransitionReasonSchema = external_exports.enum([
  "initial_draft",
  "validation_started",
  "validation_passed",
  "validation_failed",
  "replay_started",
  "replay_passed",
  "replay_failed",
  "marked_eligible",
  "canary_started",
  "canary_passed",
  "canary_failed",
  "manual_promotion",
  "auto_promotion",
  "manual_suspension",
  "health_check_failed",
  "manual_rollback",
  "automated_rollback",
  "rollback_completed",
  "retired_by_superseded",
  "manual_retirement"
]);
var DeploymentTransitionSchema = external_exports.object({
  fromState: DeploymentStateSchema,
  toState: DeploymentStateSchema,
  timestamp: ISOTimestampSchema,
  reason: DeploymentTransitionReasonSchema,
  actor: external_exports.object({
    type: external_exports.enum(["daemon", "user", "policy_engine", "gateway", "system"]),
    id: external_exports.string().min(1)
  }),
  message: external_exports.string().optional(),
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var AutoRollbackThresholdsSchema = external_exports.object({
  maxErrorRate: external_exports.number().min(0).max(1).default(0.05),
  maxLatencyP95Ms: external_exports.number().positive().default(5e3),
  maxSchemaMismatchRate: external_exports.number().min(0).max(1).default(0.01),
  consecutiveFailureThreshold: external_exports.number().int().positive().default(3)
});
var CanaryConfigSchema = external_exports.object({
  strategy: external_exports.enum(["shadow", "traffic_split", "developer_opt_in"]).default("shadow"),
  trafficPercentage: external_exports.number().min(0).max(100).default(0),
  durationMinutes: external_exports.number().int().positive().default(30),
  maxShadowWorkers: external_exports.number().int().min(1).max(8).default(2),
  autoRollbackThresholds: AutoRollbackThresholdsSchema.default({})
});
var DeploymentRecordSchema = external_exports.object({
  deploymentId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  state: DeploymentStateSchema,
  canaryConfig: CanaryConfigSchema.optional(),
  history: external_exports.array(DeploymentTransitionSchema).default([]),
  activeTrafficPercentage: external_exports.number().min(0).max(100).default(0),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
});

// packages/contracts/dist/evaluation.js
var EvaluationDimensionNameSchema = external_exports.enum([
  "test",
  "replay",
  "security",
  "quality",
  "latency",
  "reliability",
  "token_savings"
]);
var EvaluationDimensionSchema = external_exports.object({
  name: EvaluationDimensionNameSchema,
  weight: external_exports.number().min(0).max(1).default(1),
  score: external_exports.number().min(0).max(1),
  threshold: external_exports.number().min(0).max(1),
  passed: external_exports.boolean(),
  metrics: external_exports.record(external_exports.union([external_exports.number(), external_exports.string(), external_exports.boolean()])).default({}),
  details: external_exports.string().optional()
});
var EvaluationVerdictSchema = external_exports.enum(["pass", "fail", "conditional"]);
var EvaluationDecisionSchema = external_exports.object({
  verdict: EvaluationVerdictSchema,
  score: external_exports.number().min(0).max(1),
  confidence: external_exports.number().min(0).max(1),
  threshold: external_exports.number().min(0).max(1),
  notes: external_exports.string().optional(),
  evaluatedBy: external_exports.string().min(1),
  evaluatedAt: ISOTimestampSchema
});
var EvaluationResultSchema = external_exports.object({
  evaluationId: IdentifierSchema,
  candidateId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  overallDecision: EvaluationDecisionSchema,
  dimensions: external_exports.array(EvaluationDimensionSchema),
  replayTestCount: external_exports.number().int().nonnegative().default(0),
  replaySuccessCount: external_exports.number().int().nonnegative().default(0),
  securityChecklist: external_exports.record(external_exports.boolean()).default({}),
  completedAt: ISOTimestampSchema,
  durationMs: external_exports.number().nonnegative()
});

// packages/contracts/dist/records.js
var WorkspaceRecordSchema = external_exports.object({
  workspaceId: IdentifierSchema,
  rootPath: external_exports.string().min(1),
  name: external_exports.string().min(1),
  config: external_exports.record(external_exports.unknown()).default({}),
  capabilityEnvelope: CapabilityEnvelopeSchema,
  activeTools: external_exports.record(SchemaVersionSchema).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
});
var DeviceRecordSchema = external_exports.object({
  deviceId: IdentifierSchema,
  hostname: external_exports.string().min(1),
  platform: external_exports.enum(["darwin", "linux", "win32", "other"]),
  arch: external_exports.enum(["arm64", "x64", "arm", "ia32", "other"]),
  osVersion: external_exports.string(),
  cpuCores: external_exports.number().int().positive(),
  totalMemoryMb: external_exports.number().int().positive(),
  daemonVersion: SchemaVersionSchema,
  registeredAt: ISOTimestampSchema,
  lastSeenAt: ISOTimestampSchema
});
var InstallationRecordSchema = external_exports.object({
  installationId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  deploymentId: IdentifierSchema,
  installedAt: ISOTimestampSchema,
  state: external_exports.enum(["active", "inactive", "broken", "uninstalled"]),
  configOverrides: external_exports.record(external_exports.unknown()).default({})
});
var CatalogToolSummarySchema = external_exports.object({
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  manifestDigest: Sha256DigestSchema,
  scope: ToolScopeSchema,
  status: external_exports.enum(["active", "draft", "deprecated", "revoked"])
});
var CatalogSnapshotSchema = external_exports.object({
  snapshotId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  tools: external_exports.record(CatalogToolSummarySchema).default({}),
  digest: Sha256DigestSchema
});
var InvocationResourceUsageSchema = external_exports.object({
  cpuTimeMs: external_exports.number().nonnegative(),
  memoryBytes: external_exports.number().int().nonnegative(),
  shadowRun: external_exports.boolean().default(false)
});
var InvocationErrorDetailsSchema = external_exports.object({
  errorType: external_exports.string().min(1),
  message: external_exports.string(),
  stack: external_exports.string().optional()
});
var InvocationRecordSchema = external_exports.object({
  invocationId: IdentifierSchema,
  sessionId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  toolId: IdentifierSchema,
  toolVersion: SchemaVersionSchema,
  startedAt: ISOTimestampSchema,
  completedAt: ISOTimestampSchema,
  durationMs: external_exports.number().nonnegative(),
  status: external_exports.enum(["success", "error", "timeout", "rejected_capability"]),
  inputDigest: Sha256DigestSchema,
  outputDigest: Sha256DigestSchema.optional(),
  errorDetails: InvocationErrorDetailsSchema.optional(),
  resourceUsage: InvocationResourceUsageSchema.optional()
});
var AuditActorSchema = external_exports.object({
  type: external_exports.enum(["user", "daemon", "agent", "system", "policy_engine"]),
  id: external_exports.string().min(1)
});
var AuditRecordSchema = external_exports.object({
  auditId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  eventType: external_exports.string().min(1),
  actor: AuditActorSchema,
  workspaceId: IdentifierSchema.optional(),
  resourceType: external_exports.enum([
    "tool",
    "deployment",
    "candidate",
    "workspace",
    "capability",
    "session",
    "device",
    "config"
  ]),
  resourceId: external_exports.string().min(1),
  action: external_exports.string().min(1),
  status: external_exports.enum(["success", "failure", "denied"]),
  details: external_exports.record(external_exports.unknown()).default({}),
  clientIp: external_exports.string().optional()
});
var TelemetryRecordSchema = external_exports.object({
  telemetryId: IdentifierSchema,
  timestamp: ISOTimestampSchema,
  deviceId: IdentifierSchema,
  workspaceId: IdentifierSchema.optional(),
  metricName: external_exports.string().min(1),
  metricType: external_exports.enum(["counter", "gauge", "histogram"]),
  value: external_exports.number(),
  tags: external_exports.record(external_exports.string()).default({})
});
var SyncCursorSchema = external_exports.object({
  cursorId: IdentifierSchema,
  deviceId: IdentifierSchema,
  workspaceId: IdentifierSchema.optional(),
  entityType: external_exports.string().min(1),
  lastSyncedSequence: external_exports.number().int().nonnegative(),
  lastSyncedTimestamp: ISOTimestampSchema,
  syncToken: external_exports.string().min(1)
});
var DeadLetterRecordSchema = external_exports.object({
  deadLetterId: IdentifierSchema,
  originalEventType: external_exports.string().min(1),
  payload: external_exports.record(external_exports.unknown()),
  errorReason: external_exports.string().min(1),
  failedAt: ISOTimestampSchema,
  retryCount: external_exports.number().int().nonnegative().default(0),
  nextRetryAt: ISOTimestampSchema.optional(),
  status: external_exports.enum(["pending", "exhausted", "resolved", "discarded"]).default("pending")
});
var VerificationDigestsSchema = external_exports.object({
  sourceDigest: Sha256DigestSchema,
  manifestDigest: Sha256DigestSchema,
  testsDigest: Sha256DigestSchema,
  sdkDigest: Sha256DigestSchema,
  runtimeDigest: Sha256DigestSchema,
  policyDigest: Sha256DigestSchema,
  denoDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  compositeEvidenceDigest: Sha256DigestSchema
});
var VerificationChecksSchema = external_exports.object({
  compilationAndTypeCheck: external_exports.boolean(),
  staticAnalysis: external_exports.boolean(),
  schemaValidation: external_exports.boolean(),
  unitTests: external_exports.boolean(),
  securityProbes: external_exports.boolean(),
  deterministicPackaging: external_exports.boolean()
});
var ProbeResultEntrySchema = external_exports.object({
  probeId: external_exports.string().min(1),
  name: external_exports.string().min(1),
  passed: external_exports.boolean(),
  details: external_exports.string().optional()
});
var VerificationEvidenceRecordSchema = external_exports.object({
  evidenceId: IdentifierSchema,
  toolId: IdentifierSchema,
  version: SchemaVersionSchema,
  status: external_exports.enum(["passed", "failed"]),
  verifiedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  digests: VerificationDigestsSchema,
  checks: VerificationChecksSchema,
  probeResults: external_exports.array(ProbeResultEntrySchema).default([]),
  metadata: external_exports.record(external_exports.unknown()).optional(),
  signature: SignatureMetadataSchema.optional()
});
var RecordVisibilitySchema = external_exports.enum(["personal", "workspace"]);
var PersonalOwnershipRecordSchema = external_exports.object({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]),
  visibility: external_exports.literal("personal")
});
var WorkspaceOwnershipRecordSchema = external_exports.object({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: external_exports.literal("workspace")
});
var RecordOwnershipSchema = external_exports.discriminatedUnion("visibility", [
  PersonalOwnershipRecordSchema,
  WorkspaceOwnershipRecordSchema
]);
var SessionRecordBaseSchema = external_exports.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  harnessType: external_exports.string().min(1).default("default"),
  status: external_exports.enum(["active", "idle", "completed", "failed", "archived", "terminated"]).default("active"),
  fidelity: external_exports.enum(["full", "compact", "summary", "lossless"]).default("full"),
  startedAt: ISOTimestampSchema,
  endedAt: ISOTimestampSchema.nullable().optional(),
  cursor: external_exports.string().nullable().optional(),
  eventCount: external_exports.number().int().nonnegative().default(0),
  summaryByKind: external_exports.record(external_exports.number().int().nonnegative()).default({}),
  metadata: external_exports.record(external_exports.unknown()).default({}),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema
});
var PersonalSessionRecordSchema = SessionRecordBaseSchema.extend({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]),
  visibility: external_exports.literal("personal")
});
var WorkspaceSessionRecordSchema = SessionRecordBaseSchema.extend({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: external_exports.literal("workspace")
});
var SessionRecordSchema = external_exports.discriminatedUnion("visibility", [
  PersonalSessionRecordSchema,
  WorkspaceSessionRecordSchema
]);
var EvidenceSetRecordBaseSchema = external_exports.object({
  id: IdentifierSchema,
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable().optional(),
  name: external_exports.string().min(1),
  description: external_exports.string().default(""),
  revision: external_exports.number().int().positive().default(1),
  rootDigest: Sha256DigestSchema,
  memberCount: external_exports.number().int().nonnegative().default(0),
  metadata: external_exports.record(external_exports.unknown()).default({}),
  createdAt: ISOTimestampSchema
});
var PersonalEvidenceSetRecordSchema = EvidenceSetRecordBaseSchema.extend({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]),
  visibility: external_exports.literal("personal")
});
var WorkspaceEvidenceSetRecordSchema = EvidenceSetRecordBaseSchema.extend({
  ownerUserId: external_exports.union([UUIDSchema, IdentifierSchema]).nullable().optional(),
  visibility: external_exports.literal("workspace")
});
var EvidenceSetRecordSchema = external_exports.discriminatedUnion("visibility", [
  PersonalEvidenceSetRecordSchema,
  WorkspaceEvidenceSetRecordSchema
]);

// packages/contracts/dist/safety-gate.js
var CURRENT_SAFETY_GATE_VERSION = "1.0.0";
var SafetyAttestationRecordSchema = external_exports.object({
  attestationId: IdentifierSchema,
  schemaVersion: SchemaVersionSchema.default(CURRENT_SAFETY_GATE_VERSION),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  environment: external_exports.enum(["production", "staging", "development", "test"]).default("production"),
  compatibility: external_exports.object({
    runtimeVersion: SchemaVersionSchema,
    brokerProtocolVersion: SchemaVersionSchema,
    bundleVerifierVersion: SchemaVersionSchema,
    policyVersion: SchemaVersionSchema
  }),
  checks: external_exports.record(external_exports.boolean()),
  metadata: external_exports.record(external_exports.unknown()).optional(),
  signature: SignatureMetadataSchema.optional()
});
var UnmetRequirementSchema = external_exports.object({
  code: external_exports.string().min(1),
  message: external_exports.string().min(1),
  remediation: external_exports.string().min(1)
});
var ProductionSafetyGateStatusSchema = external_exports.object({
  isOpen: external_exports.boolean(),
  status: external_exports.enum(["passed", "failed", "unsafe_override", "uninitialized"]),
  evaluatedAt: ISOTimestampSchema,
  versions: external_exports.object({
    runtimeVersion: SchemaVersionSchema,
    brokerProtocolVersion: SchemaVersionSchema,
    bundleVerifierVersion: SchemaVersionSchema,
    policyVersion: SchemaVersionSchema
  }),
  reasons: external_exports.array(external_exports.string()),
  unmetRequirements: external_exports.array(UnmetRequirementSchema),
  attestation: SafetyAttestationRecordSchema.optional(),
  unsafeOverrideActive: external_exports.boolean().default(false)
});
var SafetyGateRefusalSchema = external_exports.object({
  isError: external_exports.literal(true),
  refusalCode: external_exports.string().min(1),
  refusalReason: external_exports.string().min(1),
  remediation: external_exports.string().min(1),
  unmetGates: external_exports.array(external_exports.string()),
  evaluatedAt: ISOTimestampSchema,
  content: external_exports.array(external_exports.object({
    type: external_exports.literal("text"),
    text: external_exports.string()
  })),
  details: external_exports.record(external_exports.unknown()).optional()
});

// packages/contracts/dist/v1.js
var V1_SCHEMA_VERSION = "1.0.0";
var V1_SCHEMA_KINDS = {
  OWNER_AUTHORIZATION: "owner_authorization",
  PROJECT_METADATA: "project_metadata",
  TOOL_LOCK: "tool_lock",
  ACTIVATION_CERTIFICATE: "activation_certificate",
  REVOCATION_METADATA: "revocation_metadata",
  SAVINGS_EVIDENCE: "savings_evidence"
};
var V1Sha256DigestSchema = external_exports.string().regex(/^(sha256:)?[a-f0-9]{64}$/i, "Invalid SHA-256 digest format (expected 64 hex characters with optional sha256: prefix)").transform((val) => normalizeSha256(val, false));
var V1ExactSemVerSchema = external_exports.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/, "Invalid semantic version string").refine((val) => !/[*^~><=]/.test(val), {
  message: "Version ranges and wildcards (^, ~, *, >, <) are prohibited in exact pinned versions"
});
var V1OwnerTypeSchema = external_exports.enum(["user", "workspace", "account", "organization"]);
var V1RoleSchema = external_exports.enum(["owner", "admin", "member", "viewer"]);
var V1OwnerReferenceSchema = external_exports.object({
  ownerType: V1OwnerTypeSchema,
  ownerId: UUIDSchema,
  accountId: UUIDSchema
}).strict();
var V1PersonalScopeSchema = external_exports.object({
  scopeType: external_exports.literal("personal"),
  userId: UUIDSchema,
  accountId: UUIDSchema
}).strict();
var V1WorkspaceScopeSchema = external_exports.object({
  scopeType: external_exports.literal("workspace"),
  workspaceId: UUIDSchema,
  accountId: UUIDSchema
}).strict();
var V1AccountScopeSchema = external_exports.object({
  scopeType: external_exports.literal("account"),
  accountId: UUIDSchema
}).strict();
var V1OrganizationScopeSchema = external_exports.object({
  scopeType: external_exports.literal("organization"),
  organizationId: UUIDSchema,
  accountId: UUIDSchema
}).strict();
var V1AuthorizationScopeSchema = external_exports.discriminatedUnion("scopeType", [
  V1PersonalScopeSchema,
  V1WorkspaceScopeSchema,
  V1AccountScopeSchema,
  V1OrganizationScopeSchema
]);
var V1SubjectTypeSchema = external_exports.enum(["user", "service_account", "device", "mcp_client"]);
var V1OwnerAuthorizationSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.OWNER_AUTHORIZATION),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  authorizationId: UUIDSchema,
  subjectId: UUIDSchema,
  subjectType: V1SubjectTypeSchema,
  owner: V1OwnerReferenceSchema,
  scope: V1AuthorizationScopeSchema,
  roles: external_exports.array(V1RoleSchema).min(1),
  permissions: external_exports.array(external_exports.string().min(1)),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema.optional()
}).strict();
var V1ProjectSettingsSchema = external_exports.object({
  defaultRuntimeVersion: V1ExactSemVerSchema.optional(),
  environment: external_exports.string().min(1).max(64).optional(),
  tags: external_exports.array(external_exports.string().min(1).max(64)).optional()
}).strict();
var V1ProjectMetadataSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.PROJECT_METADATA),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  projectId: UUIDSchema,
  name: external_exports.string().min(1).max(128),
  settings: V1ProjectSettingsSchema.optional(),
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema.optional()
}).strict();
var V1LockSignatureIdentitySchema = external_exports.object({
  keyId: external_exports.string().min(1),
  algorithm: external_exports.enum(["ed25519", "ecdsa_p256_sha256", "rsa_pss_sha256"]),
  signer: external_exports.string().min(1).optional()
}).strict();
var V1LockedToolEntrySchema = external_exports.object({
  toolId: UUIDSchema,
  name: IdentifierSchema,
  version: V1ExactSemVerSchema,
  manifestDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  envelopeDigest: Sha256DigestSchema.optional(),
  signatureIdentity: V1LockSignatureIdentitySchema.optional(),
  status: external_exports.enum(["active", "pinned", "disabled"]).default("active")
}).strict();
var V1ToolLockSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.TOOL_LOCK),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  projectId: UUIDSchema,
  updatedAt: ISOTimestampSchema,
  tools: external_exports.record(IdentifierSchema, V1LockedToolEntrySchema)
}).strict();
var V1CertificateSubjectSchema = external_exports.object({
  userId: UUIDSchema,
  accountId: UUIDSchema,
  deviceId: UUIDSchema.optional()
}).strict();
var V1ActivationCertificateSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.ACTIVATION_CERTIFICATE),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  certificateId: UUIDSchema,
  subject: V1CertificateSubjectSchema,
  projectId: UUIDSchema,
  toolId: UUIDSchema,
  toolName: IdentifierSchema,
  version: V1ExactSemVerSchema,
  manifestDigest: Sha256DigestSchema,
  artifactDigest: Sha256DigestSchema,
  capabilityEnvelopeDigest: Sha256DigestSchema,
  qualificationEvidenceDigest: Sha256DigestSchema,
  counter: external_exports.number().int().nonnegative(),
  nonce: external_exports.string().min(8),
  issuedAt: ISOTimestampSchema,
  notBefore: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  status: external_exports.enum(["active", "suspended", "revoked"]).default("active"),
  signature: SignatureMetadataSchema
}).strict().refine((data) => {
  const issued = new Date(data.issuedAt).getTime();
  const notBefore = new Date(data.notBefore).getTime();
  const expires = new Date(data.expiresAt).getTime();
  return !Number.isNaN(issued) && !Number.isNaN(notBefore) && !Number.isNaN(expires) && notBefore <= expires && issued <= expires;
}, {
  message: "Certificate validity window invalid: issuedAt and notBefore must be before or equal to expiresAt"
});
var V1RevokedToolEntrySchema = external_exports.object({
  toolId: UUIDSchema,
  version: V1ExactSemVerSchema.optional(),
  revokedAt: ISOTimestampSchema,
  reason: external_exports.string().min(1)
}).strict();
var V1RevokedCertificateEntrySchema = external_exports.object({
  certificateId: UUIDSchema,
  revokedAt: ISOTimestampSchema,
  reason: external_exports.string().min(1)
}).strict();
var V1RevocationMetadataSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.REVOCATION_METADATA),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  revocationListId: UUIDSchema,
  authorityId: external_exports.string().min(1),
  accountId: UUIDSchema,
  sequenceNumber: external_exports.number().int().nonnegative(),
  issuedAt: ISOTimestampSchema,
  expiresAt: ISOTimestampSchema,
  revokedTools: external_exports.array(V1RevokedToolEntrySchema).default([]),
  revokedCertificates: external_exports.array(V1RevokedCertificateEntrySchema).default([]),
  revokedKeys: external_exports.array(external_exports.string().min(1)).default([]),
  signature: SignatureMetadataSchema
}).strict().refine((data) => {
  const issued = new Date(data.issuedAt).getTime();
  const expires = new Date(data.expiresAt).getTime();
  return !Number.isNaN(issued) && !Number.isNaN(expires) && issued <= expires;
}, {
  message: "Revocation metadata timestamps invalid: issuedAt must be before or equal to expiresAt"
});
var V1ObservationStatusSchema = external_exports.enum(["unavailable", "preliminary", "measured"]);
var V1UsageMetricsSchema = external_exports.object({
  inputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  outputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  reasoningTokens: external_exports.number().int().nonnegative().optional().nullable(),
  cachedInputTokens: external_exports.number().int().nonnegative().optional().nullable(),
  totalTokens: external_exports.number().int().nonnegative().optional().nullable(),
  costMicroUsd: external_exports.number().int().nonnegative().optional().nullable(),
  durationMs: external_exports.number().int().nonnegative().optional().nullable()
}).strict();
var V1CalibrationRowSchema = external_exports.object({
  rowId: UUIDSchema,
  workloadId: external_exports.string().min(1),
  benchmarkId: external_exports.string().min(1),
  baselineModel: external_exports.string().min(1),
  candidateModel: external_exports.string().min(1),
  runtimeVersion: V1ExactSemVerSchema,
  candidateVersion: V1ExactSemVerSchema,
  toolId: UUIDSchema,
  baselineUsage: V1UsageMetricsSchema.optional().nullable(),
  candidateUsage: V1UsageMetricsSchema.optional().nullable(),
  catalogExposureTokens: external_exports.number().int().nonnegative(),
  isEquivalent: external_exports.boolean(),
  status: V1ObservationStatusSchema,
  measuredAt: ISOTimestampSchema,
  digest: Sha256DigestSchema
}).strict().superRefine((data, ctx) => {
  if (data.status === "measured" || data.status === "preliminary") {
    if (data.baselineUsage === null || data.baselineUsage === void 0 || typeof data.baselineUsage.totalTokens !== "number" || data.baselineUsage.totalTokens < 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: `Calibration row with status '${data.status}' requires numeric baselineUsage.totalTokens`,
        path: ["baselineUsage", "totalTokens"]
      });
    }
    if (data.candidateUsage === null || data.candidateUsage === void 0 || typeof data.candidateUsage.totalTokens !== "number" || data.candidateUsage.totalTokens < 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: `Calibration row with status '${data.status}' requires numeric candidateUsage.totalTokens`,
        path: ["candidateUsage", "totalTokens"]
      });
    }
  }
});
var V1SavingsSummarySchema = external_exports.object({
  status: V1ObservationStatusSchema,
  totalSamples: external_exports.number().int().nonnegative().optional().nullable(),
  equivalentSamples: external_exports.number().int().nonnegative().optional().nullable(),
  tokenSavingsNet: external_exports.number().int().optional().nullable(),
  tokenSavingsPercentage: external_exports.number().optional().nullable(),
  costSavingsMicroUsdNet: external_exports.number().int().optional().nullable(),
  catalogExposureTokenSum: external_exports.number().int().nonnegative().optional().nullable(),
  confidenceInterval: external_exports.object({
    low: external_exports.number(),
    high: external_exports.number(),
    confidenceLevel: external_exports.number().min(0).max(1)
  }).strict().optional().nullable()
}).strict().superRefine((data, ctx) => {
  if (data.status === "measured") {
    if (data.totalSamples === null || data.totalSamples === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Measured summary requires numeric totalSamples",
        path: ["totalSamples"]
      });
    }
    if (data.equivalentSamples === null || data.equivalentSamples === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Measured summary requires numeric equivalentSamples",
        path: ["equivalentSamples"]
      });
    }
    if (data.tokenSavingsNet === null || data.tokenSavingsNet === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Measured summary requires numeric tokenSavingsNet",
        path: ["tokenSavingsNet"]
      });
    }
    if (data.tokenSavingsPercentage === null || data.tokenSavingsPercentage === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Measured summary requires numeric tokenSavingsPercentage",
        path: ["tokenSavingsPercentage"]
      });
    }
    if (data.catalogExposureTokenSum === null || data.catalogExposureTokenSum === void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Measured summary requires numeric catalogExposureTokenSum",
        path: ["catalogExposureTokenSum"]
      });
    }
  } else if (data.status === "unavailable") {
    if (data.tokenSavingsNet !== null && data.tokenSavingsNet !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Unavailable summary cannot claim numeric tokenSavingsNet",
        path: ["tokenSavingsNet"]
      });
    }
    if (data.tokenSavingsPercentage !== null && data.tokenSavingsPercentage !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Unavailable summary cannot claim numeric tokenSavingsPercentage",
        path: ["tokenSavingsPercentage"]
      });
    }
    if (data.costSavingsMicroUsdNet !== null && data.costSavingsMicroUsdNet !== void 0) {
      ctx.addIssue({
        code: external_exports.ZodIssueCode.custom,
        message: "Unavailable summary cannot claim numeric costSavingsMicroUsdNet",
        path: ["costSavingsMicroUsdNet"]
      });
    }
  }
});
var V1SavingsEvidenceSchema = external_exports.object({
  schemaKind: external_exports.literal(V1_SCHEMA_KINDS.SAVINGS_EVIDENCE),
  schemaVersion: external_exports.literal(V1_SCHEMA_VERSION),
  evidenceId: UUIDSchema,
  toolId: UUIDSchema,
  toolVersion: V1ExactSemVerSchema,
  projectId: UUIDSchema.optional(),
  status: V1ObservationStatusSchema,
  calibrationRows: external_exports.array(V1CalibrationRowSchema),
  summary: V1SavingsSummarySchema,
  createdAt: ISOTimestampSchema,
  evidenceDigest: Sha256DigestSchema
}).strict();

// packages/harness-contracts/dist/types.js
var InstallationStatusSchema = external_exports.enum([
  "ready",
  "unsupported_version",
  "missing_executable",
  "config_error",
  "corrupt",
  "unknown"
]);
var HarnessInstallationSchema = external_exports.object({
  harnessId: IdentifierSchema,
  displayName: external_exports.string().min(1),
  version: SchemaVersionSchema,
  executablePath: external_exports.string().optional(),
  configPath: external_exports.string().optional(),
  homePath: external_exports.string().optional(),
  isInstalled: external_exports.boolean(),
  status: InstallationStatusSchema,
  detectedAt: ISOTimestampSchema,
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var HarnessWorkspaceSchema = external_exports.object({
  workspaceId: IdentifierSchema,
  rootPath: external_exports.string().min(1),
  name: external_exports.string().min(1),
  harnessId: IdentifierSchema,
  configPath: external_exports.string().min(1),
  mcpConfigPath: external_exports.string().optional(),
  activeSessionId: IdentifierSchema.optional(),
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var SessionStatusSchema = external_exports.enum([
  "active",
  "idle",
  "completed",
  "interrupted",
  "failed",
  "unknown"
]);
var HarnessSessionSchema = external_exports.object({
  sessionId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  harnessId: IdentifierSchema,
  transcriptPath: external_exports.string().min(1),
  status: SessionStatusSchema,
  createdAt: ISOTimestampSchema,
  updatedAt: ISOTimestampSchema,
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var SourceCursorSchema = external_exports.object({
  offset: external_exports.number().int().nonnegative(),
  line: external_exports.number().int().positive(),
  sequence: external_exports.number().int().nonnegative(),
  checkpoint: Sha256DigestSchema.optional(),
  timestamp: ISOTimestampSchema
});
var RecordTypeSchema = external_exports.enum([
  "transcript_line",
  "tool_call",
  "tool_result",
  "prompt",
  "completion",
  "system",
  "custom"
]);
var RawHarnessRecordSchema = external_exports.object({
  recordId: IdentifierSchema,
  sessionId: IdentifierSchema,
  harnessId: IdentifierSchema,
  sequenceNumber: external_exports.number().int().nonnegative(),
  timestamp: ISOTimestampSchema,
  recordType: RecordTypeSchema,
  rawPayload: external_exports.unknown(),
  cursor: SourceCursorSchema,
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var DiagnosticSeveritySchema = external_exports.enum(["info", "warning", "error"]);
var AdapterDiagnosticSchema = external_exports.object({
  code: external_exports.string().min(1),
  severity: DiagnosticSeveritySchema,
  message: external_exports.string().min(1),
  path: external_exports.string().optional(),
  timestamp: ISOTimestampSchema,
  details: external_exports.record(external_exports.unknown()).optional()
});
var ConfigMutationPlanSchema = external_exports.object({
  planId: IdentifierSchema,
  harnessId: IdentifierSchema,
  targetPath: external_exports.string().min(1),
  preconditionHash: external_exports.string(),
  plannedContent: external_exports.string(),
  backupPath: external_exports.string().optional(),
  description: external_exports.string().min(1),
  diffSummary: external_exports.string().optional(),
  createdAt: ISOTimestampSchema,
  metadata: external_exports.record(external_exports.unknown()).default({})
});
var ConfigBackupSchema = external_exports.object({
  backupId: IdentifierSchema,
  targetPath: external_exports.string().min(1),
  backupPath: external_exports.string().min(1),
  contentHash: Sha256DigestSchema,
  originalContent: external_exports.string(),
  createdAt: ISOTimestampSchema,
  restored: external_exports.boolean().default(false),
  restoredAt: ISOTimestampSchema.optional()
});
var RefreshCapabilitySchema = external_exports.object({
  supportsNativeListChange: external_exports.boolean(),
  supportsContextNudge: external_exports.boolean(),
  requiresSessionRestart: external_exports.boolean(),
  description: external_exports.string().optional()
});
var TranscriptAvailabilitySchema = external_exports.enum([
  "none",
  "polling",
  "file_tail",
  "stream",
  "websocket"
]);
var VisibilityLevelSchema = external_exports.enum(["none", "partial", "full", "sanitized"]);
var SubagentVisibilitySchema = external_exports.enum(["none", "shallow", "full"]);
var McpListChangeSupportSchema = external_exports.enum(["supported", "unsupported", "requires_restart"]);
var ContextNudgeSupportSchema = external_exports.enum([
  "supported",
  "unsupported",
  "via_file",
  "via_prompt"
]);
var ObservationFidelitySchema = external_exports.object({
  transcriptAvailability: TranscriptAvailabilitySchema,
  toolCallVisibility: VisibilityLevelSchema,
  toolResultVisibility: VisibilityLevelSchema,
  subagentVisibility: SubagentVisibilitySchema,
  mcpListChange: McpListChangeSupportSchema,
  contextNudge: ContextNudgeSupportSchema,
  overallScore: external_exports.number().min(0).max(100),
  notes: external_exports.string().optional()
});
var AdapterCapabilitiesSchema = external_exports.object({
  refresh: RefreshCapabilitySchema,
  fidelity: ObservationFidelitySchema,
  supportedTransports: external_exports.array(external_exports.enum(["stdio", "sse", "websocket", "http"])).default(["stdio"]),
  supportsMultiWorkspace: external_exports.boolean().default(true),
  supportsConcurrentSessions: external_exports.boolean().default(true),
  features: external_exports.record(external_exports.boolean()).default({})
});
var CatalogChangeSummarySchema = external_exports.object({
  addedToolIds: external_exports.array(IdentifierSchema).default([]),
  updatedToolIds: external_exports.array(IdentifierSchema).default([]),
  removedToolIds: external_exports.array(IdentifierSchema).default([]),
  catalogVersion: SchemaVersionSchema,
  timestamp: ISOTimestampSchema,
  /** Rendered catalog instructions markdown for harnesses that inject prompts. */
  instructionsMarkdown: external_exports.string().optional(),
  /** Evolved tool names for per-tool invocation snippets. */
  evolvedToolNames: external_exports.array(external_exports.string()).optional()
});

// packages/harness-contracts/dist/config.js
import * as fs from "node:fs/promises";
import * as path from "node:path";

// packages/harness-contracts/dist/errors.js
var HarnessErrorCode = {
  MISSING_HARNESS: "MISSING_HARNESS",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  INACCESSIBLE_TRANSCRIPT: "INACCESSIBLE_TRANSCRIPT",
  MALFORMED_RECORD: "MALFORMED_RECORD",
  AMBIGUOUS_ACTIVE_SESSION: "AMBIGUOUS_ACTIVE_SESSION",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  CONCURRENT_CONFIG_MUTATION: "CONCURRENT_CONFIG_MUTATION",
  CONFIG_PRECONDITION_FAILED: "CONFIG_PRECONDITION_FAILED",
  TRANSCRIPT_ROTATED: "TRANSCRIPT_ROTATED",
  REFRESH_FAILED: "REFRESH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR"
};
var HarnessError = class extends Error {
  code;
  harnessId;
  details;
  isHarnessError = true;
  constructor(code, message, options) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.harnessId = options?.harnessId;
    this.details = options?.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
};
var HarnessPermissionError = class extends HarnessError {
  targetPath;
  constructor(message, options) {
    super(HarnessErrorCode.PERMISSION_ERROR, message, {
      ...options,
      details: { ...options?.details, targetPath: options?.targetPath }
    });
    this.targetPath = options?.targetPath;
  }
};

// packages/harness-contracts/dist/config.js
var NodeConfigFsBridge = class {
  async readFile(filePath) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return null;
      }
      if (err.code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied reading ${filePath}`, {
          targetPath: filePath,
          cause: err
        });
      }
      throw err;
    }
  }
  async writeFile(filePath, content) {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    } catch (err) {
      if (err.code === "EACCES") {
        throw new HarnessPermissionError(`Permission denied writing ${filePath}`, {
          targetPath: filePath,
          cause: err
        });
      }
      throw err;
    }
  }
  async exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async mkdirp(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
  }
  async copyFile(srcPath, destPath) {
    const dir = path.dirname(destPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(srcPath, destPath);
  }
  async unlink(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        throw err;
      }
    }
  }
};
var defaultFsBridge = new NodeConfigFsBridge();

// packages/harness-contracts/dist/refresh.js
var RefreshOutcomeSchema = external_exports.enum([
  "native_list_change",
  "context_nudge",
  "next_session_required",
  "unsupported",
  "failed"
]);
var RefreshResultSchema = external_exports.object({
  outcome: RefreshOutcomeSchema,
  appliedAt: ISOTimestampSchema,
  message: external_exports.string().min(1),
  catalogVersion: SchemaVersionSchema,
  affectedToolCount: external_exports.number().int().nonnegative().default(0),
  requiresRestart: external_exports.boolean().default(false),
  details: external_exports.record(external_exports.unknown()).default({})
});

// packages/harness-contracts/dist/fidelity.js
var TIER1_HIGH_FIDELITY = Object.freeze({
  transcriptAvailability: "stream",
  toolCallVisibility: "full",
  toolResultVisibility: "full",
  subagentVisibility: "full",
  mcpListChange: "supported",
  contextNudge: "supported",
  overallScore: 100,
  notes: "Full real-time streaming, bi-directional tool invocation inspection, subagent visibility, dynamic catalog reload."
});
var TIER2_MEDIUM_FIDELITY = Object.freeze({
  transcriptAvailability: "file_tail",
  toolCallVisibility: "full",
  toolResultVisibility: "full",
  subagentVisibility: "shallow",
  mcpListChange: "unsupported",
  contextNudge: "via_prompt",
  overallScore: 78,
  notes: "Session log file tailing, full tool call capture, shallow subagent visibility, prompt-based context injection."
});
var TIER3_LOW_FIDELITY = Object.freeze({
  transcriptAvailability: "polling",
  toolCallVisibility: "partial",
  toolResultVisibility: "partial",
  subagentVisibility: "none",
  mcpListChange: "requires_restart",
  contextNudge: "unsupported",
  overallScore: 35,
  notes: "Periodic polling, partial tool visibility, session restart required for catalog updates."
});

// apps/cli/src/platform/platform.ts
import os from "node:os";
import process from "node:process";
var REQUIRED_QUALIFICATION_LANES = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl"
];
var ALL_QUALIFICATION_LANES = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl-systemd",
  "wsl-fallback"
];
var V1_SUPPORT_MATRIX = Object.freeze({
  schemaVersion: "2.0.0",
  releaseVersion: "1.0.0",
  product: Object.freeze({
    productName: "Resin",
    binaryName: "resin",
    packageName: "resin",
    internalNamespace: "@resin",
    releaseVersion: "1.0.0",
    hasResinBinary: false,
    hasResinPackage: false,
    description: "Compiles recurring coding-agent work into tools that use less inference, lower inference cost, and finish faster"
  }),
  toolchain: Object.freeze({
    node: Object.freeze({
      pinned: "22",
      minimum: "22.0.0",
      range: ">=22.0.0",
      lts: true,
      status: "required"
    }),
    pnpm: Object.freeze({
      pinned: "10.24.0",
      minimum: "10.0.0",
      packageManager: "pnpm@10.24.0",
      status: "required"
    }),
    deno: Object.freeze({
      pinned: "2.9.5",
      minimum: "2.0.0",
      range: ">=2.0.0 <3.0.0",
      assetVersion: "2.9.5",
      status: "required"
    })
  }),
  platforms: Object.freeze([
    Object.freeze({
      id: "linux-x64",
      os: "linux",
      arch: "x64",
      isWsl: false,
      displayName: "Linux x86_64 (glibc / musl)",
      tier: 1,
      serviceManager: "systemd",
      tarball: "resin-v1.0.0-linux-x64.tar.gz",
      qualified: true,
      minimumOsVersion: "Kernel 5.4+ (glibc >= 2.31)"
    }),
    Object.freeze({
      id: "linux-arm64",
      os: "linux",
      arch: "arm64",
      isWsl: false,
      displayName: "Linux aarch64 (ARM64)",
      tier: 1,
      serviceManager: "systemd",
      tarball: "resin-v1.0.0-linux-arm64.tar.gz",
      qualified: true,
      minimumOsVersion: "Kernel 5.4+ (glibc >= 2.31)"
    }),
    Object.freeze({
      id: "darwin-x64",
      os: "darwin",
      arch: "x64",
      isWsl: false,
      displayName: "macOS Intel (x86_64)",
      tier: 1,
      serviceManager: "launchd",
      tarball: "resin-v1.0.0-darwin-x64.tar.gz",
      qualified: true,
      minimumOsVersion: "macOS 12 Monterey+"
    }),
    Object.freeze({
      id: "darwin-arm64",
      os: "darwin",
      arch: "arm64",
      isWsl: false,
      displayName: "macOS Apple Silicon (ARM64 M1/M2/M3/M4)",
      tier: 1,
      serviceManager: "launchd",
      tarball: "resin-v1.0.0-darwin-arm64.tar.gz",
      qualified: true,
      minimumOsVersion: "macOS 12 Monterey+"
    }),
    Object.freeze({
      id: "wsl",
      os: "linux",
      arch: "x64",
      isWsl: true,
      wslVersion: 2,
      displayName: "WSL2 (Windows Subsystem for Linux 2 x64)",
      tier: 1,
      serviceManager: "systemd | fallback",
      tarball: "resin-v1.0.0-wsl.tar.gz",
      qualified: true,
      minimumOsVersion: "WSL2 (Ubuntu 22.04+)"
    })
  ]),
  qualificationLanes: REQUIRED_QUALIFICATION_LANES,
  runtimeLanes: ALL_QUALIFICATION_LANES,
  harnesses: Object.freeze({
    "claude-code": Object.freeze({
      id: "claude-code",
      name: "Claude Code",
      adapterPackage: "@resin/adapter-claude-code",
      supportedVersions: Object.freeze([">=0.1.0", ">=0.2.0", ">=1.0.0"]),
      qualifiedVersions: Object.freeze(["0.2.14", "1.0.0"]),
      protocol: "mcp",
      transports: Object.freeze(["sse", "stdio"]),
      probeModule: "adapters/claude-code/dist/index.js",
      probeFunction: "probeClaudeInstallation"
    }),
    "codex-cli": Object.freeze({
      id: "codex-cli",
      name: "Codex CLI",
      adapterPackage: "@resin/adapter-codex",
      supportedVersions: Object.freeze([">=0.45.0"]),
      qualifiedVersions: Object.freeze(["0.45.0"]),
      protocol: "mcp",
      transports: Object.freeze(["stdio", "sse"]),
      probeModule: "adapters/codex-cli/dist/index.js",
      probeFunction: "probeCodexInstallation"
    }),
    omp: Object.freeze({
      id: "omp",
      name: "Oh My Pi",
      adapterPackage: "@resin/adapter-omp",
      supportedVersions: Object.freeze([">=0.1.0"]),
      qualifiedVersions: Object.freeze(["0.12.5", "1.0.0"]),
      protocol: "mcp",
      transports: Object.freeze(["stdio", "sse", "websocket", "http"]),
      probeModule: "adapters/omp/dist/index.js",
      probeFunction: "probeOmpInstallation"
    })
  }),
  environmentAssumptions: Object.freeze({
    shells: Object.freeze({
      supported: Object.freeze(["bash", "zsh", "sh"]),
      posixCompliant: true,
      profileFiles: Object.freeze([".bashrc", ".zshrc", ".profile"])
    }),
    packageManagers: Object.freeze({
      pnpm: Object.freeze({
        supported: true,
        recommended: true,
        version: "10.24.0"
      }),
      npm: Object.freeze({
        supported: true,
        recommended: false,
        minVersion: "9.0.0"
      }),
      yarn: Object.freeze({
        supported: false,
        recommended: false,
        reason: "Unsupported package manager; npm or pnpm required"
      })
    })
  }),
  limitations: Object.freeze({
    nativeWindows: Object.freeze({
      supported: false,
      impliedByWsl2: false,
      reason: "Native Windows (win32) is unsupported. Resin must run inside WSL2 (Windows Subsystem for Linux): `wsl --install`.",
      rejectionMessage: "Native Windows is not supported. Please run within Windows Subsystem for Linux (WSL2): `wsl --install`."
    }),
    wsl1: Object.freeze({
      supported: false,
      reason: "WSL1 is unsupported due to missing Linux socket and filesystem semantics; WSL2 is required."
    }),
    nodeUnder22: Object.freeze({
      supported: false,
      reason: "Node.js versions earlier than 22.0.0 are unsupported; Node.js 22 LTS or newer is required."
    }),
    unsupportedArchitectures: Object.freeze({
      supported: false,
      architectures: Object.freeze(["ia32", "mips", "ppc", "s390", "armv7l"]),
      reason: "32-bit and non-standard architectures are unsupported; only x64 and arm64 are supported."
    })
  })
});
var UnsupportedPlatformError = class extends Error {
  platform;
  arch;
  nodeVersion;
  isWsl;
  constructor(platform, details) {
    const message = platform === "win32" ? V1_SUPPORT_MATRIX.limitations.nativeWindows.rejectionMessage : `Unsupported platform: ${String(platform)}. Resin requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    super(message);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = details?.arch ?? process.arch;
    this.nodeVersion = details?.nodeVersion ?? process.version;
    this.isWsl = details?.isWsl ?? false;
  }
};
function isWslEnvironment(env = process.env, release) {
  if (env.WSL_DISTRO_NAME || env.IS_WSL || env.WSLENV || env.WSL_INTEROP) {
    return true;
  }
  const kernelRelease = (release ?? (process.platform === "linux" ? os.release() : "")).toLowerCase();
  if (kernelRelease.includes("microsoft") || kernelRelease.includes("wsl")) {
    return true;
  }
  return false;
}
function isAppleSilicon(platform = process.platform, arch = process.arch, env = process.env) {
  if (platform !== "darwin") {
    return false;
  }
  if (arch === "arm64") {
    return true;
  }
  if (env.ROSETTA_VERSION || env.TRANSLATED_PROCESS === "1") {
    return true;
  }
  return false;
}
function getQualificationLane(info) {
  if (info.isWsl) {
    return info.hasSystemd ? "wsl-systemd" : "wsl-fallback";
  }
  if (info.os === "darwin") {
    return info.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (info.os === "linux") {
    return info.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  return "linux-x64";
}
function detectPlatform(options = {}) {
  const targetPlatform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;
  const isWsl = isWslEnvironment(env, options.release);
  const appleSilicon = isAppleSilicon(targetPlatform, arch, env);
  let wslDistro;
  let wslVersion;
  let hasSystemd;
  if (isWsl) {
    wslDistro = env.WSL_DISTRO_NAME ?? "Ubuntu";
    wslVersion = 2;
    hasSystemd = options.hasSystemdOverride ?? (env.WSL_SYSTEMD === "1" || env.SYSTEMD_ENABLED === "1" || Boolean(env.INVOCATION_ID));
  }
  let osType = "linux";
  if (isWsl) {
    osType = "wsl";
  } else if (targetPlatform === "darwin") {
    osType = "darwin";
  } else if (targetPlatform === "linux") {
    osType = "linux";
  }
  let distro;
  if (isWsl) {
    distro = wslDistro ?? "linux-wsl";
  } else if (targetPlatform === "linux") {
    distro = env.ID ?? env.DISTRIB_ID ?? "linux-generic";
  } else if (targetPlatform === "darwin") {
    distro = "macOS";
  }
  const isSupported = targetPlatform === "linux" || targetPlatform === "darwin";
  let rejectionReason;
  if (!isSupported) {
    if (targetPlatform === "win32") {
      rejectionReason = V1_SUPPORT_MATRIX.limitations.nativeWindows.rejectionMessage;
    } else {
      rejectionReason = `Operating system '${targetPlatform}' is not supported. Resin requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    }
  }
  const info = {
    os: osType,
    isSupported,
    rejectionReason,
    isWsl,
    wslVersion,
    wslDistro,
    hasSystemd,
    platform: targetPlatform,
    arch,
    nodeVersion,
    distro,
    isAppleSilicon: appleSilicon,
    isRosetta: targetPlatform === "darwin" && arch === "x64" && Boolean(env.ROSETTA_VERSION)
  };
  const lane = getQualificationLane(info);
  return {
    ...info,
    lane
  };
}

// apps/cli/src/installer/asset-downloader.ts
import crypto from "node:crypto";
import fs2 from "node:fs";
import fsPromises from "node:fs/promises";
import path2 from "node:path";
import process2 from "node:process";
import zlib from "node:zlib";
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
var RELEASE_DIRECTORY_MODE = 493;
var RELEASE_FILE_MODE = 420;
var RELEASE_EXECUTABLE_MODE = 493;
var RELEASE_MODE_MASK = 4095;
var TAR_BLOCK_SIZE = 512;
var EXACT_RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
function normalizeReleaseVersion(version) {
  if (typeof version !== "string" || version.length === 0 || version !== version.trim()) {
    throw new Error(
      "Security violation: release version must be a non-empty exact SemVer segment."
    );
  }
  const cleanVersion = version.startsWith("v") ? version.slice(1) : version;
  if (cleanVersion.includes("/") || cleanVersion.includes("\\") || cleanVersion.includes("\0") || cleanVersion === "." || cleanVersion === ".." || !EXACT_RELEASE_VERSION_PATTERN.test(cleanVersion)) {
    throw new Error(
      `Security violation: release version must be one safe exact SemVer segment: '${version}'.`
    );
  }
  return cleanVersion;
}
function assertDirectChildPath(parentDir, candidatePath, description) {
  const parentRoot = path2.resolve(parentDir);
  const candidateRoot = path2.resolve(candidatePath);
  const relativePath = path2.relative(parentRoot, candidateRoot);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(relativePath) || path2.dirname(candidateRoot) !== parentRoot) {
    throw new Error(
      `Security violation: ${description} must be a direct child of '${parentRoot}': '${candidatePath}'.`
    );
  }
  return candidateRoot;
}
function resolveVersionChildPath(versionsDir, childName, description) {
  if (childName.length === 0 || childName === "." || childName === ".." || path2.basename(childName) !== childName || childName.includes("/") || childName.includes("\\") || childName.includes("\0")) {
    throw new Error(
      `Security violation: ${description} must use one safe direct-child segment: '${childName}'.`
    );
  }
  return assertDirectChildPath(versionsDir, path2.resolve(versionsDir, childName), description);
}
function lstatIfExists(filePath, fsSync) {
  try {
    return fsSync.lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function parseTarString(field, fieldName, headerOffset) {
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1) {
    for (let index = terminator; index < field.length; index += 1) {
      if (field[index] !== 0 && field[index] !== 32) {
        throw new Error(
          `Invalid tar archive: ${fieldName} contains data after its terminator at header offset ${headerOffset}.`
        );
      }
    }
  }
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new Error(
      `Invalid tar archive: ${fieldName} is not valid UTF-8 at header offset ${headerOffset}.`
    );
  }
  return value;
}
function parseTarOctalField(field, fieldName, headerOffset) {
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 32)) end -= 1;
  let start = 0;
  while (start < end && field[start] === 32) start += 1;
  if (start === end) return 0;
  let value = 0;
  for (let index = start; index < end; index += 1) {
    const byte = field[index];
    if (byte < 48 || byte > 55) {
      throw new Error(
        `Invalid tar archive: ${fieldName} must be a non-negative octal value at header offset ${headerOffset}.`
      );
    }
    value = value * 8 + (byte - 48);
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `Invalid tar archive: ${fieldName} exceeds the safe integer range at header offset ${headerOffset}.`
      );
    }
  }
  return value;
}
function validateTarHeaderChecksum(headerBlock, headerOffset) {
  const expectedChecksum = parseTarOctalField(
    headerBlock.subarray(148, 156),
    "header checksum",
    headerOffset
  );
  let actualChecksum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : headerBlock[index];
  }
  if (actualChecksum !== expectedChecksum) {
    throw new Error(
      `Invalid tar archive: header checksum mismatch at offset ${headerOffset}; expected ${expectedChecksum}, computed ${actualChecksum}.`
    );
  }
}
function validateTarMemberPath(fullName) {
  const directoryHint = fullName.endsWith("/");
  const pathWithoutTrailingSlash = directoryHint ? fullName.slice(0, -1) : fullName;
  if (pathWithoutTrailingSlash.length === 0 || pathWithoutTrailingSlash.startsWith("/") || fullName.includes("\\") || fullName.includes("\0")) {
    throw new Error(
      `Security violation: tar member contains illegal path traversal or a non-portable separator: '${fullName}'.`
    );
  }
  const segments = pathWithoutTrailingSlash.split("/");
  for (const segment of segments) {
    const windowsBaseName = segment.split(".", 1)[0]?.toUpperCase();
    if (segment.length === 0 || segment === "." || segment === ".." || segment !== segment.trim() || segment.endsWith(".") || segment.includes(":") || /[\u0000-\u001f\u007f]/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsBaseName ?? "")) {
      throw new Error(
        `Security violation: tar member contains illegal path traversal or a non-portable segment: '${fullName}'.`
      );
    }
  }
  return { relativePath: segments.join("/"), directoryHint };
}
function isAllZeroTarBlock(block) {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false;
  }
  return true;
}
function parseTarEntries(tarData) {
  const entries = [];
  let offset = 0;
  let foundEndMarker = false;
  while (offset < tarData.length) {
    if (tarData.length - offset < TAR_BLOCK_SIZE) {
      throw new Error(`Invalid tar archive: truncated header at offset ${offset}.`);
    }
    const headerBlock = tarData.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isAllZeroTarBlock(headerBlock)) {
      if (tarData.length - offset < TAR_BLOCK_SIZE * 2) {
        throw new Error("Invalid tar archive: truncated end-of-archive marker.");
      }
      const secondEndBlock = tarData.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE * 2);
      if (!isAllZeroTarBlock(secondEndBlock)) {
        throw new Error(`Invalid tar archive: isolated zero header block at offset ${offset}.`);
      }
      for (let index = offset + TAR_BLOCK_SIZE * 2; index < tarData.length; index += 1) {
        if (tarData[index] !== 0) {
          throw new Error("Invalid tar archive: non-zero data follows the end-of-archive marker.");
        }
      }
      foundEndMarker = true;
      break;
    }
    validateTarHeaderChecksum(headerBlock, offset);
    const rawName = parseTarString(headerBlock.subarray(0, 100), "member name", offset);
    const rawPrefix = parseTarString(headerBlock.subarray(345, 500), "member prefix", offset);
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    if (!fullName) {
      throw new Error(`Invalid tar archive: empty member name at header offset ${offset}.`);
    }
    const { relativePath, directoryHint } = validateTarMemberPath(fullName);
    const parsedMode = parseTarOctalField(headerBlock.subarray(100, 108), "mode", offset);
    const sanitizedArchiveMode = parsedMode & 511;
    const archiveMarksExecutable = Boolean(sanitizedArchiveMode & 73);
    const fileSize = parseTarOctalField(headerBlock.subarray(124, 136), "size", offset);
    const rawTypeFlag = headerBlock[156];
    const typeFlag = rawTypeFlag === 0 ? "\0" : String.fromCharCode(rawTypeFlag);
    if (typeFlag === "1" || typeFlag === "2") {
      throw new Error(
        `Security violation: symlink or hardlink entry in tar archive is not permitted: '${fullName}'.`
      );
    }
    if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "5") {
      throw new Error(
        `Security violation: unsupported or dangerous entry type '${typeFlag}' in tar archive: '${fullName}'.`
      );
    }
    const isDirectory = typeFlag === "5" || directoryHint;
    const dataOffset = offset + TAR_BLOCK_SIZE;
    const remainingData = tarData.length - dataOffset;
    if (fileSize > remainingData) {
      throw new Error(
        `Invalid tar archive: member '${fullName}' declares ${fileSize} bytes but its payload is truncated.`
      );
    }
    const paddedSize = Math.ceil(fileSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (!Number.isSafeInteger(paddedSize) || paddedSize < fileSize) {
      throw new Error(`Invalid tar archive: padded size overflows for member '${fullName}'.`);
    }
    if (paddedSize > remainingData) {
      throw new Error(
        `Invalid tar archive: member '${fullName}' has truncated 512-byte payload padding.`
      );
    }
    entries.push({
      relativePath,
      isDirectory,
      fileSize,
      dataOffset,
      sanitizedArchiveMode,
      archiveMarksExecutable
    });
    offset = dataOffset + paddedSize;
  }
  if (!foundEndMarker) {
    throw new Error("Invalid tar archive: missing end-of-archive marker.");
  }
  const seenPortablePaths = /* @__PURE__ */ new Set();
  const regularFilePaths = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    const portableKey = entry.relativePath.toLowerCase();
    if (seenPortablePaths.has(portableKey)) {
      throw new Error(
        `Invalid tar archive: duplicate or case-colliding member path '${entry.relativePath}'.`
      );
    }
    seenPortablePaths.add(portableKey);
    if (!entry.isDirectory) regularFilePaths.add(portableKey);
  }
  for (const entry of entries) {
    const segments = entry.relativePath.toLowerCase().split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (regularFilePaths.has(ancestor)) {
        throw new Error(
          `Invalid tar archive: regular file '${ancestor}' is an ancestor of '${entry.relativePath}'.`
        );
      }
    }
  }
  return entries;
}
function resolveContainedArchivePath(root, relativePath) {
  const candidatePath = path2.resolve(root, ...relativePath.split("/"));
  const nativeRelativePath = path2.relative(root, candidatePath);
  if (nativeRelativePath === "" || nativeRelativePath === ".." || nativeRelativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(nativeRelativePath)) {
    throw new Error(
      `Security violation: archive member resolves outside the extraction root: '${relativePath}'.`
    );
  }
  return candidatePath;
}
function setSafeDirectoryMode(directoryPath, desiredMode, fsSync) {
  const stats = fsSync.lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction encountered a linked or non-directory component: '${directoryPath}'.`
    );
  }
  if (process2.platform !== "win32" && (stats.mode & RELEASE_MODE_MASK) !== desiredMode) {
    fsSync.chmodSync(directoryPath, desiredMode);
  }
}
function ensureSafeDirectoryPath(root, relativeDirectory, explicitDirectoryModes, fsSync) {
  const rootStats = fsSync.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction root is no longer a real directory: '${root}'.`
    );
  }
  if (!relativeDirectory) return root;
  resolveContainedArchivePath(root, relativeDirectory);
  let currentPath = root;
  let portablePath = "";
  for (const segment of relativeDirectory.split("/")) {
    portablePath = portablePath ? `${portablePath}/${segment}` : segment;
    currentPath = path2.join(currentPath, segment);
    let stats = lstatIfExists(currentPath, fsSync);
    if (!stats) {
      const desiredMode2 = process2.platform === "win32" ? explicitDirectoryModes.get(portablePath) ?? RELEASE_DIRECTORY_MODE : RELEASE_DIRECTORY_MODE;
      try {
        fsSync.mkdirSync(currentPath, { recursive: false, mode: desiredMode2 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
      stats = fsSync.lstatSync(currentPath);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `Security violation: archive extraction encountered a linked or non-directory component: '${portablePath}'.`
      );
    }
    const desiredMode = process2.platform === "win32" ? explicitDirectoryModes.get(portablePath) ?? RELEASE_DIRECTORY_MODE : RELEASE_DIRECTORY_MODE;
    setSafeDirectoryMode(currentPath, desiredMode, fsSync);
  }
  return currentPath;
}
function writeExclusiveRegularFile(targetPath, fileData, mode, fsSync) {
  const noFollowFlag = fsSync.constants.O_NOFOLLOW ?? 0;
  const descriptor = fsSync.openSync(
    targetPath,
    fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | noFollowFlag,
    mode
  );
  try {
    if (!fsSync.fstatSync(descriptor).isFile()) {
      throw new Error(
        `Security violation: archive extraction did not create a regular file: '${targetPath}'.`
      );
    }
    fsSync.writeFileSync(descriptor, fileData);
    if (process2.platform !== "win32") {
      fsSync.fchmodSync(descriptor, mode);
      if ((fsSync.fstatSync(descriptor).mode & RELEASE_MODE_MASK) !== mode) {
        throw new Error(
          `Integrity violation: archive extraction could not apply mode 0o${mode.toString(8)} to '${targetPath}'.`
        );
      }
    }
  } finally {
    fsSync.closeSync(descriptor);
  }
}
function extractTarArchive(tarData, destinationDir, fsSync = fs2) {
  const entries = parseTarEntries(tarData);
  const root = path2.resolve(destinationDir);
  let rootStats = lstatIfExists(root, fsSync);
  if (!rootStats) {
    const parentStats = fsSync.lstatSync(path2.dirname(root));
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new Error(
        `Security violation: archive extraction parent must be a real directory: '${path2.dirname(root)}'.`
      );
    }
    fsSync.mkdirSync(root, { recursive: false, mode: 448 });
    rootStats = fsSync.lstatSync(root);
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: archive extraction root must be a real directory: '${destinationDir}'.`
    );
  }
  const existingTree = scanDirectoryTree(root, fsSync);
  if (existingTree.symlinks.length > 0) {
    throw new Error(
      `Security violation: archive extraction root contains a pre-existing link at '${existingTree.symlinks[0].relativePath}'.`
    );
  }
  if (existingTree.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: archive extraction root contains a pre-existing non-regular entry at '${existingTree.nonRegularNonDirs[0].relativePath}'.`
    );
  }
  if (existingTree.entries.length > 0) {
    throw new Error(
      `Security violation: archive extraction requires an exclusive empty staging directory: '${destinationDir}'.`
    );
  }
  const extractedFiles = [];
  const extractedDirs = [];
  const executableFiles = [];
  const explicitDirectoryModes = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const targetPath = resolveContainedArchivePath(root, entry.relativePath);
    if (entry.isDirectory) {
      const directoryMode = process2.platform === "win32" ? entry.sanitizedArchiveMode || RELEASE_DIRECTORY_MODE : RELEASE_DIRECTORY_MODE;
      explicitDirectoryModes.set(entry.relativePath, directoryMode);
      ensureSafeDirectoryPath(root, entry.relativePath, explicitDirectoryModes, fsSync);
      setSafeDirectoryMode(targetPath, directoryMode, fsSync);
      extractedDirs.push(targetPath);
      continue;
    }
    const separatorIndex = entry.relativePath.lastIndexOf("/");
    const parentRelativePath = separatorIndex === -1 ? "" : entry.relativePath.slice(0, separatorIndex);
    const parentPath = ensureSafeDirectoryPath(
      root,
      parentRelativePath,
      explicitDirectoryModes,
      fsSync
    );
    if (path2.dirname(targetPath) !== parentPath) {
      throw new Error(
        `Security violation: archive file parent escaped the extraction root: '${entry.relativePath}'.`
      );
    }
    const fileMode = process2.platform === "win32" ? entry.sanitizedArchiveMode || RELEASE_FILE_MODE : entry.archiveMarksExecutable ? RELEASE_EXECUTABLE_MODE : RELEASE_FILE_MODE;
    const fileData = tarData.subarray(entry.dataOffset, entry.dataOffset + entry.fileSize);
    writeExclusiveRegularFile(targetPath, fileData, fileMode, fsSync);
    extractedFiles.push(targetPath);
    if (entry.archiveMarksExecutable) executableFiles.push(targetPath);
  }
  setSafeDirectoryMode(root, RELEASE_DIRECTORY_MODE, fsSync);
  return { extractedFiles, extractedDirs, executableFiles };
}
function extractTarGzBuffer(tarGzBuffer, destinationDir, fsSync = fs2) {
  const decompressedTar = zlib.gunzipSync(tarGzBuffer);
  return extractTarArchive(decompressedTar, destinationDir, fsSync);
}
async function downloadAndVerifyAsset(options) {
  const { asset, downloadDir } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {
  });
  await fsBridge.mkdirp(downloadDir);
  await fsPromises.chmod(downloadDir, 493).catch(() => {
  });
  const destinationPath = path2.join(downloadDir, asset.filename);
  const tempPath = path2.join(downloadDir, `${asset.filename}.download.tmp`);
  let fileBuffer;
  if (options.sourceBuffer) {
    fileBuffer = options.sourceBuffer;
  } else if (options.sourceUrlOrPath && !options.sourceUrlOrPath.startsWith("http")) {
    fileBuffer = await fsPromises.readFile(options.sourceUrlOrPath);
  } else if (options.sourceUrlOrPath && options.sourceUrlOrPath.startsWith("http")) {
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error("No fetch implementation available for asset download.");
    }
    log(`Downloading ${asset.filename} from ${options.sourceUrlOrPath}...`);
    const timeout = options.timeoutMs ?? 6e4;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchFn(options.sourceUrlOrPath, {
        signal: controller.signal,
        headers: {
          "User-Agent": "resin-installer/1.0",
          Accept: "application/octet-stream, application/gzip, */*"
        }
      });
      if (!response.ok) {
        throw new Error(
          `Failed to download asset ${asset.filename}: HTTP ${response.status} ${response.statusText}`
        );
      }
      const arrayBuffer = await response.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    throw new Error(
      `No source buffer, local path, or URL provided to download asset ${asset.filename}`
    );
  }
  const actualDigest = sha256Hex(fileBuffer);
  if (actualDigest.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new Error(
      `Cryptographic digest mismatch for asset ${asset.filename}: expected ${asset.sha256}, calculated ${actualDigest}. Download rejected.`
    );
  }
  await fsPromises.writeFile(tempPath, fileBuffer);
  await fsPromises.chmod(tempPath, 420);
  await fsPromises.rename(tempPath, destinationPath);
  log(`Asset ${asset.filename} downloaded and verified successfully (${fileBuffer.length} bytes).`);
  return {
    path: destinationPath,
    sha256: actualDigest,
    sizeBytes: fileBuffer.length,
    verified: true
  };
}
function extractSingleFileZip(zipBuffer, expectedBasename) {
  const centralSignature = Buffer.from([80, 75, 1, 2]);
  let offset = 0;
  while (offset < zipBuffer.length - 46) {
    const central = zipBuffer.indexOf(centralSignature, offset);
    if (central < 0) break;
    if (central + 46 > zipBuffer.length) break;
    const method = zipBuffer.readUInt16LE(central + 10);
    const compressedSize = zipBuffer.readUInt32LE(central + 20);
    const nameLength = zipBuffer.readUInt16LE(central + 28);
    const extraLength = zipBuffer.readUInt16LE(central + 30);
    const commentLength = zipBuffer.readUInt16LE(central + 32);
    const localOffset = zipBuffer.readUInt32LE(central + 42);
    const fileName = zipBuffer.subarray(central + 46, central + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    const basename = path2.posix.basename(fileName);
    if (basename === expectedBasename) {
      if (zipBuffer.readUInt32LE(localOffset) !== 67324752) {
        throw new Error("Deno runtime ZIP contains an invalid local file header.");
      }
      const localNameLength = zipBuffer.readUInt16LE(localOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);
      let output;
      if (method === 0) output = Buffer.from(compressed);
      else if (method === 8) output = zlib.inflateRawSync(compressed);
      else throw new Error(`Unsupported ZIP compression method: ${method}`);
      return output;
    }
    offset = central + 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Executable '${expectedBasename}' was not found in runtime archive.`);
}
function scanDirectoryTree(baseDir, fsSync = fs2) {
  const root = path2.resolve(baseDir);
  const entries = [];
  const symlinks = [];
  const nonRegularNonDirs = [];
  function traverse(currentDir) {
    if (!fsSync.existsSync(currentDir)) return;
    const directoryEntries = fsSync.readdirSync(currentDir, { withFileTypes: true });
    for (const directoryEntry of directoryEntries) {
      const fullPath = path2.join(currentDir, directoryEntry.name);
      const nativeRelativePath = path2.relative(root, fullPath);
      if (nativeRelativePath === "" || nativeRelativePath === ".." || nativeRelativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(nativeRelativePath)) {
        throw new Error(
          `Security violation: scanned release entry escaped its root: '${fullPath}'.`
        );
      }
      const relativePath = nativeRelativePath.split(path2.sep).join("/");
      if (relativePath.includes("\\") || relativePath.split("/").some((segment) => segment === "..")) {
        throw new Error(
          `Security violation: scanned release entry contains a non-portable path: '${nativeRelativePath}'.`
        );
      }
      let stats;
      try {
        stats = fsSync.lstatSync(fullPath);
      } catch {
        continue;
      }
      const scannedEntry = { relativePath, fullPath };
      entries.push(scannedEntry);
      if (stats.isSymbolicLink()) {
        symlinks.push(scannedEntry);
      } else if (stats.isDirectory()) {
        traverse(fullPath);
      } else if (!stats.isFile()) {
        nonRegularNonDirs.push(scannedEntry);
      }
    }
  }
  traverse(root);
  return { entries, symlinks, nonRegularNonDirs };
}
function normalizeReleaseTreeModes(baseDir, executablePaths) {
  const root = path2.resolve(baseDir);
  const executableRelativePaths = /* @__PURE__ */ new Set();
  for (const executablePath of executablePaths) {
    const relativePath = path2.relative(root, path2.resolve(executablePath));
    if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(relativePath)) {
      throw new Error(
        `Security violation: executable permission policy points outside the release tree: '${executablePath}'.`
      );
    }
    const portableRelativePath = relativePath.split(path2.sep).join("/");
    if (portableRelativePath.includes("\\")) {
      throw new Error(
        `Security violation: executable permission policy contains a non-portable path: '${executablePath}'.`
      );
    }
    executableRelativePaths.add(portableRelativePath);
  }
  const rootStats = fs2.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      `Security violation: release staging root must be a real directory: '${baseDir}'.`
    );
  }
  const scan = scanDirectoryTree(root);
  if (scan.symlinks.length > 0) {
    throw new Error(
      `Security violation: symlink detected in release staging tree at '${scan.symlinks[0].relativePath}'.`
    );
  }
  if (scan.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: non-regular file detected in release staging tree at '${scan.nonRegularNonDirs[0].relativePath}'.`
    );
  }
  if (process2.platform === "win32") return executableRelativePaths;
  if ((rootStats.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE) {
    fs2.chmodSync(root, RELEASE_DIRECTORY_MODE);
  }
  for (const entry of scan.entries) {
    const stats = fs2.lstatSync(entry.fullPath);
    if (stats.isSymbolicLink() || !stats.isDirectory() && !stats.isFile()) {
      throw new Error(
        `Security violation: release entry changed type during mode normalization at '${entry.relativePath}'.`
      );
    }
    const expectedMode = stats.isDirectory() ? RELEASE_DIRECTORY_MODE : executableRelativePaths.has(entry.relativePath) ? RELEASE_EXECUTABLE_MODE : RELEASE_FILE_MODE;
    if ((stats.mode & RELEASE_MODE_MASK) !== expectedMode) {
      fs2.chmodSync(entry.fullPath, expectedMode);
    }
  }
  return executableRelativePaths;
}
function verifyInstalledVersionTree(targetDir, stagingDir, cleanVersion, expectedTarSha256, expectedExecutableFiles, expectedProvenance, expectedDenoRuntime) {
  const targetRootStat = fs2.lstatSync(targetDir);
  if (targetRootStat.isSymbolicLink() || !targetRootStat.isDirectory()) {
    throw new Error(
      `Security violation: installed version root must be a real directory: '${targetDir}'.`
    );
  }
  if (process2.platform !== "win32" && (targetRootStat.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE) {
    throw new Error(
      `Integrity violation: directory permission mode drift at '.': expected 0o${RELEASE_DIRECTORY_MODE.toString(8)}, got 0o${(targetRootStat.mode & RELEASE_MODE_MASK).toString(8)}.`
    );
  }
  const targetScan = scanDirectoryTree(targetDir);
  if (targetScan.symlinks.length > 0) {
    throw new Error(
      `Security violation: symlink detected in installed version tree at '${targetScan.symlinks[0].relativePath}'. Existing installation is untrusted.`
    );
  }
  if (targetScan.nonRegularNonDirs.length > 0) {
    throw new Error(
      `Security violation: non-regular file detected in installed version tree at '${targetScan.nonRegularNonDirs[0].relativePath}'. Existing installation is untrusted.`
    );
  }
  const stagingScan = scanDirectoryTree(stagingDir);
  if (stagingScan.symlinks.length > 0 || stagingScan.nonRegularNonDirs.length > 0) {
    throw new Error("Security violation: release staging tree changed type during verification.");
  }
  const stagingEntriesByPath = /* @__PURE__ */ new Map();
  for (const stagingEntry of stagingScan.entries) {
    stagingEntriesByPath.set(stagingEntry.relativePath, stagingEntry);
  }
  for (const targetEntry of targetScan.entries) {
    if (!stagingEntriesByPath.has(targetEntry.relativePath)) {
      throw new Error(
        `Integrity violation: extra unexpected file or directory detected in installed version tree at '${targetEntry.relativePath}'.`
      );
    }
  }
  const targetEntriesByPath = /* @__PURE__ */ new Map();
  for (const targetEntry of targetScan.entries) {
    targetEntriesByPath.set(targetEntry.relativePath, targetEntry);
  }
  for (const stagingEntry of stagingScan.entries) {
    if (!targetEntriesByPath.has(stagingEntry.relativePath)) {
      throw new Error(
        `Integrity violation: missing file or directory in installed version tree at '${stagingEntry.relativePath}'.`
      );
    }
  }
  for (const stagingEntry of stagingScan.entries) {
    const relPath = stagingEntry.relativePath;
    const targetEntry = targetEntriesByPath.get(relPath);
    if (!targetEntry) {
      throw new Error(`Integrity violation: missing installed release entry '${relPath}'.`);
    }
    const targetPath = targetEntry.fullPath;
    const stagingPath = stagingEntry.fullPath;
    const targetStat = fs2.lstatSync(targetPath);
    const stagingStat = fs2.lstatSync(stagingPath);
    if (stagingStat.isDirectory()) {
      if (!targetStat.isDirectory()) {
        throw new Error(
          `Integrity violation: expected directory at '${relPath}', but found non-directory in installed version tree.`
        );
      }
      if (process2.platform !== "win32" && (targetStat.mode & RELEASE_MODE_MASK) !== RELEASE_DIRECTORY_MODE) {
        throw new Error(
          `Integrity violation: directory permission mode drift at '${relPath}': expected 0o${RELEASE_DIRECTORY_MODE.toString(8)}, got 0o${(targetStat.mode & RELEASE_MODE_MASK).toString(8)}.`
        );
      }
      continue;
    }
    if (!targetStat.isFile()) {
      throw new Error(
        `Integrity violation: expected regular file at '${relPath}', but found non-regular file in installed version tree.`
      );
    }
    if (process2.platform !== "win32") {
      const targetMode = targetStat.mode & RELEASE_MODE_MASK;
      const expectedMode = expectedExecutableFiles.has(relPath) ? RELEASE_EXECUTABLE_MODE : RELEASE_FILE_MODE;
      if (targetMode !== expectedMode) {
        throw new Error(
          `Integrity violation: file permission mode drift at '${relPath}': expected 0o${expectedMode.toString(8)}, got 0o${targetMode.toString(8)}.`
        );
      }
    }
    if (relPath === "version.json") {
      let parsedTarget;
      try {
        parsedTarget = JSON.parse(fs2.readFileSync(targetPath, "utf8"));
      } catch (parseErr) {
        throw new Error(
          `Integrity violation: installed version.json metadata is corrupted or invalid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
        );
      }
      if (parsedTarget.version !== cleanVersion) {
        throw new Error(
          `Integrity violation: version.json version mismatch: expected '${cleanVersion}', got '${parsedTarget.version}'`
        );
      }
      if (parsedTarget.sha256 !== expectedTarSha256) {
        throw new Error(
          `Integrity violation: version.json SHA-256 mismatch: expected '${expectedTarSha256}', got '${parsedTarget.sha256}'`
        );
      }
      if (expectedProvenance) {
        const targetProv = JSON.stringify(parsedTarget.provenance ?? null);
        const expProv = JSON.stringify(expectedProvenance);
        if (targetProv !== expProv) {
          throw new Error(
            `Integrity violation: version.json provenance mismatch against expected release provenance.`
          );
        }
      }
      if (expectedDenoRuntime) {
        const targetDeno = parsedTarget.denoRuntime;
        if (!targetDeno || targetDeno.version !== expectedDenoRuntime.version) {
          throw new Error(
            `Integrity violation: version.json denoRuntime version mismatch: expected '${expectedDenoRuntime.version}', got '${targetDeno?.version}'`
          );
        }
        if (expectedDenoRuntime.sha256 && targetDeno.sha256 !== expectedDenoRuntime.sha256) {
          throw new Error(
            `Integrity violation: version.json denoRuntime digest mismatch: expected '${expectedDenoRuntime.sha256}', got '${targetDeno?.sha256}'`
          );
        }
      } else if (parsedTarget.denoRuntime) {
        throw new Error(
          `Integrity violation: version.json contains unexpected denoRuntime metadata.`
        );
      }
      continue;
    }
    if (targetStat.size !== stagingStat.size) {
      throw new Error(
        `Integrity violation: file size mismatch at '${relPath}': expected ${stagingStat.size} bytes, got ${targetStat.size} bytes.`
      );
    }
    const targetBytes = fs2.readFileSync(targetPath);
    const stagingBytes = fs2.readFileSync(stagingPath);
    if (Buffer.compare(targetBytes, stagingBytes) !== 0) {
      throw new Error(
        `Integrity violation: byte-for-byte content mismatch at '${relPath}'. Installed file does not match verified release payload.`
      );
    }
  }
}
async function installReleaseVersion(options) {
  const { version, tarballPathOrBuffer, resinHome } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {
  });
  const cleanVersion = normalizeReleaseVersion(version);
  const versionsDir = path2.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanVersion}`,
    "release version directory"
  );
  await fsBridge.mkdirp(versionsDir);
  const versionsDirStats = await fsPromises.lstat(versionsDir);
  if (versionsDirStats.isSymbolicLink() || !versionsDirStats.isDirectory()) {
    throw new Error(
      `Security violation: release versions path must be a real directory: '${versionsDir}'.`
    );
  }
  if (process2.platform !== "win32") {
    await fsPromises.chmod(versionsDir, RELEASE_DIRECTORY_MODE);
  }
  const stagingDir = resolveVersionChildPath(
    versionsDir,
    `.staging-v${cleanVersion}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    "release staging directory"
  );
  let tarGzBuffer;
  if (Buffer.isBuffer(tarballPathOrBuffer)) {
    tarGzBuffer = tarballPathOrBuffer;
  } else {
    tarGzBuffer = await fsPromises.readFile(tarballPathOrBuffer);
  }
  const tarSha256 = sha256Hex(tarGzBuffer);
  let stagingCreated = false;
  try {
    log(`Extracting release archive for version v${cleanVersion} into staging directory...`);
    await fsPromises.mkdir(stagingDir, { recursive: false, mode: 448 });
    stagingCreated = true;
    if (process2.platform !== "win32") {
      await fsPromises.chmod(stagingDir, 448);
    }
    let { extractedFiles, executableFiles } = extractTarGzBuffer(tarGzBuffer, stagingDir);
    const stagingEntries = await fsPromises.readdir(stagingDir, { withFileTypes: true });
    if (stagingEntries.length === 1 && stagingEntries[0].name === "resin" && stagingEntries[0].isDirectory()) {
      const packagedRoot = path2.join(stagingDir, "resin");
      for (const entry of await fsPromises.readdir(packagedRoot)) {
        await fsPromises.rename(path2.join(packagedRoot, entry), path2.join(stagingDir, entry));
      }
      await fsPromises.rmdir(packagedRoot);
      extractedFiles = extractedFiles.map(
        (filePath) => path2.join(stagingDir, path2.relative(packagedRoot, filePath))
      );
      executableFiles = executableFiles.map(
        (filePath) => path2.join(stagingDir, path2.relative(packagedRoot, filePath))
      );
    }
    const trustedExecutablePaths = new Set(
      executableFiles.map((filePath) => path2.resolve(filePath))
    );
    if (options.denoRuntime) {
      const runtimeBuffer = Buffer.isBuffer(options.denoRuntime.archivePathOrBuffer) ? options.denoRuntime.archivePathOrBuffer : await fsPromises.readFile(options.denoRuntime.archivePathOrBuffer);
      const runtimeDigest = sha256Hex(runtimeBuffer);
      if (options.denoRuntime.sha256 && runtimeDigest.toLowerCase() !== options.denoRuntime.sha256.toLowerCase()) {
        throw new Error(
          `Deno runtime digest mismatch: expected ${options.denoRuntime.sha256}, got ${runtimeDigest}`
        );
      }
      const denoDir = path2.join(stagingDir, "deno");
      await fsBridge.mkdirp(denoDir);
      await fsPromises.chmod(denoDir, 493).catch(() => {
      });
      const denoExecutableName = process2.platform === "win32" ? "deno.exe" : "deno";
      const denoExecutable = extractSingleFileZip(runtimeBuffer, denoExecutableName);
      const denoTarget = path2.join(denoDir, denoExecutableName);
      await fsPromises.writeFile(denoTarget, denoExecutable, {
        mode: 493
      });
      await fsPromises.chmod(denoTarget, 493);
      extractedFiles.push(denoTarget);
      trustedExecutablePaths.add(path2.resolve(denoTarget));
    }
    const stagingBin = path2.join(stagingDir, "bin");
    await fsBridge.mkdirp(stagingBin);
    await fsPromises.chmod(stagingBin, 493).catch(() => {
    });
    const expectedCli = path2.join(stagingDir, "bin", "resin");
    const expectedDaemon = path2.join(stagingDir, "bin", "resin-daemon");
    const expectedMcp = path2.join(stagingDir, "bin", "resin-mcp");
    trustedExecutablePaths.add(path2.resolve(expectedCli));
    trustedExecutablePaths.add(path2.resolve(expectedDaemon));
    trustedExecutablePaths.add(path2.resolve(expectedMcp));
    if (!fs2.existsSync(expectedCli)) {
      await fsPromises.writeFile(
        expectedCli,
        `#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { main } = await import(path.resolve(__dirname, "../apps/cli/dist/bin/cli.js"));
if (typeof main === "function") {
  try {
    const exitCode = await main(process.argv.slice(2));
    if (typeof exitCode === "number" && exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (err) {
    process.stderr.write(\`Fatal error: \${err instanceof Error ? err.message : String(err)}\\n\`);
    process.exit(1);
  }
}
`,
        { mode: 493 }
      );
      await fsPromises.chmod(expectedCli, 493);
      extractedFiles.push(expectedCli);
    }
    if (!fs2.existsSync(expectedDaemon)) {
      await fsPromises.writeFile(
        expectedDaemon,
        `#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await import(path.resolve(__dirname, "../apps/daemon/dist/bin/resin-daemon.js"));
`,
        { mode: 493 }
      );
      extractedFiles.push(expectedDaemon);
      await fsPromises.chmod(expectedDaemon, 493);
    }
    if (!fs2.existsSync(expectedMcp)) {
      await fsPromises.writeFile(
        expectedMcp,
        `#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await import(path.resolve(__dirname, "../apps/gateway/dist/bin/mcp-shim.js"));
`,
        { mode: 493 }
      );
      extractedFiles.push(expectedMcp);
      await fsPromises.chmod(expectedMcp, 493);
    }
    const versionMetadataPath = path2.join(stagingDir, "version.json");
    const versionInfo = {
      version: cleanVersion,
      installedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sha256: tarSha256,
      provenance: options.provenance,
      denoRuntime: options.denoRuntime ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 } : void 0
    };
    await fsPromises.writeFile(versionMetadataPath, JSON.stringify(versionInfo, null, 2), {
      mode: 420,
      encoding: "utf8"
    });
    extractedFiles.push(versionMetadataPath);
    await fsPromises.chmod(versionMetadataPath, 420);
    trustedExecutablePaths.delete(path2.resolve(versionMetadataPath));
    const expectedExecutableFiles = normalizeReleaseTreeModes(stagingDir, trustedExecutablePaths);
    const targetStats = lstatIfExists(targetVersionDir, fs2);
    const targetExists = targetStats !== null;
    if (targetStats && (targetStats.isSymbolicLink() || !targetStats.isDirectory())) {
      throw new Error(
        `Security violation: release version target must be a real directory: '${targetVersionDir}'.`
      );
    }
    if (targetExists && !options.force) {
      log(`Validating existing installation at ${targetVersionDir}...`);
      verifyInstalledVersionTree(
        targetVersionDir,
        stagingDir,
        cleanVersion,
        tarSha256,
        expectedExecutableFiles,
        options.provenance,
        options.denoRuntime ? { version: options.denoRuntime.version, sha256: options.denoRuntime.sha256 } : void 0
      );
      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {
      });
      stagingCreated = false;
      log(
        `Version v${cleanVersion} is already installed and verified valid, reusing existing files.`
      );
      const scanResult = scanDirectoryTree(targetVersionDir);
      const installedFilePaths = scanResult.entries.map((entry) => entry.fullPath).filter((installedPath) => {
        try {
          return fs2.lstatSync(installedPath).isFile();
        } catch {
          return false;
        }
      });
      return {
        version: cleanVersion,
        versionDir: targetVersionDir,
        installedFiles: installedFilePaths,
        entryPoints: {
          daemon: path2.join(targetVersionDir, "bin", "resin-daemon"),
          mcpShim: path2.join(targetVersionDir, "bin", "resin-mcp"),
          cli: path2.join(targetVersionDir, "bin", "resin"),
          deno: fs2.existsSync(
            path2.join(targetVersionDir, "deno", process2.platform === "win32" ? "deno.exe" : "deno")
          ) ? path2.join(
            targetVersionDir,
            "deno",
            process2.platform === "win32" ? "deno.exe" : "deno"
          ) : void 0
        }
      };
    }
    if (targetExists) {
      const backupDir = resolveVersionChildPath(
        versionsDir,
        `.backup-v${cleanVersion}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
        "release backup directory"
      );
      await fsPromises.rename(targetVersionDir, backupDir);
      try {
        await fsPromises.rename(stagingDir, targetVersionDir);
        stagingCreated = false;
      } catch (renameErr) {
        await fsPromises.rename(backupDir, targetVersionDir).catch(() => {
        });
        throw renameErr;
      }
      await fsPromises.rm(backupDir, { recursive: true, force: true }).catch(() => {
      });
    } else {
      await fsPromises.rename(stagingDir, targetVersionDir);
      stagingCreated = false;
    }
    log(`Release version v${cleanVersion} installed successfully at ${targetVersionDir}.`);
    return {
      version: cleanVersion,
      versionDir: targetVersionDir,
      installedFiles: extractedFiles.map((f) => f.replace(stagingDir, targetVersionDir)),
      entryPoints: {
        daemon: path2.join(targetVersionDir, "bin", "resin-daemon"),
        mcpShim: path2.join(targetVersionDir, "bin", "resin-mcp"),
        cli: path2.join(targetVersionDir, "bin", "resin"),
        deno: fs2.existsSync(
          path2.join(targetVersionDir, "deno", process2.platform === "win32" ? "deno.exe" : "deno")
        ) ? path2.join(targetVersionDir, "deno", process2.platform === "win32" ? "deno.exe" : "deno") : void 0
      }
    };
  } catch (error) {
    if (stagingCreated) {
      await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {
      });
    }
    throw error;
  }
}
async function switchActiveVersion(options) {
  const { resinHome, targetVersion } = options;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const log = options.logger ?? (() => {
  });
  const cleanTarget = normalizeReleaseVersion(targetVersion);
  const versionsDir = path2.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanTarget}`,
    "active release version directory"
  );
  const versionsStats = lstatIfExists(versionsDir, fs2);
  if (!versionsStats || versionsStats.isSymbolicLink() || !versionsStats.isDirectory()) {
    throw new Error(
      `Security violation: release versions path must be a real directory: '${versionsDir}'.`
    );
  }
  if (!await fsBridge.exists(targetVersionDir) || !fs2.existsSync(targetVersionDir)) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: directory does not exist at ${targetVersionDir}`
    );
  }
  const targetStats = fs2.lstatSync(targetVersionDir);
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    throw new Error(
      `Security violation: active release target must be a real direct-child directory: '${targetVersionDir}'.`
    );
  }
  const targetVersionJson = path2.join(targetVersionDir, "version.json");
  if (!fs2.existsSync(targetVersionJson)) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: missing version.json metadata at ${targetVersionJson}`
    );
  }
  const metaStat = fs2.lstatSync(targetVersionJson);
  if (metaStat.isSymbolicLink() || !metaStat.isFile()) {
    throw new Error(
      `Cannot switch to version v${cleanTarget}: version.json in target directory must be a regular file`
    );
  }
  const currentPointer = path2.join(resinHome, "current");
  const previousPointer = path2.join(resinHome, "previous");
  const versionStatePath = path2.join(resinHome, "version-state.json");
  const globalBinDir = path2.join(resinHome, "bin");
  const priorActiveVersionRaw = getActiveVersion(resinHome);
  const priorActiveVersion = priorActiveVersionRaw === null ? null : normalizeReleaseVersion(priorActiveVersionRaw);
  const hadCurrentSymlink = fs2.existsSync(currentPointer) && fs2.lstatSync(currentPointer).isSymbolicLink();
  const priorCurrentTarget = hadCurrentSymlink ? fs2.readlinkSync(currentPointer) : null;
  const hadCurrentVersionFile = fs2.existsSync(path2.join(resinHome, "current-version"));
  const priorCurrentVersionContent = hadCurrentVersionFile ? fs2.readFileSync(path2.join(resinHome, "current-version"), "utf8") : null;
  const hadPreviousSymlink = fs2.existsSync(previousPointer) && fs2.lstatSync(previousPointer).isSymbolicLink();
  const priorPreviousTarget = hadPreviousSymlink ? fs2.readlinkSync(previousPointer) : null;
  const hadPreviousVersionFile = fs2.existsSync(path2.join(resinHome, "previous-version"));
  const priorPreviousVersionContent = hadPreviousVersionFile ? fs2.readFileSync(path2.join(resinHome, "previous-version"), "utf8") : null;
  const hadVersionState = fs2.existsSync(versionStatePath);
  let priorVersionStateRaw = null;
  if (hadVersionState) {
    try {
      priorVersionStateRaw = fs2.readFileSync(versionStatePath, "utf8");
    } catch {
    }
  }
  const hadGlobalBinDir = fs2.existsSync(globalBinDir);
  const stagingBinDir = path2.join(
    resinHome,
    `.bin.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  );
  let backupBinDir = null;
  try {
    if (priorActiveVersion && priorActiveVersion !== cleanTarget) {
      const prevTargetDir = resolveVersionChildPath(
        versionsDir,
        `v${priorActiveVersion}`,
        "previous release version directory"
      );
      if (fs2.existsSync(prevTargetDir)) {
        const tmpPrevSymlink = path2.join(
          resinHome,
          `.previous.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
        );
        try {
          if (fs2.existsSync(tmpPrevSymlink)) fs2.unlinkSync(tmpPrevSymlink);
          fs2.symlinkSync(prevTargetDir, tmpPrevSymlink, "dir");
          if (fs2.existsSync(previousPointer) && fs2.lstatSync(previousPointer).isDirectory()) {
            fs2.rmSync(previousPointer, { recursive: true, force: true });
          }
          fs2.renameSync(tmpPrevSymlink, previousPointer);
        } catch {
          const tmpPrevFile = path2.join(
            resinHome,
            `.previous-version.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
          );
          fs2.writeFileSync(tmpPrevFile, priorActiveVersion, "utf8");
          fs2.chmodSync(tmpPrevFile, 420);
          fs2.renameSync(tmpPrevFile, path2.join(resinHome, "previous-version"));
        }
      }
    }
    const tmpSymlink = path2.join(
      resinHome,
      `.current.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
    );
    try {
      if (fs2.existsSync(tmpSymlink)) fs2.unlinkSync(tmpSymlink);
      fs2.symlinkSync(targetVersionDir, tmpSymlink, "dir");
      if (fs2.existsSync(currentPointer) && fs2.lstatSync(currentPointer).isDirectory()) {
        fs2.rmSync(currentPointer, { recursive: true, force: true });
      }
      fs2.renameSync(tmpSymlink, currentPointer);
    } catch {
      const tmpCurrFile = path2.join(
        resinHome,
        `.current-version.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
      );
      fs2.writeFileSync(tmpCurrFile, cleanTarget, "utf8");
      fs2.chmodSync(tmpCurrFile, 420);
      fs2.renameSync(tmpCurrFile, path2.join(resinHome, "current-version"));
    }
    await fsBridge.mkdirp(stagingBinDir);
    await fsPromises.chmod(stagingBinDir, 493).catch(() => {
    });
    const targetBinDir = path2.join(targetVersionDir, "bin");
    const binNames = /* @__PURE__ */ new Set(["resin", "resin-daemon", "resin-mcp"]);
    if (fs2.existsSync(targetBinDir)) {
      const files = fs2.readdirSync(targetBinDir);
      for (const f of files) {
        binNames.add(f);
      }
    }
    for (const binName of binNames) {
      const binTarget = path2.join(targetVersionDir, "bin", binName);
      const stagedBinPath = path2.join(stagingBinDir, binName);
      if (fs2.existsSync(binTarget)) {
        try {
          fs2.symlinkSync(binTarget, stagedBinPath);
        } catch {
          fs2.writeFileSync(
            stagedBinPath,
            `#!/usr/bin/env node
import "${path2.resolve(binTarget)}";
`,
            { mode: 493 }
          );
          fs2.chmodSync(stagedBinPath, 493);
        }
      }
    }
    if (hadGlobalBinDir) {
      backupBinDir = path2.join(
        resinHome,
        `.bin.backup-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
      );
      await fsPromises.rename(globalBinDir, backupBinDir);
    }
    try {
      await fsPromises.rename(stagingBinDir, globalBinDir);
    } catch (binRenameErr) {
      if (backupBinDir && fs2.existsSync(backupBinDir)) {
        await fsPromises.rename(backupBinDir, globalBinDir).catch(() => {
        });
        backupBinDir = null;
      }
      throw binRenameErr;
    }
    const installedList = fs2.existsSync(versionsDir) ? fs2.readdirSync(versionsDir).filter((d) => d.startsWith("v") && !d.startsWith(".")).map((d) => d.replace(/^v/, "")) : [cleanTarget];
    let existingProvenance = {};
    if (priorVersionStateRaw) {
      try {
        const state = JSON.parse(priorVersionStateRaw);
        existingProvenance = { ...state.provenanceByVersion ?? {} };
      } catch {
      }
    }
    try {
      const versionMetadata = JSON.parse(fs2.readFileSync(targetVersionJson, "utf8"));
      if (versionMetadata.provenance) existingProvenance[cleanTarget] = versionMetadata.provenance;
    } catch {
    }
    const newState = {
      activeVersion: cleanTarget,
      previousVersion: priorActiveVersion,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      installedVersions: installedList,
      provenanceByVersion: existingProvenance
    };
    const tmpStatePath = path2.join(
      resinHome,
      `.version-state.json.tmp-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
    );
    await fsPromises.writeFile(tmpStatePath, JSON.stringify(newState, null, 2), "utf8");
    await fsPromises.chmod(tmpStatePath, 420);
    await fsPromises.rename(tmpStatePath, versionStatePath);
    const verifiedActive = getActiveVersion(resinHome);
    if (verifiedActive !== cleanTarget) {
      throw new Error(
        `Atomic activation failed post-commit check: expected active version v${cleanTarget}, but resolved ${verifiedActive ? `v${verifiedActive}` : "none"}`
      );
    }
    if (backupBinDir && fs2.existsSync(backupBinDir)) {
      await fsPromises.rm(backupBinDir, { recursive: true, force: true }).catch(() => {
      });
      backupBinDir = null;
    }
    log(
      `Successfully switched active version to v${cleanTarget} (previous: ${priorActiveVersion ? `v${priorActiveVersion}` : "none"}).`
    );
    return {
      activeVersion: cleanTarget,
      previousVersion: priorActiveVersion,
      activePath: targetVersionDir,
      rollbackRetained: Boolean(priorActiveVersion && priorActiveVersion !== cleanTarget)
    };
  } catch (error) {
    if (fs2.existsSync(stagingBinDir)) {
      await fsPromises.rm(stagingBinDir, { recursive: true, force: true }).catch(() => {
      });
    }
    if (priorActiveVersion !== null) {
      if (backupBinDir && fs2.existsSync(backupBinDir)) {
        if (fs2.existsSync(globalBinDir)) {
          fs2.rmSync(globalBinDir, { recursive: true, force: true });
        }
        await fsPromises.rename(backupBinDir, globalBinDir).catch(() => {
        });
        backupBinDir = null;
      } else if (!hadGlobalBinDir && fs2.existsSync(globalBinDir)) {
        fs2.rmSync(globalBinDir, { recursive: true, force: true });
      }
      if (hadCurrentSymlink && priorCurrentTarget) {
        try {
          const tmpRestoreSymlink = path2.join(
            resinHome,
            `.current.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
          );
          if (fs2.existsSync(tmpRestoreSymlink)) fs2.unlinkSync(tmpRestoreSymlink);
          fs2.symlinkSync(priorCurrentTarget, tmpRestoreSymlink, "dir");
          fs2.renameSync(tmpRestoreSymlink, currentPointer);
        } catch {
          fs2.writeFileSync(path2.join(resinHome, "current-version"), priorActiveVersion, "utf8");
        }
      } else if (hadCurrentVersionFile && priorCurrentVersionContent) {
        fs2.writeFileSync(
          path2.join(resinHome, "current-version"),
          priorCurrentVersionContent,
          "utf8"
        );
        if (fs2.existsSync(currentPointer)) {
          fs2.rmSync(currentPointer, { recursive: true, force: true });
        }
      } else {
        const prevTargetDir = resolveVersionChildPath(
          versionsDir,
          `v${priorActiveVersion}`,
          "restored previous release version directory"
        );
        if (fs2.existsSync(prevTargetDir)) {
          try {
            const tmpRestoreSymlink = path2.join(
              resinHome,
              `.current.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
            );
            if (fs2.existsSync(tmpRestoreSymlink)) fs2.unlinkSync(tmpRestoreSymlink);
            fs2.symlinkSync(prevTargetDir, tmpRestoreSymlink, "dir");
            fs2.renameSync(tmpRestoreSymlink, currentPointer);
          } catch {
            fs2.writeFileSync(path2.join(resinHome, "current-version"), priorActiveVersion, "utf8");
          }
        }
      }
      if (hadPreviousSymlink && priorPreviousTarget) {
        try {
          const tmpRestorePrev = path2.join(
            resinHome,
            `.previous.tmp-restore-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
          );
          if (fs2.existsSync(tmpRestorePrev)) fs2.unlinkSync(tmpRestorePrev);
          fs2.symlinkSync(priorPreviousTarget, tmpRestorePrev, "dir");
          fs2.renameSync(tmpRestorePrev, previousPointer);
        } catch {
        }
      } else if (!hadPreviousSymlink && fs2.existsSync(previousPointer)) {
        fs2.rmSync(previousPointer, { recursive: true, force: true });
      }
      if (hadPreviousVersionFile && priorPreviousVersionContent) {
        fs2.writeFileSync(
          path2.join(resinHome, "previous-version"),
          priorPreviousVersionContent,
          "utf8"
        );
        fs2.chmodSync(path2.join(resinHome, "previous-version"), 420);
      } else if (!hadPreviousVersionFile && fs2.existsSync(path2.join(resinHome, "previous-version"))) {
        fs2.rmSync(path2.join(resinHome, "previous-version"), { force: true });
      }
      if (hadVersionState && priorVersionStateRaw) {
        fs2.writeFileSync(versionStatePath, priorVersionStateRaw, "utf8");
        fs2.chmodSync(versionStatePath, 420);
      } else if (!hadVersionState && fs2.existsSync(versionStatePath)) {
        fs2.rmSync(versionStatePath, { force: true });
      }
      const restoredActive = getActiveVersion(resinHome);
      if (restoredActive !== priorActiveVersion) {
        log(
          `Warning: Post-rollback active version mismatch: expected v${priorActiveVersion}, got ${restoredActive ? `v${restoredActive}` : "none"}`
        );
      }
    } else {
      if (backupBinDir && fs2.existsSync(backupBinDir)) {
        fs2.rmSync(backupBinDir, { recursive: true, force: true });
        backupBinDir = null;
      }
      if (fs2.existsSync(globalBinDir)) {
        fs2.rmSync(globalBinDir, { recursive: true, force: true });
      }
      if (fs2.existsSync(currentPointer)) {
        fs2.rmSync(currentPointer, { recursive: true, force: true });
      }
      if (fs2.existsSync(path2.join(resinHome, "current-version"))) {
        fs2.rmSync(path2.join(resinHome, "current-version"), { force: true });
      }
      if (fs2.existsSync(previousPointer)) {
        fs2.rmSync(previousPointer, { recursive: true, force: true });
      }
      if (fs2.existsSync(path2.join(resinHome, "previous-version"))) {
        fs2.rmSync(path2.join(resinHome, "previous-version"), { force: true });
      }
      if (fs2.existsSync(versionStatePath)) {
        fs2.rmSync(versionStatePath, { force: true });
      }
      const restoredActive = getActiveVersion(resinHome);
      if (restoredActive !== null) {
        fs2.rmSync(currentPointer, { recursive: true, force: true });
        fs2.rmSync(path2.join(resinHome, "current-version"), { force: true });
      }
    }
    throw error;
  }
}
async function rollbackActiveVersion(options) {
  const { resinHome } = options;
  const log = options.logger ?? (() => {
  });
  const versionStatePath = path2.join(resinHome, "version-state.json");
  const previousPointer = path2.join(resinHome, "previous");
  let targetRollbackVersion = options.targetVersion;
  if (!targetRollbackVersion && fs2.existsSync(previousPointer)) {
    try {
      const stats = fs2.lstatSync(previousPointer);
      if (stats.isSymbolicLink()) {
        const linkTarget = fs2.readlinkSync(previousPointer);
        const match = linkTarget.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) {
          targetRollbackVersion = match[1];
        }
      }
    } catch {
    }
  }
  if (!targetRollbackVersion && fs2.existsSync(path2.join(resinHome, "previous-version"))) {
    try {
      targetRollbackVersion = fs2.readFileSync(path2.join(resinHome, "previous-version"), "utf8").trim();
    } catch {
    }
  }
  if (!targetRollbackVersion && fs2.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs2.readFileSync(versionStatePath, "utf8"));
      targetRollbackVersion = state.previousVersion || void 0;
    } catch {
    }
  }
  if (!targetRollbackVersion) {
    throw new Error("Cannot rollback: no previous known good version found in resin home state.");
  }
  const cleanTarget = normalizeReleaseVersion(targetRollbackVersion);
  const versionsDir = path2.resolve(resinHome, "versions");
  const targetVersionDir = resolveVersionChildPath(
    versionsDir,
    `v${cleanTarget}`,
    "rollback release version directory"
  );
  if (!fs2.existsSync(targetVersionDir)) {
    throw new Error(
      `Cannot rollback to v${cleanTarget}: target version directory does not exist at ${targetVersionDir}`
    );
  }
  const switchResult = await switchActiveVersion({
    resinHome,
    targetVersion: cleanTarget,
    fsBridge: options.fsBridge,
    logger: options.logger
  });
  log(`Rollback completed: active version restored to v${cleanTarget}.`);
  return {
    restoredVersion: cleanTarget,
    previousVersion: switchResult.previousVersion || "unknown",
    activePath: switchResult.activePath
  };
}
function getActiveVersion(resinHome) {
  const currentPointer = path2.join(resinHome, "current");
  if (fs2.existsSync(currentPointer)) {
    try {
      const stats = fs2.lstatSync(currentPointer);
      if (stats.isSymbolicLink()) {
        const target = fs2.readlinkSync(currentPointer);
        const match = target.match(/v([0-9a-zA-Z.-]+)$/);
        if (match && match[1]) return match[1];
      }
    } catch {
    }
  }
  const currentVersionFile = path2.join(resinHome, "current-version");
  if (fs2.existsSync(currentVersionFile)) {
    try {
      const val = fs2.readFileSync(currentVersionFile, "utf8").trim().replace(/^v/, "");
      if (val) return val;
    } catch {
    }
  }
  const versionStatePath = path2.join(resinHome, "version-state.json");
  if (fs2.existsSync(versionStatePath)) {
    try {
      const state = JSON.parse(fs2.readFileSync(versionStatePath, "utf8"));
      return state.activeVersion || null;
    } catch {
    }
  }
  return null;
}

// apps/cli/src/installer/channel-verifier.ts
import crypto2 from "node:crypto";
var REVOKED_RELEASE_KEY_IDS = Object.freeze(["resin-release-v1"]);
var ED25519_SPKI_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function canonicalJson(val) {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = val;
  const keys = Object.keys(obj).filter((key) => obj[key] !== void 0).sort();
  const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${pairs.join(",")}}`;
}
function createPublicKeyFromInput(key) {
  if (typeof key !== "string") {
    return key;
  }
  const trimmed = key.trim();
  if (trimmed.startsWith("-----BEGIN PUBLIC KEY-----")) {
    return crypto2.createPublicKey(trimmed);
  }
  const rawKeyBuffer = Buffer.from(trimmed, "hex");
  if (rawKeyBuffer.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key hex length: ${rawKeyBuffer.length} bytes (expected 32 bytes).`
    );
  }
  const spkiDer = Buffer.concat([ED25519_SPKI_DER_PREFIX, rawKeyBuffer]);
  return crypto2.createPublicKey({
    key: spkiDer,
    format: "der",
    type: "spki"
  });
}
function verifyEd25519Signature(payload, signatureHex, publicKey) {
  try {
    const keyObject = createPublicKeyFromInput(publicKey);
    const canonicalString = canonicalJson(payload);
    const dataBuffer = Buffer.from(canonicalString, "utf8");
    const signatureBuffer = Buffer.from(signatureHex, "hex");
    return crypto2.verify(null, dataBuffer, keyObject, signatureBuffer);
  } catch {
    return false;
  }
}
function compareSemver(v1, v2) {
  const parseSemver = (v) => {
    const clean = v.replace(/^v/, "").trim();
    const [main, prerelease] = clean.split("-");
    const parts = (main || "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      prerelease: prerelease ?? null
    };
  };
  const a = parseSemver(v1);
  const b = parseSemver(v2);
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease !== null && b.prerelease !== null) {
    return a.prerelease.localeCompare(b.prerelease);
  }
  return 0;
}
function isVersionAtLeast(version, minVersion) {
  return compareSemver(version, minVersion) >= 0;
}
function isVersionRevoked(version, revokedVersions) {
  if (!revokedVersions || !Array.isArray(revokedVersions)) return false;
  const clean = version.replace(/^v/, "").trim();
  return revokedVersions.some((revoked) => revoked.replace(/^v/, "").trim() === clean);
}
function verifyChannelMetadata(channelData, options = {}) {
  const errors = [];
  const warnings = [];
  const requestedChannel = options.channel || "stable";
  if (!channelData || typeof channelData !== "object") {
    return {
      valid: false,
      channel: requestedChannel,
      errors: ["Invalid channel metadata format: expected a JSON object."],
      warnings
    };
  }
  const meta = channelData;
  if (!meta.schemaVersion) {
    errors.push("Channel metadata is missing required 'schemaVersion'.");
  }
  if (meta.metadataVersion === void 0 || meta.metadataVersion === null) {
    errors.push("Channel metadata is missing required 'metadataVersion'.");
  } else if (typeof meta.metadataVersion !== "number" || !Number.isInteger(meta.metadataVersion) || meta.metadataVersion < 1) {
    errors.push(`Invalid channel metadataVersion '${String(meta.metadataVersion)}'.`);
  } else if (meta.metadataVersion > 1) {
    errors.push(
      `Unsupported channel metadataVersion ${meta.metadataVersion}. Expected metadataVersion 1.`
    );
  }
  if (!meta.expiresAt || typeof meta.expiresAt !== "string") {
    errors.push("Channel metadata is missing required 'expiresAt'.");
  } else {
    const expiresAtMs = Date.parse(meta.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      errors.push(
        `Channel metadata 'expiresAt' is not a valid ISO timestamp: '${meta.expiresAt}'.`
      );
    } else {
      const nowMs = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : typeof options.now === "string" ? Date.parse(options.now) : Date.now();
      if (!Number.isNaN(nowMs) && nowMs > expiresAtMs) {
        errors.push(
          `Channel metadata has expired (expiresAt: '${meta.expiresAt}', current: '${new Date(nowMs).toISOString()}').`
        );
      }
    }
  }
  if (!meta.channels || typeof meta.channels !== "object") {
    errors.push("Channel metadata is missing required 'channels' mapping.");
  } else {
    const channelInfo = meta.channels[requestedChannel];
    if (!channelInfo) {
      errors.push(
        `Requested release channel '${requestedChannel}' was not found in channel metadata.`
      );
    } else {
      if (!channelInfo.version) {
        errors.push(`Release channel '${requestedChannel}' is missing required 'version'.`);
      }
      if (channelInfo.version && isVersionRevoked(channelInfo.version, meta.revokedVersions)) {
        errors.push(
          `Target version '${channelInfo.version}' in channel '${requestedChannel}' has been revoked. Installation aborted.`
        );
      }
      const minVersion = channelInfo.minSupportedVersion || meta.minSupportedVersion || options.minSupportedVersion;
      if (minVersion && channelInfo.version && !isVersionAtLeast(channelInfo.version, minVersion)) {
        errors.push(
          `Target version '${channelInfo.version}' is below the required minimum supported version '${minVersion}'.`
        );
      }
      const currentInstalled = options.currentInstalledVersion || options.currentActiveVersion;
      if (currentInstalled && channelInfo.version) {
        if (compareSemver(channelInfo.version, currentInstalled) < 0) {
          errors.push(
            `Target version '${channelInfo.version}' cannot downgrade currently installed version '${currentInstalled}'.`
          );
        }
      }
    }
  }
  if (meta.rollbackReferences) {
    if (!meta.rollbackReferences.targetVersion) {
      warnings.push("Rollback references present but missing 'targetVersion'.");
    }
    if (!meta.rollbackReferences.minSafeVersion) {
      warnings.push("Rollback references present but missing 'minSafeVersion'.");
    }
  }
  const signingKeyIds = [];
  if (!options.skipSignatureVerification) {
    if (!meta.signatures || meta.signatures.length === 0) {
      errors.push("Cryptographic verification failed: channel metadata is unsigned.");
    }
    const trustedKeys = options.trustedReleaseKeys || [];
    if (trustedKeys.length === 0) {
      errors.push(
        "Cryptographic verification failed: no trusted release public keys are configured."
      );
    }
    if (meta.signatures && meta.signatures.length > 0 && trustedKeys.length > 0) {
      const payloadToVerify = {
        schemaVersion: meta.schemaVersion,
        ...meta.metadataVersion !== void 0 ? { metadataVersion: meta.metadataVersion } : {},
        ...meta.expiresAt !== void 0 ? { expiresAt: meta.expiresAt } : {},
        ...meta.minSupportedVersion !== void 0 ? { minSupportedVersion: meta.minSupportedVersion } : {},
        currentVersion: meta.currentVersion,
        updatedAt: meta.updatedAt,
        ...meta.releaseIdentity !== void 0 ? { releaseIdentity: meta.releaseIdentity } : {},
        channels: meta.channels,
        ...meta.rollbackReferences !== void 0 ? { rollbackReferences: meta.rollbackReferences } : {},
        ...meta.revokedVersions !== void 0 ? { revokedVersions: meta.revokedVersions } : {},
        ...meta.revokedKeyIds !== void 0 ? { revokedKeyIds: meta.revokedKeyIds } : {}
      };
      const revokedSet = /* @__PURE__ */ new Set([
        ...REVOKED_RELEASE_KEY_IDS,
        ...options.revokedKeyIds || []
      ]);
      let signatureMatched = false;
      let hasRevokedSignature = false;
      let hasKeyMismatch = false;
      for (const sig of meta.signatures) {
        if (sig.algorithm !== "Ed25519") {
          warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
          continue;
        }
        if (revokedSet.has(sig.keyId)) {
          hasRevokedSignature = true;
          errors.push(`Signature key '${sig.keyId}' is revoked.`);
          continue;
        }
        const trustedKey = trustedKeys.find((k) => k.keyId === sig.keyId);
        if (!trustedKey) {
          warnings.push(`Signature key '${sig.keyId}' is not in trusted release keys list.`);
          continue;
        }
        const expectedHex = trustedKey.publicKeyHex.trim().toLowerCase();
        if (sig.publicKeyHex) {
          const sigHex = sig.publicKeyHex.trim().toLowerCase();
          if (sigHex !== expectedHex) {
            hasKeyMismatch = true;
            errors.push(
              `Signature key '${sig.keyId}' public key hex mismatch (expected ${expectedHex}, got ${sigHex}).`
            );
            continue;
          }
        }
        if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, expectedHex)) {
          signatureMatched = true;
          signingKeyIds.push(sig.keyId);
        } else {
          warnings.push(`Signature verification failed for key '${sig.keyId}'.`);
        }
      }
      if (!signatureMatched) {
        if (!hasRevokedSignature && !hasKeyMismatch) {
          errors.push(
            "Cryptographic verification failed: no valid Ed25519 signature matched channel metadata payload."
          );
        }
      }
    }
  }
  const selectedChannelInfo = meta.channels ? meta.channels[requestedChannel] : void 0;
  return {
    valid: errors.length === 0,
    channel: requestedChannel,
    targetVersion: selectedChannelInfo?.version,
    manifestUrl: selectedChannelInfo?.manifestUrl,
    manifestDigest: selectedChannelInfo?.manifestDigest,
    rollbackReference: meta.rollbackReferences,
    errors,
    warnings,
    signingKeyIds: signingKeyIds.length > 0 ? signingKeyIds : void 0,
    revokedKeyIds: meta.revokedKeyIds && errors.length === 0 ? [...meta.revokedKeyIds] : void 0
  };
}
function verifyManifest(manifestData, options = {}) {
  const errors = [];
  const warnings = [];
  if (!manifestData || typeof manifestData !== "object") {
    return {
      valid: false,
      assets: {},
      errors: ["Invalid manifest format: expected a JSON object."],
      warnings
    };
  }
  const manifest = manifestData;
  if (!manifest.schemaVersion) {
    errors.push("Manifest missing required 'schemaVersion'.");
  }
  if (manifest.metadataVersion === void 0 || manifest.metadataVersion === null) {
    errors.push("Manifest missing required 'metadataVersion'.");
  } else if (typeof manifest.metadataVersion !== "number" || !Number.isInteger(manifest.metadataVersion) || manifest.metadataVersion < 1) {
    errors.push(`Invalid manifest metadataVersion '${String(manifest.metadataVersion)}'.`);
  } else if (manifest.metadataVersion > 1) {
    errors.push(
      `Unsupported manifest metadataVersion ${manifest.metadataVersion}. Expected metadataVersion 1.`
    );
  }
  if (!manifest.expiresAt || typeof manifest.expiresAt !== "string") {
    errors.push("Manifest missing required 'expiresAt'.");
  } else {
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      errors.push(`Manifest 'expiresAt' is not a valid ISO timestamp: '${manifest.expiresAt}'.`);
    } else {
      const nowMs = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : typeof options.now === "string" ? Date.parse(options.now) : Date.now();
      if (!Number.isNaN(nowMs) && nowMs > expiresAtMs) {
        errors.push(
          `Manifest has expired (expiresAt: '${manifest.expiresAt}', current: '${new Date(nowMs).toISOString()}').`
        );
      }
    }
  }
  if (!manifest.version) {
    errors.push("Manifest missing required 'version'.");
  } else {
    const currentInstalled = options.currentInstalledVersion || options.currentActiveVersion;
    if (currentInstalled && compareSemver(manifest.version, currentInstalled) < 0) {
      errors.push(
        `Manifest version '${manifest.version}' cannot downgrade currently installed version '${currentInstalled}'.`
      );
    }
    const minVersion = options.minSupportedVersion;
    if (minVersion && !isVersionAtLeast(manifest.version, minVersion)) {
      errors.push(
        `Manifest version '${manifest.version}' is below minimum supported version '${minVersion}'.`
      );
    }
  }
  if (!manifest.assets || typeof manifest.assets !== "object") {
    errors.push("Manifest missing required 'assets' object.");
  } else {
    for (const [key, asset] of Object.entries(manifest.assets)) {
      if (!asset || typeof asset !== "object") {
        errors.push(`Manifest asset '${key}' is invalid.`);
        continue;
      }
      if (typeof asset.sizeBytes !== "number" || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
        errors.push(`Manifest asset '${key}' has invalid sizeBytes.`);
      } else if (asset.sizeBytes > 2 * 1024 * 1024 * 1024) {
        errors.push(`Manifest asset '${key}' exceeds maximum allowed release size of 2 GiB.`);
      }
      if (!asset.sha256 || !/^[a-f0-9]{64}$/i.test(asset.sha256)) {
        errors.push(`Manifest asset '${key}' has invalid sha256 digest.`);
      }
    }
  }
  if (options.expectedDigest) {
    const digestInput = options.rawManifestBytes ?? canonicalJson(manifest);
    const actualDigest = crypto2.createHash("sha256").update(digestInput).digest("hex");
    if (actualDigest !== options.expectedDigest) {
      errors.push(
        `Release manifest digest mismatch: expected ${options.expectedDigest}, got ${actualDigest}.`
      );
    }
  }
  const signingKeyIds = [];
  if (!options.skipSignatureVerification) {
    if (!manifest.signatures || manifest.signatures.length === 0) {
      errors.push("Cryptographic verification failed: release manifest is unsigned.");
    }
    const trustedKeys = options.trustedReleaseKeys || [];
    if (trustedKeys.length === 0) {
      errors.push(
        "Cryptographic verification failed: no trusted release public keys are configured."
      );
    }
    if (manifest.signatures && manifest.signatures.length > 0 && trustedKeys.length > 0) {
      const payloadToVerify = {
        schemaVersion: manifest.schemaVersion,
        ...manifest.metadataVersion !== void 0 ? { metadataVersion: manifest.metadataVersion } : {},
        ...manifest.expiresAt !== void 0 ? { expiresAt: manifest.expiresAt } : {},
        version: manifest.version,
        releaseDate: manifest.releaseDate,
        ...manifest.releaseIdentity !== void 0 ? { releaseIdentity: manifest.releaseIdentity } : {},
        ...manifest.packages !== void 0 ? { packages: manifest.packages } : {},
        assets: manifest.assets,
        ...manifest.runtimes !== void 0 ? { runtimes: manifest.runtimes } : {},
        ...manifest.evidence !== void 0 ? { evidence: manifest.evidence } : {}
      };
      const revokedSet = /* @__PURE__ */ new Set([
        ...REVOKED_RELEASE_KEY_IDS,
        ...options.revokedKeyIds || []
      ]);
      let signatureMatched = false;
      let hasRevokedSignature = false;
      let hasKeyMismatch = false;
      for (const sig of manifest.signatures) {
        if (sig.algorithm !== "Ed25519") {
          warnings.push(`Ignoring unsupported signature algorithm: ${sig.algorithm}`);
          continue;
        }
        if (revokedSet.has(sig.keyId)) {
          hasRevokedSignature = true;
          errors.push(`Signature key '${sig.keyId}' is revoked.`);
          continue;
        }
        const trustedKey = trustedKeys.find((k) => k.keyId === sig.keyId);
        if (!trustedKey) {
          warnings.push(`Signature key '${sig.keyId}' is not in trusted release keys list.`);
          continue;
        }
        const expectedHex = trustedKey.publicKeyHex.trim().toLowerCase();
        if (sig.publicKeyHex) {
          const sigHex = sig.publicKeyHex.trim().toLowerCase();
          if (sigHex !== expectedHex) {
            hasKeyMismatch = true;
            errors.push(
              `Signature key '${sig.keyId}' public key hex mismatch (expected ${expectedHex}, got ${sigHex}).`
            );
            continue;
          }
        }
        if (verifyEd25519Signature(payloadToVerify, sig.signatureHex, expectedHex)) {
          signatureMatched = true;
          signingKeyIds.push(sig.keyId);
        } else {
          warnings.push(`Signature verification failed for key '${sig.keyId}'.`);
        }
      }
      if (!signatureMatched) {
        if (!hasRevokedSignature && !hasKeyMismatch) {
          errors.push(
            "Cryptographic verification failed: no valid Ed25519 signature matched manifest payload."
          );
        }
      }
    }
  }
  return {
    valid: errors.length === 0,
    version: manifest.version,
    assets: manifest.assets || {},
    errors,
    warnings,
    signingKeyIds: signingKeyIds.length > 0 ? signingKeyIds : void 0
  };
}
function selectPlatformAsset(manifest, platform) {
  if (!manifest.assets || typeof manifest.assets !== "object") {
    throw new Error("Release manifest has no assets available.");
  }
  const isWsl = Boolean(platform.isWsl) || platform.os === "wsl";
  const arch = platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;
  const osName = isWsl ? "wsl" : platform.os;
  if (isWsl && arch !== "x64" && arch !== "arm64") {
    throw new Error(
      `Unsupported WSL architecture '${platform.arch}'. Only x64 and arm64 are supported.`
    );
  }
  let platformId;
  if (isWsl) {
    platformId = `wsl-${arch}`;
  } else {
    platformId = `${osName}-${arch}`;
  }
  let asset = manifest.assets[platformId];
  if (!asset && isWsl) {
    asset = Object.values(manifest.assets).find(
      (a) => a.arch === arch && (a.platform === "wsl" || a.isWsl === true)
    );
  }
  if (!asset && isWsl) {
    asset = manifest.assets[`linux-${arch}`];
    if (!asset) {
      asset = Object.values(manifest.assets).find(
        (a) => a.arch === arch && a.platform === "linux" && !a.isWsl
      );
    }
  }
  if (!asset && !isWsl) {
    asset = Object.values(manifest.assets).find(
      (a) => a.arch === arch && a.platform === osName && !a.isWsl
    );
  }
  if (!asset) {
    const available = Object.keys(manifest.assets).join(", ");
    throw new Error(
      `No compatible release asset found for platform '${platformId}' (os: ${osName}, arch: ${arch}, isWsl: ${isWsl}). Available assets: ${available}`
    );
  }
  return asset;
}

// apps/cli/src/installer/release-client.ts
import crypto3 from "node:crypto";
import dns from "node:dns/promises";
import fs3 from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
var DEFAULT_PRODUCTION_CHANNEL_URL = "https://dist.resin.sh/releases/v1/channels.json";
var PINNED_DENO_VERSION = "2.9.5";
var MAX_CHANNEL_SIZE_BYTES = 1 * 1024 * 1024;
var MAX_MANIFEST_SIZE_BYTES = 4 * 1024 * 1024;
var MAX_RELEASE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
var MAX_HEADER_SIZE_BYTES = 64 * 1024;
var MAX_PUBLIC_HELPER_SIZE_BYTES = 1 * 1024 * 1024;
var DEFAULT_REQUEST_DEADLINE_MS = 60 * 1e3;
var DEFAULT_IDLE_TIMEOUT_MS = 15 * 1e3;
var DEFAULT_CONNECT_TIMEOUT_MS = 15 * 1e3;
var PINNED_DENO_RUNTIMES = Object.freeze({
  "linux-x64": Object.freeze({
    filename: "deno-x86_64-unknown-linux-gnu.zip",
    sha256: "8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530",
    sizeBytes: 41638854,
    sourceUrl: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip"
  }),
  "linux-arm64": Object.freeze({
    filename: "deno-aarch64-unknown-linux-gnu.zip",
    sha256: "6b7cae3a8fc4385a59dea3146fcb8bad7fea4230e0ad36a8c692afacbc254be0",
    sizeBytes: 39902077,
    sourceUrl: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-unknown-linux-gnu.zip"
  }),
  "darwin-x64": Object.freeze({
    filename: "deno-x86_64-apple-darwin.zip",
    sha256: "c1b8b89a81e91b2a8b3f96def3195d08cfe3a105651da7908d53061f7140510d",
    sizeBytes: 42346648,
    sourceUrl: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-apple-darwin.zip"
  }),
  "darwin-arm64": Object.freeze({
    filename: "deno-aarch64-apple-darwin.zip",
    sha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
    sizeBytes: 38511993,
    sourceUrl: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip"
  })
});
function normalizeSha2562(value) {
  return value.replace(/^sha256:/i, "").trim().toLowerCase();
}
function sha256Hex2(value) {
  return crypto3.createHash("sha256").update(value).digest("hex");
}
function assertSha256(value, label) {
  const normalized = normalizeSha2562(value);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must contain an immutable SHA-256 digest.`);
  }
  return normalized;
}
var SENSITIVE_AUTH_PATH_REGEX = /\/(?:api\/v\d+\/)?(?:auth|oauth|login|signin|session|token|credentials|private-tools)(?:\/|$|\?)/i;
var SENSITIVE_QUERY_PARAM_REGEX = /[?&](?:token|access_token|session_token|auth_token|api_key|auth|bearer|jwt)=/i;
function isProhibitedIPv4(ip, allowLoopback = false) {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return true;
    const n = Number(part);
    if (n < 0 || n > 255) return true;
  }
  const [a, b, c] = parts.map((p) => Number(p));
  if (a === 127) {
    return !allowLoopback;
  }
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && (b & 192) === 64) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224 && a <= 239) return true;
  if (a >= 240) return true;
  return false;
}
function isProhibitedIPv6(ip, allowLoopback = false) {
  let cleanIp = ip.trim().toLowerCase();
  if (cleanIp.startsWith("[") && cleanIp.endsWith("]")) {
    cleanIp = cleanIp.slice(1, -1);
  }
  let embeddedIpv4;
  const lastColonIndex = cleanIp.lastIndexOf(":");
  if (lastColonIndex !== -1) {
    const potentialIpv4 = cleanIp.slice(lastColonIndex + 1);
    if (potentialIpv4.includes(".")) {
      embeddedIpv4 = potentialIpv4;
      const ipv4Parts = potentialIpv4.split(".");
      if (ipv4Parts.length !== 4) return true;
      for (const p of ipv4Parts) {
        if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return true;
      }
      const [o0, o1, o2, o3] = ipv4Parts.map((p) => Number(p));
      const word1 = ((o0 << 8 | o1) & 65535).toString(16);
      const word2 = ((o2 << 8 | o3) & 65535).toString(16);
      cleanIp = `${cleanIp.slice(0, lastColonIndex)}:${word1}:${word2}`;
    }
  }
  const doubleColonIndex = cleanIp.indexOf("::");
  let words = [];
  if (doubleColonIndex !== -1) {
    if (cleanIp.indexOf("::", doubleColonIndex + 2) !== -1) {
      return true;
    }
    const leftPart = cleanIp.slice(0, doubleColonIndex);
    const rightPart = cleanIp.slice(doubleColonIndex + 2);
    const leftWords = leftPart ? leftPart.split(":").map((w) => Number.parseInt(w, 16)) : [];
    const rightWords = rightPart ? rightPart.split(":").map((w) => Number.parseInt(w, 16)) : [];
    if (leftWords.some(Number.isNaN) || rightWords.some(Number.isNaN)) return true;
    if (leftWords.some((w) => w < 0 || w > 65535) || rightWords.some((w) => w < 0 || w > 65535)) {
      return true;
    }
    const missingCount = 8 - (leftWords.length + rightWords.length);
    if (missingCount < 1) return true;
    words = [...leftWords, ...new Array(missingCount).fill(0), ...rightWords];
  } else {
    const rawWords = cleanIp.split(":");
    if (rawWords.length !== 8) return true;
    words = rawWords.map((w) => Number.parseInt(w, 16));
    if (words.some(Number.isNaN) || words.some((w) => w < 0 || w > 65535)) return true;
  }
  if (words.length !== 8) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  if (words.every((w) => w === 0)) return true;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) {
    return !allowLoopback;
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 65535) {
    const derivedIpv4 = [w6 >> 8, w6 & 255, w7 >> 8, w7 & 255].join(".");
    return isProhibitedIPv4(derivedIpv4, allowLoopback);
  }
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const derivedIpv4 = [w6 >> 8, w6 & 255, w7 >> 8, w7 & 255].join(".");
    return isProhibitedIPv4(derivedIpv4, allowLoopback);
  }
  if (embeddedIpv4 && isProhibitedIPv4(embeddedIpv4, allowLoopback)) {
    return true;
  }
  if ((w0 & 65024) === 64512) return true;
  if ((w0 & 65472) === 65152) return true;
  if ((w0 & 65280) === 65280) return true;
  if (w0 === 8193 && w1 === 3512) return true;
  if (w0 === 8193 && w1 === 2) return true;
  if (w0 === 256 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  if (w0 === 100 && w1 === 65435 && w2 === 1) return true;
  if (w0 === 8194) {
    const derivedIpv4 = [w1 >> 8, w1 & 255, w2 >> 8, w2 & 255].join(".");
    if (isProhibitedIPv4(derivedIpv4, allowLoopback)) return true;
  }
  return false;
}
function isProhibitedIP(ip, allowLoopback = false) {
  const cleanIp = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  if (net.isIPv4(cleanIp)) {
    return isProhibitedIPv4(cleanIp, allowLoopback);
  }
  if (net.isIPv6(cleanIp)) {
    return isProhibitedIPv6(cleanIp, allowLoopback);
  }
  return true;
}
function isProhibitedHostname(hostname, allowLoopback = false) {
  const normalized = hostname.toLowerCase().trim();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return !allowLoopback;
  }
  if (normalized === "metadata.google.internal" || normalized.endsWith(".metadata.google.internal") || normalized === "metadata" || normalized === "instance-data" || normalized === "169.254.169.254" || normalized === "100.100.100.200") {
    return true;
  }
  return false;
}
async function validateAndResolveDestination(url, options = {}) {
  const allowLoopback = options.allowInsecureHttpForTests === true;
  const rawHost = url.hostname;
  const ipHost = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (net.isIP(ipHost)) {
    const family = net.isIP(ipHost);
    if (isProhibitedIP(ipHost, allowLoopback)) {
      throw new Error(`Release download destination '${rawHost}' is a prohibited address family.`);
    }
    return { address: ipHost, family };
  }
  if (isProhibitedHostname(rawHost, allowLoopback)) {
    throw new Error(`Prohibited release download destination hostname: '${rawHost}'`);
  }
  const lookupFn = options.dnsLookup ?? (async (h) => dns.lookup(h, { all: true }));
  let results;
  try {
    results = await lookupFn(url.hostname);
  } catch (error) {
    throw new Error(
      `Failed to resolve release host '${url.hostname}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!results || results.length === 0) {
    throw new Error(`Release host '${url.hostname}' resolved to zero DNS records.`);
  }
  for (const record of results) {
    if (!record.address || record.family !== 4 && record.family !== 6) {
      throw new Error(`Release host '${url.hostname}' returned invalid DNS answer.`);
    }
    if (isProhibitedIP(record.address, allowLoopback)) {
      throw new Error(
        `Release download destination '${url.hostname}' resolved to prohibited address '${record.address}'. Mixed or private DNS answers are strictly rejected.`
      );
    }
  }
  return { address: results[0].address, family: results[0].family };
}
function assertTransport(urlString, allowInsecureHttpForTests) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid release artifact URL: ${urlString}`);
  }
  if (url.username || url.password) {
    throw new Error(`Release URL contains embedded credentials: ${urlString}`);
  }
  if (SENSITIVE_AUTH_PATH_REGEX.test(url.pathname) || SENSITIVE_QUERY_PARAM_REGEX.test(url.search)) {
    throw new Error(
      `Public release download rejected sensitive or session-bound endpoint: ${urlString}`
    );
  }
  if (url.protocol === "https:") return url;
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (allowInsecureHttpForTests && url.protocol === "http:" && isLoopback) {
    return url;
  }
  throw new Error(`Release metadata and assets must use HTTPS: ${urlString}`);
}
async function nodePinnedFetch(currentUrl, pinnedAddress, family, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = currentUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = currentUrl.port ? Number(currentUrl.port) : isHttps ? 443 : 80;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const maxHeaderSize = options.maxHeaderSizeBytes ?? MAX_HEADER_SIZE_BYTES;
    let settled = false;
    let absoluteTimer = null;
    let idleTimer = null;
    let connectTimer = null;
    const cleanupTimers = () => {
      if (absoluteTimer) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      try {
        req.destroy();
      } catch {
      }
      reject(err);
    };
    const resetIdleTimer = () => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(
          new Error(
            `Download socket idle timeout exceeded after ${idleTimeoutMs}ms with no activity for ${currentUrl.toString()}`
          )
        );
      }, idleTimeoutMs);
    };
    absoluteTimer = setTimeout(() => {
      fail(
        new Error(
          `Download exceeded absolute request deadline of ${timeoutMs}ms for ${currentUrl.toString()}`
        )
      );
    }, timeoutMs);
    connectTimer = setTimeout(() => {
      fail(
        new Error(
          `Download connection timeout exceeded after ${connectTimeoutMs}ms for ${currentUrl.toString()}`
        )
      );
    }, connectTimeoutMs);
    const req = transport.request(
      {
        protocol: currentUrl.protocol,
        hostname: currentUrl.hostname,
        port,
        path: currentUrl.pathname + currentUrl.search,
        method: "GET",
        maxHeaderSize,
        lookup: (_hostname, lookupOptions, callback) => {
          const isAll = typeof lookupOptions === "object" && lookupOptions !== null && Boolean(lookupOptions.all);
          if (isAll) {
            callback(null, [{ address: pinnedAddress, family }]);
          } else {
            callback(
              null,
              pinnedAddress,
              family
            );
          }
        },
        servername: isHttps ? currentUrl.hostname : void 0,
        headers: {
          Accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8",
          "User-Agent": "resin-installer"
        }
      },
      (res) => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        resetIdleTimer();
        const clRaw = res.headers["content-length"];
        let expectedCl;
        if (clRaw !== void 0) {
          const parsed = Number.parseInt(Array.isArray(clRaw) ? clRaw[0] : clRaw, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            expectedCl = parsed;
            if (options.maxSizeBytes !== void 0 && parsed > options.maxSizeBytes) {
              return fail(
                new Error(
                  `Response Content-Length ${parsed} exceeds maximum allowed size of ${options.maxSizeBytes} bytes.`
                )
              );
            }
            if (options.exactSizeBytes !== void 0 && parsed !== options.exactSizeBytes) {
              return fail(
                new Error(
                  `Response Content-Length ${parsed} does not match expected exact size of ${options.exactSizeBytes} bytes.`
                )
              );
            }
          }
        }
        const chunks = [];
        let totalReceived = 0;
        res.on("data", (chunk) => {
          resetIdleTimer();
          totalReceived += chunk.length;
          if (options.maxSizeBytes !== void 0 && totalReceived > options.maxSizeBytes) {
            return fail(
              new Error(
                `Response body exceeded maximum allowed size of ${options.maxSizeBytes} bytes (chunk overflow).`
              )
            );
          }
          if (options.exactSizeBytes !== void 0 && totalReceived > options.exactSizeBytes) {
            return fail(
              new Error(
                `Response body exceeded expected exact size of ${options.exactSizeBytes} bytes.`
              )
            );
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          cleanupTimers();
          if (options.exactSizeBytes !== void 0 && totalReceived !== options.exactSizeBytes) {
            return reject(
              new Error(
                `Response body size mismatch: expected ${options.exactSizeBytes} bytes, received ${totalReceived} bytes.`
              )
            );
          }
          if (expectedCl !== void 0 && totalReceived !== expectedCl) {
            return reject(
              new Error(
                `Response body size ${totalReceived} does not match Content-Length header ${expectedCl}.`
              )
            );
          }
          const body = Buffer.concat(chunks);
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === void 0) continue;
            if (Array.isArray(v)) {
              for (const val of v) headers.append(k, val);
            } else {
              headers.set(k, v);
            }
          }
          resolve({
            status: res.statusCode ?? 200,
            statusText: res.statusMessage ?? "OK",
            ok: (res.statusCode ?? 200) >= 200 && (res.statusCode ?? 200) < 300,
            headers,
            buffer: body,
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          });
        });
        res.on("error", (err) => {
          fail(err);
        });
        res.on("aborted", () => {
          fail(new Error("Response was aborted by server or network transport."));
        });
      }
    );
    req.on("socket", (socket) => {
      socket.on("connect", () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        resetIdleTimer();
      });
      if (isHttps) {
        socket.on("secureConnect", () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          resetIdleTimer();
        });
      }
    });
    req.on("error", (err) => {
      fail(err);
    });
    req.on("abort", () => {
      fail(new Error("Request was aborted."));
    });
    req.end();
  });
}
async function fetchBytes(urlString, fetchImplOrOptions, allowInsecureHttpForTestsArg, extraOptions) {
  let fetchImpl;
  let allowInsecure = false;
  let dnsLookup;
  let maxSizeBytes;
  let exactSizeBytes;
  let maxHeaderSizeBytes;
  let timeoutMs;
  let idleTimeoutMs;
  let connectTimeoutMs;
  if (typeof fetchImplOrOptions === "function") {
    fetchImpl = fetchImplOrOptions;
    allowInsecure = allowInsecureHttpForTestsArg ?? false;
    dnsLookup = extraOptions?.dnsLookup;
    maxSizeBytes = extraOptions?.maxSizeBytes;
    exactSizeBytes = extraOptions?.exactSizeBytes;
    maxHeaderSizeBytes = extraOptions?.maxHeaderSizeBytes;
    timeoutMs = extraOptions?.timeoutMs;
    idleTimeoutMs = extraOptions?.idleTimeoutMs;
    connectTimeoutMs = extraOptions?.connectTimeoutMs;
  } else if (fetchImplOrOptions && typeof fetchImplOrOptions === "object") {
    fetchImpl = fetchImplOrOptions.fetchImpl;
    allowInsecure = fetchImplOrOptions.allowInsecureHttpForTests ?? false;
    dnsLookup = fetchImplOrOptions.dnsLookup;
    maxSizeBytes = fetchImplOrOptions.maxSizeBytes;
    exactSizeBytes = fetchImplOrOptions.exactSizeBytes;
    maxHeaderSizeBytes = fetchImplOrOptions.maxHeaderSizeBytes;
    timeoutMs = fetchImplOrOptions.timeoutMs;
    idleTimeoutMs = fetchImplOrOptions.idleTimeoutMs;
    connectTimeoutMs = fetchImplOrOptions.connectTimeoutMs;
  }
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const effectiveIdleTimeoutMs = idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const effectiveConnectTimeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const effectiveMaxHeaderSizeBytes = maxHeaderSizeBytes ?? MAX_HEADER_SIZE_BYTES;
  const startTimestamp = Date.now();
  const deadline = startTimestamp + effectiveTimeoutMs;
  let currentUrl = assertTransport(urlString, allowInsecure);
  let redirectsRemaining = 5;
  while (true) {
    const now = Date.now();
    const remainingDeadline = deadline - now;
    if (remainingDeadline <= 0) {
      throw new Error(
        `Download exceeded absolute request deadline of ${effectiveTimeoutMs}ms for ${currentUrl.toString()}`
      );
    }
    const resolved = await validateAndResolveDestination(currentUrl, {
      allowInsecureHttpForTests: allowInsecure,
      dnsLookup
    });
    let response;
    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(
          new Error(`Download exceeded absolute request deadline of ${effectiveTimeoutMs}ms`)
        );
      }, remainingDeadline);
      try {
        const resp = await fetchImpl(currentUrl.toString(), {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: {
            Accept: "application/json, application/octet-stream;q=0.9, */*;q=0.8",
            "User-Agent": "resin-installer"
          },
          signal: controller.signal
        });
        let headerBytesEstimate = 0;
        resp.headers.forEach((v, k) => {
          headerBytesEstimate += k.length + v.length + 4;
        });
        if (headerBytesEstimate > effectiveMaxHeaderSizeBytes) {
          throw new Error(
            `Response headers (${headerBytesEstimate} bytes) exceeded maximum allowed size of ${effectiveMaxHeaderSizeBytes} bytes.`
          );
        }
        const clHeader = resp.headers.get("content-length");
        let expectedCl;
        if (clHeader !== null) {
          const parsed = Number.parseInt(clHeader, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            expectedCl = parsed;
            if (maxSizeBytes !== void 0 && parsed > maxSizeBytes) {
              throw new Error(
                `Response Content-Length ${parsed} exceeds maximum allowed size of ${maxSizeBytes} bytes.`
              );
            }
            if (exactSizeBytes !== void 0 && parsed !== exactSizeBytes) {
              throw new Error(
                `Response Content-Length ${parsed} does not match expected exact size of ${exactSizeBytes} bytes.`
              );
            }
          }
        }
        let bodyBuf;
        if (resp.body && typeof resp.body.getReader === "function") {
          const reader = resp.body.getReader();
          const chunks = [];
          let total = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                total += value.length;
                if (maxSizeBytes !== void 0 && total > maxSizeBytes) {
                  reader.cancel();
                  throw new Error(
                    `Response body exceeded maximum allowed size of ${maxSizeBytes} bytes (chunk overflow).`
                  );
                }
                chunks.push(value);
              }
            }
          } finally {
            reader.releaseLock();
          }
          bodyBuf = Buffer.concat(chunks);
        } else {
          const ab = await resp.arrayBuffer();
          if (maxSizeBytes !== void 0 && ab.byteLength > maxSizeBytes) {
            throw new Error(
              `Response body exceeded maximum allowed size of ${maxSizeBytes} bytes (chunk overflow).`
            );
          }
          if (exactSizeBytes !== void 0 && ab.byteLength !== exactSizeBytes) {
            throw new Error(
              `Response body exceeded expected exact size of ${exactSizeBytes} bytes.`
            );
          }
          bodyBuf = Buffer.from(ab);
        }
        if (exactSizeBytes !== void 0 && bodyBuf.length !== exactSizeBytes) {
          throw new Error(
            `Response body size mismatch: expected ${exactSizeBytes} bytes, received ${bodyBuf.length} bytes.`
          );
        }
        if (expectedCl !== void 0 && bodyBuf.length !== expectedCl) {
          throw new Error(
            `Response body size ${bodyBuf.length} does not match Content-Length header ${expectedCl}.`
          );
        }
        response = {
          status: resp.status,
          statusText: resp.statusText,
          ok: resp.ok,
          headers: resp.headers,
          buffer: bodyBuf,
          arrayBuffer: async () => {
            const ab = new ArrayBuffer(bodyBuf.length);
            new Uint8Array(ab).set(bodyBuf);
            return ab;
          }
        };
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await nodePinnedFetch(currentUrl, resolved.address, resolved.family, {
        maxSizeBytes,
        exactSizeBytes,
        maxHeaderSizeBytes: effectiveMaxHeaderSizeBytes,
        timeoutMs: remainingDeadline,
        idleTimeoutMs: effectiveIdleTimeoutMs,
        connectTimeoutMs: effectiveConnectTimeoutMs
      });
    }
    if (response.status === 401 || response.status === 407 || response.headers.has("www-authenticate") || response.headers.has("proxy-authenticate")) {
      throw new Error(
        `Public release download rejected authentication challenge (${response.status}) from ${currentUrl.toString()}. Anonymous public downloads cannot authenticate or send credentials to session-bound endpoints.`
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `Release download redirect for ${currentUrl.toString()} omitted a Location header.`
        );
      }
      if (redirectsRemaining <= 0) {
        throw new Error(
          `Public release download exceeded the maximum redirect count of 5. Last target: ${location}`
        );
      }
      redirectsRemaining -= 1;
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(
          `Public release download encountered malformed redirect URL '${location}' from ${currentUrl.toString()}`
        );
      }
      nextUrl = assertTransport(nextUrl.toString(), allowInsecure);
      if (nextUrl.username || nextUrl.password || SENSITIVE_QUERY_PARAM_REGEX.test(nextUrl.search)) {
        throw new Error(
          `Public release download rejected redirect to private or session-bound endpoint: ${nextUrl.toString()}`
        );
      }
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch release artifact from ${currentUrl.toString()}: ${response.status} ${response.statusText}`
      );
    }
    if (response.buffer) {
      return response.buffer;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
var BUNDLED_TRUSTED_KEY_ALLOWED_FIELDS = {
  keyId: true,
  algorithm: true,
  trustDomain: true,
  publicKeyPem: true,
  publicKeyHex: true,
  publicKeyFingerprintSha256: true
};
var OVERRIDE_TRUSTED_KEY_ALLOWED_FIELDS = {
  keyId: true,
  publicKeyHex: true
};
function parseBundledReleaseTrust(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Bundled release trust root must be a JSON object.");
  }
  const root = parsed;
  if (root.schemaVersion !== "2.0.0") {
    throw new Error(
      `Unsupported bundled release trust schemaVersion '${String(root.schemaVersion)}' (expected '2.0.0').`
    );
  }
  if (root.trustDomain !== "production") {
    throw new Error(
      `Unsupported bundled release trust trustDomain '${String(root.trustDomain)}' (expected 'production').`
    );
  }
  if (!Array.isArray(root.trustedKeys) || root.trustedKeys.length === 0) {
    throw new Error("Bundled release trust requires a non-empty 'trustedKeys' array.");
  }
  const seenKeyIds = /* @__PURE__ */ new Set();
  const seenKeyHexes = /* @__PURE__ */ new Set();
  const validatedKeys = [];
  for (let i = 0; i < root.trustedKeys.length; i++) {
    const entry = root.trustedKeys[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Bundled trustedKeys[${i}] must be a JSON object.`);
    }
    const record = entry;
    for (const key of Object.keys(record)) {
      if (!BUNDLED_TRUSTED_KEY_ALLOWED_FIELDS[key]) {
        throw new Error(`Bundled trustedKeys[${i}] contains forbidden property '${key}'.`);
      }
    }
    const keyId = record.keyId;
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new Error(`Bundled trustedKeys[${i}] is missing a valid 'keyId'.`);
    }
    if (seenKeyIds.has(keyId)) {
      throw new Error(`Duplicate trusted keyId '${keyId}' in bundled release trust.`);
    }
    seenKeyIds.add(keyId);
    if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
      throw new Error(`Trusted release key '${keyId}' is revoked.`);
    }
    if (record.algorithm !== "Ed25519") {
      throw new Error(
        `Trusted release key '${keyId}' has unsupported algorithm '${String(record.algorithm)}' (expected 'Ed25519').`
      );
    }
    if (record.trustDomain !== "production") {
      throw new Error(
        `Release key '${keyId}' belongs to '${String(record.trustDomain)}' trust domain, not 'production'.`
      );
    }
    if (typeof record.publicKeyPem !== "string" || !record.publicKeyPem.trim()) {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyPem'.`);
    }
    let keyObject;
    try {
      keyObject = crypto3.createPublicKey(record.publicKeyPem.trim());
    } catch (error) {
      throw new Error(
        `Trusted release key '${keyId}' has invalid publicKeyPem: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (keyObject.asymmetricKeyType !== "ed25519") {
      throw new Error(
        `Trusted release key '${keyId}' has unexpected asymmetricKeyType '${keyObject.asymmetricKeyType}'.`
      );
    }
    const der = keyObject.export({ type: "spki", format: "der" });
    const rawPublicKey = der.subarray(-32);
    const derivedHex = rawPublicKey.toString("hex").toLowerCase();
    const derivedFingerprint = crypto3.createHash("sha256").update(der).digest("hex").toLowerCase();
    if (typeof record.publicKeyHex !== "string") {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyHex'.`);
    }
    const normalizedDeclaredHex = record.publicKeyHex.trim().toLowerCase();
    if (normalizedDeclaredHex !== derivedHex) {
      throw new Error(
        `Trusted release key '${keyId}' publicKeyHex does not match publicKeyPem (expected ${derivedHex}, got ${normalizedDeclaredHex}).`
      );
    }
    if (typeof record.publicKeyFingerprintSha256 !== "string") {
      throw new Error(`Trusted release key '${keyId}' is missing 'publicKeyFingerprintSha256'.`);
    }
    const normalizedDeclaredFingerprint = record.publicKeyFingerprintSha256.trim().toLowerCase();
    if (normalizedDeclaredFingerprint !== derivedFingerprint) {
      throw new Error(
        `Trusted release key '${keyId}' publicKeyFingerprintSha256 mismatch (expected ${derivedFingerprint}, got ${normalizedDeclaredFingerprint}).`
      );
    }
    if (seenKeyHexes.has(derivedHex)) {
      throw new Error(`Duplicate public root key hex in bundled release trust: ${derivedHex}`);
    }
    seenKeyHexes.add(derivedHex);
    validatedKeys.push({
      keyId,
      publicKeyHex: derivedHex
    });
  }
  return validatedKeys;
}
function parseTrustedKeysJsonOverride(overrideJson) {
  let parsed;
  try {
    parsed = JSON.parse(overrideJson);
  } catch (error) {
    throw new Error(
      `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("RESIN_TRUSTED_RELEASE_PUBLIC_KEYS must be a non-empty array of key records.");
  }
  const seenKeyIds = /* @__PURE__ */ new Set();
  const seenKeyHexes = /* @__PURE__ */ new Set();
  const validatedKeys = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] must be a JSON object with keyId and publicKeyHex.`
      );
    }
    const record = entry;
    for (const key of Object.keys(record)) {
      if (!OVERRIDE_TRUSTED_KEY_ALLOWED_FIELDS[key]) {
        throw new Error(
          `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] contains forbidden property '${key}'.`
        );
      }
    }
    const keyId = record.keyId;
    if (typeof keyId !== "string" || !keyId.trim()) {
      throw new Error(`RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] is missing a valid 'keyId'.`);
    }
    if (seenKeyIds.has(keyId)) {
      throw new Error(`Duplicate trusted keyId '${keyId}' in release trust override.`);
    }
    seenKeyIds.add(keyId);
    if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
      throw new Error(`Trusted release key '${keyId}' is revoked.`);
    }
    const publicKeyHex = record.publicKeyHex;
    if (typeof publicKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex.trim())) {
      throw new Error(
        `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS[${i}] requires a 64-character hex publicKeyHex.`
      );
    }
    const normalizedHex = publicKeyHex.trim().toLowerCase();
    if (seenKeyHexes.has(normalizedHex)) {
      throw new Error(`Duplicate public root key hex in release trust override: ${normalizedHex}`);
    }
    seenKeyHexes.add(normalizedHex);
    validatedKeys.push({
      keyId,
      publicKeyHex: normalizedHex
    });
  }
  return validatedKeys;
}
async function loadBundledTrustedReleaseKeys(customTrustData) {
  if (customTrustData !== void 0) {
    if (typeof customTrustData === "string") {
      return parseTrustedKeysJsonOverride(customTrustData);
    }
    if (typeof customTrustData === "object" && customTrustData !== null && "RESIN_TRUSTED_RELEASE_PUBLIC_KEYS" in customTrustData) {
      const rawOverride = customTrustData.RESIN_TRUSTED_RELEASE_PUBLIC_KEYS;
      if (typeof rawOverride === "string") {
        return parseTrustedKeysJsonOverride(rawOverride);
      }
    }
    return parseBundledReleaseTrust(customTrustData);
  }
  const bundledTrustPath = new URL("../release-trust.json", import.meta.url);
  let rawBytes;
  try {
    rawBytes = await fs3.readFile(bundledTrustPath);
  } catch (error) {
    throw new Error(
      `Failed to load bundled release trust file at ${bundledTrustPath.pathname}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parsed = parseJson(rawBytes, "Bundled release trust");
  return parseBundledReleaseTrust(parsed);
}
function platformKey(platform) {
  const arch = platform.arch === "x86_64" ? "x64" : platform.arch === "aarch64" ? "arm64" : platform.arch;
  if (platform.isWsl || platform.os === "wsl") return `wsl-${arch}`;
  return `${platform.os}-${arch}`;
}
function resolveReleaseRefUrl(rawRef, baseUrlString) {
  try {
    const parsedRef = new URL(rawRef);
    return parsedRef.toString();
  } catch {
  }
  let base;
  try {
    base = new URL(baseUrlString);
  } catch {
    return rawRef;
  }
  const v1Marker = "/releases/v1/";
  const markerIndex = base.pathname.indexOf(v1Marker);
  if (markerIndex > 0 && rawRef.startsWith(v1Marker)) {
    const prefix = base.pathname.slice(0, markerIndex);
    const combinedPath = `${prefix}${rawRef}`;
    return new URL(combinedPath, base.origin).toString();
  }
  return new URL(rawRef, base).toString();
}
function resolveDenoAsset(descriptor, platform, manifestUrl, allowInsecureHttpForTests = false) {
  if (!descriptor || !descriptor.required) {
    throw new Error("Signed release manifest is missing the required Deno runtime descriptor.");
  }
  if (descriptor.version !== PINNED_DENO_VERSION) {
    throw new Error(
      `Signed release manifest requires Deno '${descriptor.version}' but this client is pinned to '${PINNED_DENO_VERSION}'.`
    );
  }
  const key = platformKey(platform);
  const linuxFallback = key.startsWith("wsl-") ? `linux-${key.slice(4)}` : void 0;
  const asset = descriptor.assets[key] ?? (linuxFallback ? descriptor.assets[linuxFallback] : void 0);
  if (!asset) throw new Error(`No pinned Deno runtime asset exists for '${key}'.`);
  const pinnedRuntime = PINNED_DENO_RUNTIMES[key] ?? (linuxFallback ? PINNED_DENO_RUNTIMES[linuxFallback] : void 0);
  if (pinnedRuntime && !allowInsecureHttpForTests) {
    if (typeof asset.sizeBytes === "number" && asset.sizeBytes !== pinnedRuntime.sizeBytes) {
      throw new Error(
        `Deno runtime asset size mismatch for '${key}': expected ${pinnedRuntime.sizeBytes} bytes, got ${asset.sizeBytes} bytes.`
      );
    }
    const assetSha = normalizeSha2562(asset.sha256);
    if (assetSha !== pinnedRuntime.sha256) {
      throw new Error(
        `Deno runtime asset sha256 mismatch for '${key}': expected ${pinnedRuntime.sha256}, got ${assetSha}.`
      );
    }
  }
  const exactSize = asset.sizeBytes ?? pinnedRuntime?.sizeBytes;
  if (typeof exactSize !== "number" || !Number.isSafeInteger(exactSize) || exactSize <= 0) {
    throw new Error(`Deno runtime asset '${key}' is missing a valid positive sizeBytes.`);
  }
  let assetUrl = asset.url;
  if (manifestUrl) {
    try {
      assetUrl = resolveReleaseRefUrl(asset.url, manifestUrl);
    } catch {
    }
  }
  assertTransport(assetUrl, allowInsecureHttpForTests);
  assertSha256(asset.sha256, `Deno ${descriptor.version} asset`);
  return {
    ...asset,
    url: assetUrl,
    version: descriptor.version,
    sizeBytes: exactSize
  };
}
async function resolveProductionRelease(options) {
  const fetchImpl = options.fetchImpl;
  const allowInsecure = options.allowInsecureHttpForTests === true;
  const channelUrl = options.channelUrl ?? DEFAULT_PRODUCTION_CHANNEL_URL;
  const trustedReleaseKeys = options.trustedReleaseKeys?.length ? [...options.trustedReleaseKeys] : await loadBundledTrustedReleaseKeys();
  if (trustedReleaseKeys.length === 0) {
    throw new Error(
      "Production release resolution requires at least one independently pinned public key."
    );
  }
  const fetchOptions = {
    allowInsecureHttpForTests: allowInsecure,
    fetchImpl,
    dnsLookup: options.dnsLookup
  };
  const channelBytes = await fetchBytes(channelUrl, {
    ...fetchOptions,
    maxSizeBytes: MAX_CHANNEL_SIZE_BYTES
  });
  const channelSha256 = sha256Hex2(channelBytes);
  const channel = parseJson(channelBytes, "Release channel metadata");
  const channelResult = verifyChannelMetadata(channel, {
    channel: options.channel ?? "stable",
    currentInstalledVersion: options.currentInstalledVersion || options.currentActiveVersion,
    minSupportedVersion: options.minSupportedVersion,
    trustedReleaseKeys,
    now: options.now
  });
  if (!channelResult.valid) {
    throw new Error(`Signed release channel rejected: ${channelResult.errors.join("; ")}`);
  }
  if (!channelResult.targetVersion || !channelResult.manifestUrl || !channelResult.manifestDigest) {
    throw new Error(
      "Signed release channel is incomplete: version, manifest URL, and digest are required."
    );
  }
  const targetVersion = channelResult.targetVersion;
  const rawManifestUrl = channelResult.manifestUrl;
  let resolvedManifestUrl;
  try {
    resolvedManifestUrl = resolveReleaseRefUrl(rawManifestUrl, channelUrl);
  } catch {
    throw new Error(
      `Release channel specified invalid manifest URL '${rawManifestUrl}' relative to '${channelUrl}'.`
    );
  }
  assertTransport(resolvedManifestUrl, allowInsecure);
  const expectedManifestDigest = assertSha256(channelResult.manifestDigest, "Release manifest");
  const manifestBytes = await fetchBytes(resolvedManifestUrl, {
    ...fetchOptions,
    maxSizeBytes: MAX_MANIFEST_SIZE_BYTES
  });
  const actualManifestDigest = sha256Hex2(manifestBytes);
  if (actualManifestDigest !== expectedManifestDigest) {
    throw new Error(
      `Release manifest digest mismatch: expected sha256:${expectedManifestDigest}, got sha256:${actualManifestDigest}`
    );
  }
  const manifest = parseJson(manifestBytes, "Release manifest");
  const manifestResult = verifyManifest(manifest, {
    expectedDigest: expectedManifestDigest,
    rawManifestBytes: manifestBytes,
    currentInstalledVersion: options.currentInstalledVersion || options.currentActiveVersion,
    minSupportedVersion: options.minSupportedVersion,
    trustedReleaseKeys,
    revokedKeyIds: channel.revokedKeyIds ?? channelResult.revokedKeyIds,
    now: options.now
  });
  if (!manifestResult.valid) {
    throw new Error(`Signed release manifest rejected: ${manifestResult.errors.join("; ")}`);
  }
  if (manifest.version !== targetVersion) {
    throw new Error(
      `Release manifest version '${manifest.version}' does not match channel target version '${targetVersion}'.`
    );
  }
  const releaseAsset = selectPlatformAsset(manifest, options.platform);
  if (typeof releaseAsset.sizeBytes !== "number" || !Number.isSafeInteger(releaseAsset.sizeBytes) || releaseAsset.sizeBytes <= 0) {
    throw new Error(
      `Release manifest specified invalid sizeBytes for asset '${releaseAsset.filename}'.`
    );
  }
  if (releaseAsset.sizeBytes > MAX_RELEASE_SIZE_BYTES) {
    throw new Error(
      `Release asset '${releaseAsset.filename}' size (${releaseAsset.sizeBytes} bytes) exceeds hard cap of ${MAX_RELEASE_SIZE_BYTES} bytes.`
    );
  }
  let releaseAssetUrl;
  try {
    releaseAssetUrl = resolveReleaseRefUrl(
      releaseAsset.url || releaseAsset.path,
      resolvedManifestUrl
    );
  } catch {
    throw new Error(
      `Release manifest specified invalid asset URL '${releaseAsset.url || releaseAsset.path}' relative to '${resolvedManifestUrl}'.`
    );
  }
  assertTransport(releaseAssetUrl, allowInsecure);
  assertSha256(releaseAsset.sha256, "Release asset");
  const denoAsset = resolveDenoAsset(
    manifest.runtimes?.deno,
    options.platform,
    resolvedManifestUrl,
    allowInsecure
  );
  const signingKeyIds = (manifest.signatures ?? []).map((s) => s.keyId).filter((k) => typeof k === "string" && k.length > 0);
  const identity = typeof manifest.releaseIdentity === "object" && manifest.releaseIdentity !== null ? manifest.releaseIdentity : void 0;
  return {
    channel,
    manifest,
    version: targetVersion,
    releaseAsset,
    releaseAssetUrl,
    denoAsset,
    provenance: {
      version: targetVersion,
      channelUrl,
      manifestUrl: resolvedManifestUrl,
      channelSha256,
      manifestSha256: actualManifestDigest,
      releaseAssetUrl,
      releaseAssetSha256: normalizeSha2562(releaseAsset.sha256),
      releaseAssetSizeBytes: releaseAsset.sizeBytes,
      repository: typeof identity?.repository === "string" ? identity.repository : void 0,
      commitSha: typeof identity?.commitSha === "string" ? identity.commitSha : void 0,
      signingKeyIds,
      deno: {
        version: denoAsset.version,
        url: denoAsset.url,
        sha256: normalizeSha2562(denoAsset.sha256),
        sizeBytes: denoAsset.sizeBytes
      }
    }
  };
}

// apps/cli/src/installer/bootstrap-entry.ts
var PRODUCTION_RELEASE_TRUST_RECORD = Object.freeze({
  schemaVersion: "2.0.0",
  trustDomain: "production",
  trustedKeys: Object.freeze([
    Object.freeze({
      keyId: "resin-release-2026a",
      algorithm: "Ed25519",
      trustDomain: "production",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9ZI1qv+S+txsMLDf1WylTCionlq7H6V6t9XqaD1geFE=\n-----END PUBLIC KEY-----\n",
      publicKeyHex: "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
      publicKeyFingerprintSha256: "a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359"
    })
  ])
});
var DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 15e3;
var DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES = 64 * 1024;
var MAX_RELEASE_ASSET_HARD_CAP_BYTES = 2 * 1024 * 1024 * 1024;
var DEFAULT_ONBOARDING_TIMEOUT_MS = 3e5;
var DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES = 64 * 1024;
async function defaultHealthCheckRunner(cliPath, args = ["version"], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES;
  let child;
  try {
    child = child_process.spawn(cliPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process3.env, ...options.env || {} }
    });
  } catch (err) {
    return {
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to spawn health check process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`,
      checkedPath: cliPath
    };
  }
  let stdout = "";
  let stderr = "";
  let totalBytes = 0;
  let settled = false;
  let timer = null;
  return new Promise((resolve) => {
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish({
        passed: false,
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: stderr ? `${stderr.trim()}
Health check timed out after ${timeoutMs}ms` : `Health check timed out after ${timeoutMs}ms`,
        timedOut: true,
        checkedPath: cliPath
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      totalBytes += chunk.length;
      stdout += chunk.toString("utf8");
      if (totalBytes > maxOutputBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        finish({
          passed: false,
          exitCode: 1,
          stdout: stdout.slice(0, maxOutputBytes).trim(),
          stderr: `Health check output exceeded maximum size of ${maxOutputBytes} bytes`,
          outputOverflow: true,
          checkedPath: cliPath
        });
      }
    });
    child.stderr?.on("data", (chunk) => {
      totalBytes += chunk.length;
      stderr += chunk.toString("utf8");
      if (totalBytes > maxOutputBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
        }
        finish({
          passed: false,
          exitCode: 1,
          stdout: stdout.slice(0, maxOutputBytes).trim(),
          stderr: `Health check output exceeded maximum size of ${maxOutputBytes} bytes`,
          outputOverflow: true,
          checkedPath: cliPath
        });
      }
    });
    child.on("error", (err) => {
      finish({
        passed: false,
        exitCode: 1,
        stdout: stdout.trim(),
        stderr: err instanceof Error ? err.message : String(err),
        checkedPath: cliPath
      });
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      finish({
        passed: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        checkedPath: cliPath
      });
    });
  });
}
async function isAlreadyInitialized(resinHome, fsBridge = defaultFsBridge) {
  const candidatePaths = [
    path3.join(resinHome, "state", "device-token.json"),
    path3.join(resinHome, "state", "install-journal.json"),
    path3.join(resinHome, "journal.json")
  ];
  for (const candidate of candidatePaths) {
    try {
      if (await fsBridge.exists(candidate)) {
        return true;
      }
    } catch {
    }
  }
  return false;
}
async function detectOnboardingSkipReason(options) {
  if (options.skipOnboarding) {
    return "Explicitly skipped via skipOnboarding option";
  }
  if (options.autoOnboard === false) {
    return "Explicitly disabled via autoOnboard option";
  }
  const env = options.env ?? process3.env;
  if (env.RESIN_NO_ONBOARD === "1" || env.RESIN_NO_ONBOARD === "true") {
    return "Disabled via RESIN_NO_ONBOARD environment variable";
  }
  if (env.RESIN_SKIP_ONBOARDING === "1" || env.RESIN_SKIP_ONBOARDING === "true") {
    return "Disabled via RESIN_SKIP_ONBOARDING environment variable";
  }
  if (options.isInteractive === false) {
    return "Explicitly marked non-interactive";
  }
  const ciVariables = [
    env.CI,
    env.CONTINUOUS_INTEGRATION,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.TRAVIS,
    env.CIRCLECI,
    env.JENKINS_URL
  ];
  if (ciVariables.some(
    (value) => typeof value === "string" && value.length > 0 && value !== "0" && value.toLowerCase() !== "false"
  )) {
    return "CI environment detected";
  }
  if (env.DEBIAN_FRONTEND === "noninteractive" || env.RESIN_NON_INTERACTIVE === "1" || env.RESIN_NON_INTERACTIVE === "true") {
    return "Non-interactive environment detected";
  }
  const allowRoot = env.RESIN_ALLOW_ROOT === "1" || env.RESIN_ALLOW_ROOT === "true";
  const isRoot = options.isRoot ?? (options.getuid !== void 0 ? options.getuid() === 0 : typeof process3.getuid === "function" ? process3.getuid() === 0 : false);
  if (isRoot && !allowRoot) {
    return "Running in root/sudo context (avoiding root-owned browser launch or user config)";
  }
  return null;
}
async function defaultOnboardingRunner(cliPath, args = ["init", "--auto-approve"], options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES;
  const interactive = options.interactive ?? Boolean(process3.stdin?.isTTY && process3.stdout?.isTTY);
  const stdio = options.stdio ?? (interactive ? "inherit" : ["ignore", "pipe", "pipe"]);
  let child;
  try {
    child = child_process.spawn(cliPath, args, {
      stdio,
      env: { ...process3.env, ...options.env || {} }
    });
  } catch (err) {
    return {
      attempted: true,
      skipped: false,
      success: false,
      exitCode: 1,
      error: `Failed to spawn onboarding process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`
    };
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer = null;
  return new Promise((resolve) => {
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
            }
          }, 2e3).unref();
        } catch {
        }
        finish({
          attempted: true,
          skipped: false,
          success: false,
          exitCode: 124,
          error: `Onboarding process timed out after ${timeoutMs}ms`,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      }, timeoutMs);
    }
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        const remainingBytes = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout));
        if (remainingBytes > 0) {
          stdout += Buffer.from(text).subarray(0, remainingBytes).toString("utf8");
        }
        if (text.length > 0) {
          options.logger?.(text.replace(/\n$/, ""));
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        const remainingBytes = Math.max(0, maxOutputBytes - Buffer.byteLength(stderr));
        if (remainingBytes > 0) {
          stderr += Buffer.from(text).subarray(0, remainingBytes).toString("utf8");
        }
        if (text.length > 0) {
          options.logger?.(text.replace(/\n$/, ""));
        }
      });
    }
    child.on("error", (err) => {
      finish({
        attempted: true,
        skipped: false,
        success: false,
        exitCode: 1,
        error: `Failed to spawn onboarding process '${cliPath}': ${err instanceof Error ? err.message : String(err)}`,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
    child.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      finish({
        attempted: true,
        skipped: false,
        success: exitCode === 0,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: exitCode === 0 ? void 0 : `Onboarding process exited with code ${exitCode}`
      });
    });
  });
}
function resolveTrustedReleaseKeys(options) {
  const isTestMode = Boolean(options.allowInsecureHttpForTests);
  const isOverrideAllowed = isTestMode || Boolean(options.allowOverrides);
  if (options.trustedReleaseKeys && options.trustedReleaseKeys.length > 0) {
    for (const key of options.trustedReleaseKeys) {
      if (REVOKED_RELEASE_KEY_IDS.includes(key.keyId)) {
        throw new Error(`Trusted release key '${key.keyId}' is revoked.`);
      }
    }
    if (!isOverrideAllowed) {
      throw new Error("Custom trusted release keys require explicit programmatic override opt-in.");
    }
    return [...options.trustedReleaseKeys];
  }
  const jsonOverride = options.trustedKeysJson;
  if (jsonOverride && jsonOverride.trim().length > 0) {
    if (!isOverrideAllowed) {
      throw new Error(
        "Custom trusted release keys JSON requires explicit programmatic override opt-in."
      );
    }
    return parseTrustedKeysJsonOverride(jsonOverride.trim());
  }
  return parseBundledReleaseTrust(PRODUCTION_RELEASE_TRUST_RECORD);
}
function validateChannelUrl(channelUrl, allowInsecureHttpForTests = false, isOverrideAllowed = false) {
  let parsed;
  try {
    parsed = new URL(channelUrl);
  } catch (err) {
    throw new Error(
      `Invalid release channel URL '${channelUrl}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const isDefaultUrl = channelUrl === DEFAULT_PRODUCTION_CHANNEL_URL;
  if (!isDefaultUrl && !isOverrideAllowed) {
    throw new Error(
      `Custom release channel URL '${channelUrl}' requires explicit override opt-in.`
    );
  }
  if (parsed.protocol === "http:") {
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.");
    if (!allowInsecureHttpForTests || !isLoopback) {
      throw new Error(
        `Insecure HTTP channel URL '${channelUrl}' is prohibited. HTTP is only permitted for local loopback test endpoints.`
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported protocol '${parsed.protocol}' in channel URL '${channelUrl}'. Expected https: (or http: for loopback tests).`
    );
  }
  return channelUrl;
}
async function rollbackBootstrapActivation(options) {
  const { resinHome, previousActiveVersion, installedVersion, fsBridge, logger } = options;
  if (previousActiveVersion) {
    if (previousActiveVersion !== installedVersion) {
      try {
        await rollbackActiveVersion({
          resinHome,
          targetVersion: previousActiveVersion,
          fsBridge,
          logger
        });
      } catch (error) {
        return {
          restoredVersion: getActiveVersion(resinHome),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    const restoredVersion2 = getActiveVersion(resinHome);
    return restoredVersion2 === previousActiveVersion ? { restoredVersion: restoredVersion2 } : {
      restoredVersion: restoredVersion2,
      error: `Rollback verification failed: expected v${previousActiveVersion}, found ${restoredVersion2 ? `v${restoredVersion2}` : "no active version"}`
    };
  }
  try {
    for (const candidate of [
      path3.join(resinHome, "current"),
      path3.join(resinHome, "current-version"),
      path3.join(resinHome, "version-state.json"),
      path3.join(resinHome, "bin", "resin"),
      path3.join(resinHome, "bin", "resin-daemon"),
      path3.join(resinHome, "bin", "resin-mcp")
    ]) {
      if (await fsBridge.exists(candidate)) {
        await fsBridge.unlink(candidate);
      }
    }
  } catch (error) {
    return {
      restoredVersion: getActiveVersion(resinHome),
      error: error instanceof Error ? error.message : String(error)
    };
  }
  const restoredVersion = getActiveVersion(resinHome);
  return restoredVersion === null ? { restoredVersion } : {
    restoredVersion,
    error: `Fresh install rollback verification failed: active version remains v${restoredVersion}`
  };
}
function resolveCandidateProfiles(shellName) {
  const normShell = (shellName || "").toLowerCase();
  if (normShell === "zsh") {
    return {
      candidates: [".zshrc", ".zprofile", ".zshenv", ".zlogin", ".profile"],
      defaultProfile: ".zshrc"
    };
  }
  if (normShell === "bash") {
    return {
      candidates: [".bashrc", ".bash_profile", ".bash_login", ".profile"],
      defaultProfile: ".bashrc"
    };
  }
  return {
    candidates: [".profile", ".bashrc", ".zshrc"],
    defaultProfile: ".profile"
  };
}
async function configureShellPath(options) {
  const env = options.env ?? process3.env;
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const isPosix = options.isPosix ?? process3.platform !== "win32";
  const resinHome = path3.resolve(options.resinHome);
  const binDir = path3.join(resinHome, "bin");
  const homeDir = path3.resolve(options.homeDir ?? env.HOME ?? os2.homedir());
  if (!isPosix) {
    return {
      attempted: false,
      updated: false,
      alreadyConfigured: false,
      binDir,
      reason: "non-posix"
    };
  }
  const shellRaw = options.shell ?? env.SHELL ?? "";
  const shellName = path3.basename(shellRaw).toLowerCase();
  const { candidates, defaultProfile } = resolveCandidateProfiles(shellName);
  let pathLine;
  const defaultResinHome = path3.join(homeDir, ".resin");
  if (resinHome === defaultResinHome) {
    pathLine = 'export PATH="$HOME/.resin/bin:$PATH"';
  } else if (resinHome.startsWith(homeDir + path3.sep)) {
    const rel = path3.relative(homeDir, binDir).split(path3.sep).join("/");
    pathLine = `export PATH="$HOME/${rel}:$PATH"`;
  } else {
    pathLine = `export PATH="${binDir}:$PATH"`;
  }
  for (const candidate of candidates) {
    const fullCandidatePath = path3.join(homeDir, candidate);
    try {
      if (await fsBridge.exists(fullCandidatePath)) {
        const content = await fsBridge.readFile(fullCandidatePath);
        if (content.includes(".resin/bin") || content.includes(binDir) || content.includes(pathLine)) {
          const profileName2 = `~/${candidate}`;
          return {
            attempted: true,
            updated: false,
            alreadyConfigured: true,
            profilePath: fullCandidatePath,
            profileName: profileName2,
            shell: shellName || void 0,
            binDir,
            pathLine,
            reloadCommand: `source ${profileName2}`
          };
        }
      }
    } catch {
    }
  }
  let targetFile;
  for (const candidate of candidates) {
    const fullCandidatePath = path3.join(homeDir, candidate);
    try {
      if (await fsBridge.exists(fullCandidatePath)) {
        targetFile = candidate;
        break;
      }
    } catch {
    }
  }
  if (!targetFile) {
    targetFile = defaultProfile;
  }
  const targetFullPath = path3.join(homeDir, targetFile);
  const profileName = `~/${targetFile}`;
  const reloadCommand = `source ${profileName}`;
  try {
    let newContent = "";
    if (await fsBridge.exists(targetFullPath)) {
      const existing = await fsBridge.readFile(targetFullPath);
      if (existing.includes(".resin/bin") || existing.includes(binDir) || existing.includes(pathLine)) {
        return {
          attempted: true,
          updated: false,
          alreadyConfigured: true,
          profilePath: targetFullPath,
          profileName,
          shell: shellName || void 0,
          binDir,
          pathLine,
          reloadCommand
        };
      }
      const needsNewline = existing.length > 0 && !existing.endsWith("\n");
      newContent = existing + (needsNewline ? "\n" : "") + pathLine + "\n";
    } else {
      newContent = pathLine + "\n";
    }
    await fsBridge.writeFile(targetFullPath, newContent);
    return {
      attempted: true,
      updated: true,
      alreadyConfigured: false,
      profilePath: targetFullPath,
      profileName,
      shell: shellName || void 0,
      binDir,
      pathLine,
      reloadCommand
    };
  } catch (error) {
    return {
      attempted: true,
      updated: false,
      alreadyConfigured: false,
      profilePath: targetFullPath,
      profileName,
      shell: shellName || void 0,
      binDir,
      pathLine,
      reloadCommand,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
async function bootstrapInstall(options = {}) {
  const env = options.env ?? process3.env;
  const log = options.logger ?? ((msg) => process3.stderr.write(`${msg}
`));
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const isVerbose = Boolean(
    options.verbose || env.RESIN_VERBOSE === "1" || env.RESIN_VERBOSE === "true"
  );
  const logVerbose = (msg) => {
    if (isVerbose) log(msg);
  };
  const isTestMode = Boolean(options.allowInsecureHttpForTests);
  const isOverrideAllowed = isTestMode || Boolean(options.allowOverrides);
  logVerbose("==> Detecting and validating target platform...");
  let platformInfo;
  if (options.platform && "isSupported" in options.platform && typeof options.platform.isSupported === "boolean") {
    platformInfo = options.platform;
  } else if (options.platform) {
    const p = options.platform;
    const normalizedArch = p.arch === "x86_64" ? "x64" : p.arch === "aarch64" ? "arm64" : p.arch;
    const isWslRequested = Boolean(p.isWsl) || p.os === "wsl";
    platformInfo = detectPlatform({
      platform: p.os === "wsl" ? "linux" : p.os,
      arch: normalizedArch,
      env: options.env ? {
        ...process3.env,
        ...options.env,
        RESIN_IS_WSL: isWslRequested ? "1" : options.env.RESIN_IS_WSL
      } : process3.env
    });
  } else {
    platformInfo = detectPlatform();
  }
  if (!platformInfo.isSupported) {
    throw new UnsupportedPlatformError(
      platformInfo,
      `Unsupported platform '${platformInfo.platform}'. Resin requires 64-bit x86_64 or arm64 on Linux, macOS, or Windows WSL2.`
    );
  }
  const homeDir = options.customHome ?? env.HOME ?? os2.homedir();
  const resinHome = options.resinHome ?? env.RESIN_HOME ?? path3.join(homeDir, ".resin");
  const downloadsDir = path3.join(resinHome, "downloads");
  const previousActiveVersion = getActiveVersion(resinHome);
  const channel = options.channel ?? "stable";
  const channelUrl = validateChannelUrl(
    options.channelUrl ?? DEFAULT_PRODUCTION_CHANNEL_URL,
    isTestMode,
    isOverrideAllowed
  );
  const trustedReleaseKeys = resolveTrustedReleaseKeys(options);
  logVerbose(`==> Resolving release metadata from channel '${channel}' via ${channelUrl}...`);
  const release = await resolveProductionRelease({
    platform: platformInfo,
    channel,
    channelUrl,
    trustedReleaseKeys,
    allowInsecureHttpForTests: isTestMode,
    fetchImpl: options.fetchImpl,
    dnsLookup: options.dnsLookup,
    currentInstalledVersion: previousActiveVersion ?? void 0,
    currentActiveVersion: previousActiveVersion ?? void 0,
    now: options.now
  });
  logVerbose(`Resolved release version v${release.version} (asset: ${release.releaseAsset.filename})`);
  logVerbose(`==> Fetching release asset from ${release.releaseAssetUrl}...`);
  let releaseBuffer;
  if (options.sourceAssetBuffer) {
    releaseBuffer = options.sourceAssetBuffer;
  } else {
    releaseBuffer = await fetchBytes(release.releaseAssetUrl, {
      fetchImpl: options.fetchImpl,
      dnsLookup: options.dnsLookup,
      allowInsecureHttpForTests: isTestMode,
      exactSizeBytes: release.releaseAsset.sizeBytes,
      maxSizeBytes: release.releaseAsset.sizeBytes ?? MAX_RELEASE_ASSET_HARD_CAP_BYTES
    });
  }
  logVerbose(`==> Verifying release asset '${release.releaseAsset.filename}'...`);
  const downloadedRelease = await downloadAndVerifyAsset({
    asset: release.releaseAsset,
    downloadDir: downloadsDir,
    sourceBuffer: releaseBuffer,
    fsBridge,
    logger: isVerbose ? log : void 0
  });
  if (release.releaseAsset.sizeBytes !== void 0) {
    if (downloadedRelease.sizeBytes !== release.releaseAsset.sizeBytes) {
      throw new Error(
        `Release asset size mismatch: expected ${release.releaseAsset.sizeBytes} bytes, got ${downloadedRelease.sizeBytes} bytes.`
      );
    }
  }
  let downloadedDeno;
  if (release.denoAsset) {
    logVerbose(`==> Fetching required Deno runtime (${release.denoAsset.version})...`);
    let denoBuffer;
    if (options.sourceDenoBuffer) {
      denoBuffer = options.sourceDenoBuffer;
    } else {
      denoBuffer = await fetchBytes(release.denoAsset.url, {
        fetchImpl: options.fetchImpl,
        dnsLookup: options.dnsLookup,
        allowInsecureHttpForTests: isTestMode,
        exactSizeBytes: release.denoAsset.sizeBytes,
        maxSizeBytes: release.denoAsset.sizeBytes ?? 64 * 1024 * 1024
      });
    }
    const denoAssetObj = {
      filename: path3.basename(new URL(release.denoAsset.url).pathname),
      url: release.denoAsset.url,
      sha256: release.denoAsset.sha256,
      sizeBytes: release.denoAsset.sizeBytes
    };
    logVerbose(`==> Verifying Deno runtime package '${denoAssetObj.filename}'...`);
    downloadedDeno = await downloadAndVerifyAsset({
      asset: denoAssetObj,
      downloadDir: downloadsDir,
      sourceBuffer: denoBuffer,
      fsBridge,
      logger: isVerbose ? log : void 0
    });
  }
  logVerbose(`==> Installing release v${release.version} into ${resinHome}...`);
  const installResult = await installReleaseVersion({
    resinHome,
    version: release.version,
    tarballPathOrBuffer: downloadedRelease.path,
    denoRuntime: downloadedDeno && release.denoAsset ? {
      archivePathOrBuffer: downloadedDeno.path,
      version: release.denoAsset.version,
      sha256: release.denoAsset.sha256,
      executable: release.denoAsset.executable
    } : void 0,
    provenance: release.provenance,
    fsBridge,
    logger: isVerbose ? log : void 0
  });
  logVerbose(`==> Activating version v${release.version}...`);
  const switchResult = await switchActiveVersion({
    resinHome,
    targetVersion: release.version,
    fsBridge,
    logger: isVerbose ? log : void 0
  });
  logVerbose("==> Running health check on active version via public bin path...");
  const publicBinPath = path3.join(resinHome, "bin", "resin");
  const checkPath = await fsBridge.exists(publicBinPath) ? publicBinPath : installResult.entryPoints.cli;
  const healthRunner = options.healthCheckRunner ?? defaultHealthCheckRunner;
  let healthCheck;
  try {
    healthCheck = await healthRunner(checkPath, ["version"], {
      timeoutMs: options.healthCheckTimeoutMs,
      maxOutputBytes: options.healthCheckMaxOutputBytes,
      env: options.env
    });
  } catch (error) {
    healthCheck = {
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: `Health check threw exception: ${error instanceof Error ? error.message : String(error)}`,
      checkedPath: checkPath
    };
  }
  if (!healthCheck.passed) {
    log(
      `\u2716 Health check failed: ${healthCheck.stderr || healthCheck.stdout || `exit code ${healthCheck.exitCode ?? 1}`}. Initiating rollback transaction...`
    );
    const rollback = await rollbackBootstrapActivation({
      resinHome,
      previousActiveVersion,
      installedVersion: release.version,
      fsBridge,
      logger: log
    });
    const failureReason = healthCheck.timedOut ? "health check timed out" : healthCheck.outputOverflow ? "health check output overflowed" : `health check exited with code ${healthCheck.exitCode ?? 1}`;
    const rollbackDetail = rollback.error ? ` Rollback error: ${rollback.error}.` : "";
    throw new Error(
      `Installation health check failed (${failureReason}): ${healthCheck.stderr || healthCheck.stdout || "unknown error"}. Active version rolled back to ${rollback.restoredVersion ?? "none"}.${rollbackDetail}`
    );
  }
  log(`\u2714 Verified Resin v${release.version} for ${platformInfo.platform}`);
  log(`\u2714 Installed Resin v${release.version} (${checkPath})`);
  let pathConfig;
  if (!options.skipPathSetup) {
    pathConfig = await configureShellPath({
      resinHome,
      homeDir: options.customHome,
      shell: options.shell,
      env,
      fsBridge,
      logger: log
    });
    if (pathConfig.updated) {
      const displayHome = path3.resolve(options.customHome ?? env.HOME ?? os2.homedir());
      const displayBin = resinHome === path3.join(displayHome, ".resin") ? "~/.resin/bin" : path3.join(resinHome, "bin");
      log(`\u2714 Added ${displayBin} to PATH in ${pathConfig.profileName}`);
    } else if (pathConfig.alreadyConfigured && isVerbose) {
      log(`\u2139 PATH is already configured (${pathConfig.profileName || "active environment"})`);
    } else if (pathConfig.error) {
      log(`\u26A0 Could not update ${pathConfig.profileName}: ${pathConfig.error}`);
    }
  }
  let onboardingResult;
  const localOnly = options.localOnly || env.RESIN_LOCAL_ONLY === "1" || env.RESIN_LOCAL_ONLY === "true";
  const skipReason = await detectOnboardingSkipReason({
    resinHome,
    fsBridge,
    env,
    isInteractive: options.isInteractive,
    skipOnboarding: options.skipOnboarding,
    autoOnboard: options.autoOnboard
  });
  if (skipReason) {
    logVerbose(`\u2139 Skipping automatic onboarding: ${skipReason}`);
    onboardingResult = {
      attempted: false,
      skipped: true,
      skipReason
    };
  } else {
    logVerbose("==> Authorizing this device, configuring detected editors, and starting Resin...");
    const onboardingRunner = options.onboardingRunner ?? defaultOnboardingRunner;
    const onboardingArgs = options.onboardingArgs ? [...options.onboardingArgs] : ["init", "--auto-approve", ...localOnly ? ["--local-only"] : []];
    try {
      onboardingResult = await onboardingRunner(checkPath, onboardingArgs, {
        timeoutMs: options.onboardingTimeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS,
        env: options.env,
        interactive: options.isInteractive,
        logger: isVerbose ? log : void 0
      });
    } catch (error) {
      onboardingResult = {
        attempted: true,
        skipped: false,
        success: false,
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!onboardingResult.success) {
      const detail = onboardingResult.error || onboardingResult.stderr || `exit code ${onboardingResult.exitCode ?? 1}`;
      log(`\u2716 Automatic onboarding did not complete (${detail}). Rolling back activation...`);
      const rollback = await rollbackBootstrapActivation({
        resinHome,
        previousActiveVersion,
        installedVersion: release.version,
        fsBridge,
        logger: log
      });
      const rollbackDetail = rollback.error ? ` Rollback error: ${rollback.error}.` : "";
      throw new Error(
        `Automatic onboarding failed: ${detail}. Active version restored to ${rollback.restoredVersion ?? "none"}.${rollbackDetail} Rerun the same installer to resume; no separate Resin command is required.`
      );
    }
    log("\u2714 Device authorization, editor configuration, and daemon verification completed.");
  }
  if (pathConfig?.updated && pathConfig.reloadCommand) {
    log(`
To get started, reload your shell or run:
  ${pathConfig.reloadCommand}
  resin`);
  } else {
    log("\nRun 'resin' to get started.");
  }
  return {
    success: true,
    version: release.version,
    previousVersion: previousActiveVersion,
    activePath: switchResult.activePath,
    resinHome,
    platform: platformInfo,
    release: {
      channel,
      version: release.version,
      manifestSha256: release.provenance.manifestSha256,
      releaseAssetSha256: release.provenance.releaseAssetSha256,
      signingKeyIds: release.provenance.signingKeyIds
    },
    healthCheck,
    pathConfig,
    onboarding: onboardingResult,
    reinstalled: installResult.installedFiles.length === 0
  };
}
function isMainModule(metaUrl = import.meta.url, argv1) {
  const targetPath = argv1 ?? (typeof process3 !== "undefined" && process3.argv ? process3.argv[1] : void 0);
  if (!targetPath) return false;
  try {
    const resolvedPath = path3.resolve(targetPath);
    const expectedUrl = pathToFileURL(resolvedPath).href;
    return metaUrl === expectedUrl;
  } catch {
    return false;
  }
}
async function runCli(argv = process3.argv.slice(2)) {
  let channel;
  let channelUrl;
  let resinHome;
  let allowInsecureLoopback = false;
  let skipOnboarding = false;
  let autoOnboard;
  let localOnly = false;
  let isInteractive;
  let verbose = false;
  let skipPathSetup = false;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--no-path-update" || arg === "--skip-path-setup") {
      skipPathSetup = true;
    } else if (arg === "--channel") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for argument: --channel");
      }
      channel = argv[++i];
    } else if (arg.startsWith("--channel=")) {
      const val = arg.slice("--channel=".length);
      if (!val) throw new Error("Missing value for argument: --channel");
      channel = val;
    } else if (arg === "--channel-url") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("Missing value for argument: --channel-url");
      }
      channelUrl = argv[++i];
    } else if (arg.startsWith("--channel-url=")) {
      const val = arg.slice("--channel-url=".length);
      if (!val) throw new Error("Missing value for argument: --channel-url");
      channelUrl = val;
    } else if (arg === "--resin-home" || arg === "--home") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(`Missing value for argument: ${arg}`);
      }
      resinHome = argv[++i];
    } else if (arg.startsWith("--resin-home=")) {
      const val = arg.slice("--resin-home=".length);
      if (!val) throw new Error("Missing value for argument: --resin-home");
      resinHome = val;
    } else if (arg.startsWith("--home=")) {
      const val = arg.slice("--home=".length);
      if (!val) throw new Error("Missing value for argument: --home");
      resinHome = val;
    } else if (arg === "--no-onboarding" || arg === "--skip-onboarding") {
      skipOnboarding = true;
    } else if (arg === "--auto-onboard") {
      autoOnboard = true;
    } else if (arg === "--local-only") {
      localOnly = true;
    } else if (arg === "--non-interactive") {
      isInteractive = false;
    } else if (arg === "--allow-insecure-loopback") {
      allowInsecureLoopback = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (help) {
    process3.stderr.write(`Resin Standalone Bootstrap Installer
Usage:
  node install-helper-v1.mjs [options]

Options:
  --channel <name>           Release channel to install (default: stable)
  --channel-url <url>        Custom channel metadata URL (for staging or air-gapped testing)
  --resin-home, --home <dir> Custom Resin installation directory (default: ~/.resin)
  -v, --verbose              Enable detailed progress logs
  --no-path-update           Do not configure PATH in shell profiles
  --json                     Output structured JSON result on stdout
  --no-onboarding            Skip automatic onboarding and device linking
  --auto-onboard             Explicitly enable onboarding (CI safety checks still apply)
  --local-only               Skip cloud pairing and configure local-only MCP
  --non-interactive          Disable interactive prompts and onboarding
  --allow-insecure-loopback  Allow HTTP on loopback for testing
  --help, -h                 Show this help message
`);
    process3.exit(0);
  }
  try {
    const result = await bootstrapInstall({
      channel,
      channelUrl,
      resinHome,
      skipOnboarding,
      autoOnboard,
      localOnly,
      isInteractive,
      verbose,
      skipPathSetup,
      allowInsecureHttpForTests: allowInsecureLoopback,
      allowOverrides: channelUrl !== void 0
    });
    process3.stdout.write(`${JSON.stringify(result, null, 2)}
`);
  } catch (error) {
    process3.stderr.write(
      `Installation failed: ${error instanceof Error ? error.message : String(error)}
`
    );
    process3.exit(1);
  }
}
if (typeof process3 !== "undefined" && process3.argv && process3.argv[1] && isMainModule(import.meta.url, process3.argv[1])) {
  runCli().catch((err) => {
    process3.stderr.write(
      `Fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}
`
    );
    process3.exit(1);
  });
}
export {
  DEFAULT_HEALTH_CHECK_MAX_OUTPUT_BYTES,
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_ONBOARDING_MAX_OUTPUT_BYTES,
  DEFAULT_ONBOARDING_TIMEOUT_MS,
  MAX_RELEASE_ASSET_HARD_CAP_BYTES,
  PRODUCTION_RELEASE_TRUST_RECORD,
  bootstrapInstall,
  configureShellPath,
  defaultHealthCheckRunner,
  defaultOnboardingRunner,
  detectOnboardingSkipReason,
  isAlreadyInitialized,
  isMainModule,
  resolveCandidateProfiles,
  resolveTrustedReleaseKeys,
  runCli,
  validateChannelUrl
};
