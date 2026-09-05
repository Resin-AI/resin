export const COMMAND_PLACEHOLDER_CLASSES: Record<string, string> = {
  $STR: "[^\\s]+",
  $NUM: "-?\\d+(\\.\\d+)?",
  $URL: "https?://[^\\s]+",
  $GLOB: "[^\\s]+",
  $PATH: "[^\\s-][^\\s]*",
  $SRC_FILE: "[^\\s-][^\\s]*",
  $TEST_FILE: "[^\\s-][^\\s]*",
  $CONFIG_FILE: "[^\\s-][^\\s]*",
  $DOC_FILE: "[^\\s-][^\\s]*",
  $BUILD_DIR: "[^\\s-][^\\s]*",
  $TMP_DIR: "[^\\s-][^\\s]*",
};

const placeholderVocabulary = Object.keys(COMMAND_PLACEHOLDER_CLASSES).sort(
  (left, right) => right.length - left.length,
);
const placeholderPattern = new RegExp(
  placeholderVocabulary.map((placeholder) => placeholder.replace("$", "\\$")).join("|"),
  "g",
);

export function isCommandPlaceholderToken(token: string): boolean {
  return token.match(placeholderPattern) !== null;
}

export function tokenizeCommandProfile(profile: string): string[] {
  const trimmed = profile.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export function isTemplatedCommandProfile(profile: string): boolean {
  return tokenizeCommandProfile(profile).some((token) => isCommandPlaceholderToken(token));
}

export function compileCommandProfileArg(token: string): RegExp {
  let source = "";
  let cursor = 0;

  for (const match of token.matchAll(placeholderPattern)) {
    const placeholder = match[0];
    source += token.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source += `(?:${COMMAND_PLACEHOLDER_CLASSES[placeholder]})`;
    cursor = (match.index ?? 0) + placeholder.length;
  }

  source += token.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${source}$`);
}

export function matchCommandProfileArgs(profileArgs: string[], args: string[]): boolean {
  if (profileArgs.length !== args.length) {
    return false;
  }

  return profileArgs.every((profileArg, index) => {
    // This is already one argv element, not a shell command string. Text inputs
    // such as commit messages may contain spaces without adding arguments.
    if (profileArg === "$STR") {
      return args[index].length > 0 && !/[\0\r\n]/.test(args[index]);
    }
    if (!isCommandPlaceholderToken(profileArg)) {
      return profileArg === args[index];
    }
    return compileCommandProfileArg(profileArg).test(args[index]);
  });
}

export function commandProfileAuthorizes(envelopeEntry: string, requested: string): boolean {
  const envelopeTokens = tokenizeCommandProfile(envelopeEntry);
  const requestedTokens = tokenizeCommandProfile(requested);
  if (
    envelopeTokens.length === 0 ||
    requestedTokens.length < envelopeTokens.length ||
    envelopeTokens[0] !== requestedTokens[0]
  ) {
    return false;
  }

  for (let index = 1; index < envelopeTokens.length; index++) {
    const envelopeToken = envelopeTokens[index];
    const requestedToken = requestedTokens[index];
    if (!isCommandPlaceholderToken(envelopeToken)) {
      if (envelopeToken !== requestedToken) {
        return false;
      }
      continue;
    }

    if (isCommandPlaceholderToken(requestedToken)) {
      if (envelopeToken !== requestedToken) {
        return false;
      }
      continue;
    }

    if (!compileCommandProfileArg(envelopeToken).test(requestedToken)) {
      return false;
    }
  }

  return true;
}

export function commandProfileInputs(
  profile: string,
): Array<{ placeholder: string; token: string; index: number }> {
  const tokens = tokenizeCommandProfile(profile);
  const inputs: Array<{ placeholder: string; token: string; index: number }> = [];

  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    for (const match of token.matchAll(placeholderPattern)) {
      inputs.push({ placeholder: match[0], token, index: index - 1 });
    }
  }

  return inputs;
}
