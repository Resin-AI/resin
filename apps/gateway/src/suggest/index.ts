/**
 * `@resin/gateway/suggest`: command-time learned-tool suggestions. Loads only node builtins and
 * the command grammar, so harness hooks can run it per shell command.
 */
export {
  type CommandSuggestIndex,
  type CommandSuggestPathOptions,
  type SuggestTool,
  type SuggestToolInput,
  commandSuggestDisabledPath,
  commandSuggestIndexPath,
  parseCommandSuggestIndex,
  readRepositoryTools,
  resolveCommandSuggestDir,
  writeRepositoryTools,
} from "./index-file.js";
export { type SuggestCliIo, runSuggestCli } from "./cli.js";
export {
  type SuggestionShownCounter,
  type SuggestionShownEvent,
  countSuggestionShown,
  setSuggestionShownCounter,
} from "./funnel.js";
export {
  parseClaudeCodeHookInput,
  parseOmpHookInput,
  renderClaudeCodeHookOutput,
  renderOmpHookOutput,
} from "./hook-io.js";
export { type CommandMatch, isDistinctivePhrase, matchCommand } from "./match.js";
export {
  SUGGEST_HARNESSES,
  type SuggestHarness,
  isSuggestHarness,
  renderSuggestion,
} from "./render.js";
export {
  type RepositoryIdentity,
  type RepositoryIdentityResolver,
  repositoryIdentity,
} from "./repository-identity.js";
export {
  MAX_SUGGESTIONS_PER_TOOL_PER_SESSION,
  type SuggestOptions,
  type SuggestRequest,
  type Suggestion,
  commandSuggestionsEnabled,
  setCommandSuggestionsEnabled,
  suggestForCommand,
  suggestionsDisabledByEnv,
} from "./suggest.js";
