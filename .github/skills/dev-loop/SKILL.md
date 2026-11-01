---
name: dev-loop
description: "Use for feature, bug and enhancement ideas: clarify and review a GitHub issue, approve a plan, implement, validate and publish a PR."
---
# Dev loop

## Ground rules
- Use the current repository; identify its default branch and inspect the worktree.
- Preserve unrelated changes. Stop if they conflict; never reset or force-push.
- Preserve local-only commits and branches used by other worktrees; never auto-delete
  local branches/worktrees. Fetch pruning removes stale remote refs, not local work.
- GitHub issue body is the spec; issue comments hold decisions, plan and approvals.
- Do not publish secrets or private data in issues, comments or PRs.
- Ask clarifying questions with the question tool; wait for answers.
- If unavailable, report the blocker and stop rather than assuming approval.
- Invoke the dedicated spec, plan or PR reviewer in fresh context, not author context.
- Pass the issue URL, full current body, relevant comments and artifact version.
- If independent review is unavailable, stop; do not substitute self-review.

## 1. Idea to specification
1. Inspect relevant code and existing issues; reuse a matching issue only if appropriate.
2. Draft problem, user scenario, scope/non-goals, behavior, edge cases and constraints.
3. Add numbered measurable acceptance criteria and validation expectations.
4. Clarify significant choices with the user; capture answers in the spec.
5. Create the GitHub issue (or update the selected issue) and verify its saved body.

## 2. Independently review and approve the spec
1. Fetch issue body/comments; invoke Dev Loop Spec Reviewer with current versions.
2. Resolve findings with the user; update the issue and record decisions.
3. Re-review material revisions; post the review outcome as an issue comment.
4. Ask for explicit approval of the current spec; record the answer on the issue.
5. Stop until approved. Spec changes invalidate its approval and affected plan approval.

## 3. Plan, independently review and approve
1. Create a small numbered engineering plan from the approved spec and code evidence.
2. Each step lists relevant files/surfaces, dependencies and expected outcome.
3. Map every acceptance criterion to a step and automated/manual validation.
4. Post the plan as an issue comment and verify it; retain the comment URL.
5. Invoke Dev Loop Plan Reviewer to cross-check against the current approved spec.
6. Clarify findings with the user; post revised plans and re-review material changes.
7. Post the review outcome; ask for explicit approval of the current plan.
8. Record the answer with the plan URL; stop until approved. Revisions need reapproval.

## 4. Implement and validate
1. Fetch the remote (prune stale refs if needed); inspect local work and other worktrees.
   If the local default branch diverges, stop and ask how to reconcile it safely.
   For new work, start a fresh issue-specific branch from the fetched remote default.
2. Use `feat/<issue>-<slug>` or `fix/<issue>-<slug>`; never mix issues on one branch.
3. Before resuming an existing branch, verify its linked PR is open and for this issue.
   Reuse only that open PR's branch. If PR state is missing, ambiguous or unverifiable,
   or its remote branch was deleted, preserve local work and ask before proceeding.
   Merged/closed PR branches are not reusable for new commits; follow-up work requires
   fresh spec/plan approval through the gates above and a fresh branch from the
   fetched remote default. Preserve leftover changes/commits and ask how to reconcile
   them; do not silently carry unrelated work onto the new branch.
4. Follow approved steps with surgical changes and directly related documentation.
5. If new evidence changes scope or plan, return to the affected review/approval gate.
6. Run focused existing tests/builds/lints; add regression tests as appropriate.
7. Validate every acceptance criterion, including applicable browser/manual scenarios.
8. Record commands, results and manual observations, distinguishing checks not run.
9. If validation is blocked, explain why and stop; do not claim completion.

## 5. Publish, independently review and wait
1. Commit only issue changes, following repository commit conventions.
2. Before pushing, verify any existing linked PR is still open for this issue.
   If merged/closed or unverifiable, stop before pushing and follow step 4.3.
   Push without force; create a draft PR to the default branch for new work, or reuse
   only the verified open same-issue PR.
3. Include `Closes #<issue>`, spec/plan links, summary and validation evidence.
4. Fetch the complete PR diff and head SHA; pass approved spec/plan and test evidence
   to a fresh Dev Loop PR Reviewer. Post its outcome with that SHA on the PR.
5. Resolve findings, clarify with the user, revalidate and push fixes; review each new SHA.
6. Stop on blockers. Only mark the PR ready after a pass for its current published SHA.
7. Verify remote branch/PR; post its link and results on the issue.
8. Return the PR URL and limitations. Stop for human review and merge; never merge.
   GitHub automatically deletes merged head branches in this repository; after merge,
   start any new work from the fetched remote default, not the old PR branch.
