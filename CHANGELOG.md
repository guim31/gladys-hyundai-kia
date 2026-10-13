# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Quieter logs: a cloud outage or a failing read is logged once per car, then once
  more when it recovers, instead of at every read. The connection status is
  sent to Gladys only when it changes, and again after Gladys restarts.
- The cars keep refreshing on the integration's own timer whether or not
  Gladys polls them (Gladys 5.2.0 does not): now covered by a test.
- Integration SDK 0.15.

### Fixed

- A poll from Gladys, if one ever comes, no longer resends every value of the
  car: only what changed.

## [1.1.0] - 2026-10-11

### Added

- German and Spanish texts: configuration, connection test, scene actions,
  widget and error messages follow the language of Gladys (German, Spanish,
  French, English).
- German and Spanish **device names language**, for the feature names of cars
  added from now on.

## [1.0.2] - 2026-10-11

### Fixed

- **Test the connection** shows its failures in red: they were shown in green
  as if the test had passed.
- Its message when no account is saved now says to save the configuration
  first: the test checks the saved configuration, not the form being edited.
- A command refused for want of the PIN is now visible: red message on the
  widget button, a **Commands** line in the widget, and the known value put
  back on the dashboard. Missing and refused PIN are told apart.
- A widget command the car reports as failed is shown in red.

### Changed

- The PIN is asked for remote commands whatever the car (the connection test,
  the configuration and the documentation no longer say "newer cars only").
- Tested on a Hyundai IONIQ 5 (European account): sign-in and unlocking.

## [1.0.1] - 2026-10-11

### Added

- Hyundai Bluelink and Kia Connect (Europe): one device per car with battery,
  range, charging, charge limits, climate, locks, openings, odometer, 12 V
  battery and ignition, for electric, plug-in hybrid and combustion cars.
- Commands: start / stop charging, AC and DC charge limits, climate with a set
  temperature, lock and unlock, with the PIN for newer cars.
- Cached reads every 15, 30 or 60 minutes; optional forced refresh (off by
  default, never at night nor while driving).
- Dashboard widget `vehicle`, scene actions `refresh_vehicle` and
  `start_climate`, and a **Test the connection** action.

[Unreleased]: https://github.com/guim31/gladys-hyundai-kia/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/guim31/gladys-hyundai-kia/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/guim31/gladys-hyundai-kia/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/guim31/gladys-hyundai-kia/releases/tag/v1.0.1
