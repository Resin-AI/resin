#!/usr/bin/env bash
# ==============================================================================
# Resin - Branch Protection & Release Gate Configuration Script
#
# Configures GitHub branch protection rules on 'main' to enforce PR-only release gates:
# 1. Require changes to arrive through pull requests with independent code owner review.
# 2. Require at least one approving review from designated code owners (author cannot self-approve).
# 3. Dismiss stale reviews upon new commit pushes and enforce last-push approval.
# 4. Require branches to be up to date before merging.
# 5. Require all 13 parallel CI status checks + rollup 'CI Gate Rollup' to pass.
# 6. Enforce rules for administrators and prevent force pushes/deletions.
#
# Usage:
#   ./scripts/configure-branch-protection.sh [--repo OWNER/REPO] [--branch main] [--dry-run]
# ==============================================================================
set -euo pipefail

BRANCH="main"
REPO=""
DRY_RUN=false

print_usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Configures strict branch protection rules for Resin repositories.

Options:
  -r, --repo OWNER/REPO   GitHub repository (default: detected from git remote origin)
  -b, --branch BRANCH     Target branch name (default: main)
  -d, --dry-run           Print payload without applying API changes
  -h, --help              Show this help message

Requirements:
  - GitHub CLI ('gh') authenticated with 'repo' or 'admin:org' scope, OR
  - 'GITHUB_TOKEN' / 'GH_TOKEN' environment variable with admin access.

EOF
}

# Parse command-line flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--repo)
      REPO="$2"
      shift 2
      ;;
    -b|--branch)
      BRANCH="$2"
      shift 2
      ;;
    -d|--dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

# Auto-detect repository if not provided
if [[ -z "$REPO" ]]; then
  if command -v gh >/dev/null 2>&1 && gh repo view --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  elif git remote get-url origin >/dev/null 2>&1; then
    REMOTE_URL="$(git remote get-url origin)"
    # Extract owner/repo from SSH or HTTPS URLs
    REPO="$(echo "$REMOTE_URL" | sed -E 's#(git@github.com:|https://github.com/)([^/]+/[^/.]+)(\.git)?#\2#')"
  fi
fi

if [[ -z "$REPO" ]]; then
  echo "❌ Error: Could not determine GitHub repository. Please pass --repo OWNER/REPO." >&2
  exit 1
fi

echo "🛡️  Configuring Branch Protection for ${REPO} on branch '${BRANCH}'..."

# Branch protection payload adhering to GitHub REST API specification:
# https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection
PROTECTION_PAYLOAD=$(cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Lint & Format Check",
      "TypeScript Typecheck",
      "Monorepo Build",
      "Unit Tests",
      "E2E Tests (with PostgreSQL)",
      "Package Boundaries Check",
      "ADR Verification",
      "Privacy Data Boundary Check",
      "Hostile Cloud Quarantine & Preactivation Check",
      "Runtime IPC & Broker Security Check",
      "Release Verification",
      "Binary Smoke Test",
      "Secret Scanning",
      "CI Gate Rollup"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": true
}
EOF
)

if [[ "$DRY_RUN" == true ]]; then
  echo "🔍 [DRY RUN] Would submit the following branch protection payload to /repos/${REPO}/branches/${BRANCH}/protection:"
  echo "$PROTECTION_PAYLOAD"
  exit 0
fi

# Check for gh CLI or GITHUB_TOKEN
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "📡 Submitting protection configuration via 'gh api'..."
  if echo "$PROTECTION_PAYLOAD" | gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "/repos/${REPO}/branches/${BRANCH}/protection" \
    --input - >/dev/null; then
    echo "✅ Successfully enabled strict branch protection on '${BRANCH}' for ${REPO}!"
  else
    EXIT_CODE=$?
    echo "" >&2
    echo "⚠️  Failed to apply branch protection via GitHub API (exit code $EXIT_CODE)." >&2
    echo "ℹ️  Note: Private repositories on GitHub Free plans do not support branch protection." >&2
    echo "    To enforce branch protection on private repositories, ensure GitHub Pro / Team / Enterprise," >&2
    echo "    or configure repository rulesets under Settings > Rules > Rulesets." >&2
    exit $EXIT_CODE
  fi
elif [[ -n "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ]]; then
  TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  echo "📡 Submitting protection configuration via 'curl'..."
  HTTP_STATUS=$(curl -s -o /tmp/gh_branch_resp.json -w "%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${REPO}/branches/${BRANCH}/protection" \
    -d "$PROTECTION_PAYLOAD")

  if [[ "$HTTP_STATUS" =~ ^20[0-4]$ ]]; then
    echo "✅ Successfully enabled strict branch protection on '${BRANCH}' for ${REPO}!"
  else
    echo "" >&2
    echo "❌ API request returned HTTP status $HTTP_STATUS:" >&2
    cat /tmp/gh_branch_resp.json >&2
    echo "" >&2
    echo "ℹ️  Note: Private repositories on GitHub Free plans do not support branch protection." >&2
    echo "    To enforce branch protection on private repositories, ensure GitHub Pro / Team / Enterprise," >&2
    echo "    or configure repository rulesets under Settings > Rules > Rulesets." >&2
    exit 1
  fi
else
  echo "❌ Error: Neither 'gh' CLI (authenticated) nor 'GITHUB_TOKEN'/'GH_TOKEN' is available." >&2
  echo "Please authenticate with 'gh auth login' or export 'GITHUB_TOKEN'." >&2
  exit 1
fi
