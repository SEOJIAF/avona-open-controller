# JSON Schemas from the Anova app

These are the [ajv](https://ajv.js.org/) JSON Schemas (draft‑07) that the Anova Culinary Android app embeds to
validate cloud messages. They were rebuilt from the app's compiled Hermes bytecode by evaluating the code
that constructs each schema object. Treat them as the most precise description of the cloud message
formats available. They describe what the app accepts, which is not necessarily everything the cloud sends.

| File | Describes | Source module |
|---|---|---|
| `SousVideState.schema.json` | `EVENT_APC_STATE` state of 3rd‑gen cookers (a6–a9) | `SousVideStateSchema` (mod 708) |
| `OvenCommand.schema.json` | Every `CMD_APO_*` oven command and its payload | `IOvenCommandSchema` (mod 876) |
| `OvenStateV1.schema.json`, `OvenStateV2.schema.json` | Oven state events | mod 870, 871 |
| `OvenRecipeV1.schema.json`, `OvenRecipeV2.schema.json` | Oven recipe and stage definitions | mod 932, 934 |
| `UserCommand.schema.json` | User/account commands (`CMD_CREATE_TOKEN`, `CMD_LIST_USERS`, …) | mod 1328 |
| `MultiUserCommand.schema.json` | Multi-user cooker sharing commands | mod 926 |

2nd‑generation Wi‑Fi cookers (a4, a5, Pro Wi‑Fi, for example the AN500) send an older state format that has
no schema in the app. It is documented in [`../PROTOCOL.md`](../PROTOCOL.md) §2.2 from live traffic.
