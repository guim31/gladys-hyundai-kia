# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- A working example of scene triggers, scene actions and dashboard widgets
  (Gladys 5.1.0 or later).
- `CHANGELOG.md`, rolled by the Release workflow.
- A GitHub Release for every version, with its changelog section as notes: the
  Gladys Supervision page links each version to the repository's releases.
- CI runs the tests on Node 22 and 24, and builds the Docker image.
- Dependabot keeps the npm dependencies and the GitHub Actions up to date.
- `SECURITY.md` (how to report a vulnerability) and `CLAUDE.md` (project rules
  for contributors and coding assistants).
- Manifest tests: `version` matches `package.json`, `docker_image` is tagged
  with it, descriptions hold 10 to 100 characters, placeholders are
  multi-language objects.
- The latitude and longitude fields show an example value as placeholder.

### Changed

- Node.js 22 or later is required (Node 20 is end-of-life).

### Fixed

- The release commit no longer fails `npm run format:check`: the Release
  workflow updates the manifest `version` and `docker_image` in place instead
  of re-printing the whole file with `jq`.

[Unreleased]: https://github.com/GladysAssistant/integration-template-js/commits/main
