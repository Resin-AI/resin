/**
 * Device-independent repository identity for command suggestions: the shared
 * `@resin/observer/repository-identity` (node built-ins only, so the per-command hook stays fast).
 */
import type { RepositoryIdentity } from "@resin/observer/repository-identity";

export { type RepositoryIdentity, repositoryIdentity } from "@resin/observer/repository-identity";

/** Resolves the repository enclosing a directory; injectable for tests. */
export type RepositoryIdentityResolver = (dir: string) => RepositoryIdentity | undefined;
