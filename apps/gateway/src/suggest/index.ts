/**
 * `@resin/gateway/suggest`: command-time and prompt-time learned-tool suggestions. Loads only node
 * builtins and the command grammar, so harness hooks can run it per shell command and per prompt.
 */
export {
  type CommandSuggestIndex,
  type CommandSuggestPathOptions,
  type SuggestStep,
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
  parseClaudeCodePromptInput,
  parseOmpHookInput,
  parseOmpPromptInput,
  renderClaudeCodeHookOutput,
  renderClaudeCodePromptOutput,
  renderOmpHookOutput,
} from "./hook-io.js";
export {
  type CommandMatch,
  isCheapLookup,
  isDistinctivePhrase,
  isLoopOrBackground,
  matchCommand,
} from "./match.js";
export {
  MAX_PROMPT_BLOCK_CHARS,
  MAX_PROMPT_TOOLS,
  type PromptSuggestOptions,
  type PromptSuggestRequest,
  type PromptSuggestion,
  rankForPrompt,
  renderPromptBlock,
  suggestForPrompt,
} from "./prompt.js";
export {
  SUGGEST_HARNESSES,
  type SuggestHarness,
  callExample,
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
