# Bluelink / Kia Connect fixtures

No answer of the cloud can be captured from a code session (no account, no
car). The car states below come from the test fixtures of
[hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
(MIT License, Copyright (c) Fuat Akgun), wrapped in the CCAPI envelope
(`retCode`, `resCode`, `resMsg`), without their test metadata and without any
location.

| File                                    | Source                                       | Protocol |
| --------------------------------------- | -------------------------------------------- | -------- |
| `status_latest_ev6.json`                | `eu_kia_ev6_2023_with_soc.json`              | original |
| `ccs2_latest_ev9.json`                  | `eu_kia_ev9_2024_ccs2.json`                  | CCS2     |
| `ccs2_latest_ev9_battery_sentinel.json` | `eu_kia_ev9_2024_ccs2_battery_sentinel.json` | CCS2     |
| `ccs2_latest_sportage_phev.json`        | `eu_kia_sportage_phev_2027_ccs2.json`        | CCS2     |
| `status_latest_ice.json`                | synthetic (combustion car)                   | original |
| `vehicles.json`                         | synthetic (fake VINs and ids)                | —        |
