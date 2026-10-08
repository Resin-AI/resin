/**
 * Counter hook for the discovery funnel: called once per suggestion actually shown to an agent.
 * Carries the harness only, never the command or the tool name. By default it counts the funnel's
 * `suggestion_shown` and writes it at once: the hook process exits right after printing.
 */
import { flushDiscoveryFunnel, recordDiscoveryFunnelEvent } from "@resin/observer/discovery-funnel";
import type { SuggestHarness } from "./render.js";

export interface SuggestionShownEvent {
  readonly harness: SuggestHarness;
  readonly resinHome?: string;
}

export type SuggestionShownCounter = (event: SuggestionShownEvent) => void;

/** Counts a shown suggestion in the local discovery funnel and writes it before the hook exits. */
const countInDiscoveryFunnel: SuggestionShownCounter = (event) => {
  recordDiscoveryFunnelEvent(
    "suggestion_shown",
    event.resinHome === undefined ? {} : { resinHome: event.resinHome },
  );
  flushDiscoveryFunnel();
};

let counter: SuggestionShownCounter = countInDiscoveryFunnel;

/** Replaces the counter (tests); undefined restores the discovery-funnel default. */
export function setSuggestionShownCounter(next: SuggestionShownCounter | undefined): void {
  counter = next ?? countInDiscoveryFunnel;
}

/** Counts one shown suggestion. A failing counter never affects the suggestion. */
export function countSuggestionShown(event: SuggestionShownEvent): void {
  try {
    counter(event);
  } catch {
    // Counting is best effort.
  }
}
