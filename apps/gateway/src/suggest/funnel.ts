/**
 * Counter hook for the discovery funnel: called once per suggestion actually shown to an agent.
 * Carries the harness only, never the command or the tool name.
 */
import type { SuggestHarness } from "./render.js";

export interface SuggestionShownEvent {
  readonly harness: SuggestHarness;
  readonly resinHome?: string;
}

export type SuggestionShownCounter = (event: SuggestionShownEvent) => void;

let counter: SuggestionShownCounter | undefined;

/** Installs the counter (the discovery funnel's `suggestion_shown`); undefined removes it. */
export function setSuggestionShownCounter(next: SuggestionShownCounter | undefined): void {
  counter = next;
}

/** Counts one shown suggestion. A failing counter never affects the suggestion. */
export function countSuggestionShown(event: SuggestionShownEvent): void {
  try {
    counter?.(event);
  } catch {
    // Counting is best effort.
  }
}
