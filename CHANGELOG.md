# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/guim31/gladys-hyundai-kia/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-hyundai-kia/releases/tag/v1.0.1
