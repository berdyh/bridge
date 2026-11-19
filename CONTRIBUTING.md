# Contributing

Thanks for helping. Bug reports, kit requests and pull requests are welcome.

## Issues

File problems and requests as GitHub issues in this repository, with the templates (bug report, kit request).
Search the open issues first. Security problems go to a private advisory instead: see [SECURITY.md](SECURITY.md).

Coding agents working in an app that uses the kit follow the same route: see "Reporting problems with the kit" in
[AGENTS.md](AGENTS.md).

## Pull requests

- Open an issue first for anything larger than a small fix, so the approach is agreed before the work.
- Keep a pull request to one change. Split unrelated fixes, and keep formatting or renames apart from behaviour
  changes.
- A fix comes with a test that fails without it. Tests use synthetic credentials only and never read a real agent
  login or keychain entry.
- When a change alters how the kit works, update `docs/ARCHITECTURE.md` in the same pull request.
- Commit messages follow `type(scope): summary`, for example `fix(runner): refuse a plugin path behind a link`.

## Development

Node 22 or newer and pnpm (the version is pinned in `package.json`; [Build from a clean clone](README.md#build-from-a-clean-clone) says which pnpm switches to it and when the registry is needed). The checks a pull request must pass are listed
under "Checks" in [AGENTS.md](AGENTS.md); run them from the repository root before you open it. Set `TMPDIR` to a
writable folder on disk first.

The layout of the packages and the rules every change keeps are in [AGENTS.md](AGENTS.md); how the parts fit
together is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

By contributing you agree that your contribution is licensed under the Apache License, Version 2.0, as the rest of
the repository (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
