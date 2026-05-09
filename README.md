# homebridge-inim-cloud

[![npm version](https://img.shields.io/npm/v/homebridge-inim-cloud)](https://www.npmjs.com/package/homebridge-inim-cloud)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Homebridge plugin for **INIM alarm systems** (Prime / PrimeLAN) via INIM Cloud API.  
Integrates your INIM alarm with **Apple HomeKit** and **Siri**.

---

## Features

- 🔒 Arm / disarm via Siri and Apple Home app
- 🌙 Full 4-state HomeKit mapping: **Away**, **Night**, **Home**, **Disarmed**
- 🗺️ Configurable mapping of INIM scenarios → HomeKit states (no code editing required)
- 🔄 Automatic polling and state sync
- 🚨 Alarm triggered state detection
- 🔑 Secure token management with automatic re-authentication

---

## Compatibility

| INIM Model | Tested |
|---|---|
| Prime / PrimeLAN | ✅ |
| SmartLAN/G | ⚠️ Untested (HTTP must be enabled by installer) |

---

## Requirements

- INIM Cloud account (same credentials as the official INIM app)
- INIM alarm connected to INIM Cloud
- Homebridge v1.6.0 or v2.0.0+
- Node.js v22+

---

## Installation

```bash
npm --prefix /var/lib/homebridge install homebridge-inim-cloud
```

Or search for **INIM Cloud** in the Homebridge UI plugin store.

---

## Configuration

All settings are available via the Homebridge UI plugin settings panel — no manual JSON editing required.

| Field | Description | Default |
|---|---|---|
| Name | Accessory name in HomeKit | Allarme Casa |
| Email | INIM Cloud account email | — |
| Password | INIM Cloud account password | — |
| PIN | Alarm user code (keypad PIN) | — |
| Scenario → Disarmed | INIM scenario ID for Disarmed state | 0 |
| Scenario → Home | INIM scenario ID for Stay Armed (Home) | 1 |
| Scenario → Night | INIM scenario ID for Night Armed | 2 |
| Scenario → Away | INIM scenario ID for Away Armed | 3 |
| Poll interval | State refresh interval (seconds) | 15 |

### Example scenario mapping (INIM Prime default)

| INIM Scenario | HomeKit State |
|---|---|
| 0 — SPENTO | Disarmed |
| 1 — PERIMETRO | Home (Stay Armed) |
| 2 — NOTTE | Night Armed |
| 3 — TOTALE | Away Armed |

---

## Usage with Siri

Once configured, you can use:

- *"Hey Siri, arm my home"*
- *"Hey Siri, disarm my home"*
- *"Hey Siri, set home to night mode"*
- *"Hey Siri, what is my alarm status?"*

---

## Credits

- **API reverse engineering & INIM Cloud integration:**  
  [pla10](https://github.com/pla10/homeassistant_inim_alarm) — Home Assistant INIM Alarm integration  
  This plugin is based on the API research and method discovery by pla10.

- **Plugin development:**  
  [promehh](https://github.com/promehh) with the help of [Claude](https://claude.ai) by Anthropic.

---

## License

MIT © [promehh](https://github.com/promehh)
