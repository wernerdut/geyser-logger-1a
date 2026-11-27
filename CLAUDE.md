# CLAUDE.md

## Git workflow

- Commit and push directly to `main`. No feature branches or pull requests unless Werner asks for one.
- When Werner asks for a code change, committing and pushing it to `main` is part of the ask.
- Never force-push and never rewrite history on `main`. Roll back with `git revert` (a new commit that undoes the bad one), so the history stays intact.
- After every push, report the commit hash so it can be reverted.
- Ask before any push that includes a database migration, or any other change a revert cannot undo.
