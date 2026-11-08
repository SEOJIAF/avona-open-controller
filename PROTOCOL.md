# Anova Culinary app (Android) — device & cloud protocol notes

Source: `Anova (1).apk`, package `com.anovaculinary.android`, React Native with a Hermes v96 bundle
(`assets/index.android.bundle`, source hash `466106d5a3d2737142c1afd2bf19547b78fd8aa1`).
Method: static analysis only. The Hermes bundle was decompiled with hermes-dec 0.1.8 and the dex files with jadx 1.5.6.
Nothing in this document comes from contacting a device or Anova's servers.

**Labels**
- **[O]** = observed in decompiled code. References use Metro module IDs (`mod NNNN`) and original function names
  that Hermes kept. Re-running `hbc-decompiler` on the same bundle reproduces them.
- **[I]** = inferred (from naming, a public reference such as the TI SimpleLink docs, or reasoning). Not seen directly.
- **[L]** = confirmed live against a real Precision Cooker Wi‑Fi **AN500** (type `a5`, firmware 1.6.0), using the
  controller in [`webapp/`](webapp/) on a fresh account (2026‑11‑08).

Reconstructed JSON Schemas (ajv, draft‑07) that are embedded in the bundle are in [`schemas/`](schemas/).
They are the most exact description of the cloud message formats **[O]**.

---

## 0. Device families

`APCCookerType` (mod 826, `isSecondGenerationWifiCooker`/`isThirdGenerationWifiCooker`) and the product picker **[O]**:

| key | product name in app | gen | transport used by app |
|---|---|---|---|
| `a2a3` / `A2` | Precision Cooker (Bluetooth / BT+Wi‑Fi, 2014‑16) | 1 | BLE text protocol (§1.1); A3 adds Wi‑Fi via BLE provisioning plus cloud |
| `a3` | Precision Cooker Wi‑Fi (1st gen) | 1 | same as above |
| `a4`, `a5`, `honey-badger`, `pro` | Precision Cooker (Wi‑Fi 2nd gen), Pro | 2 (`isSecondGenerationWifiCooker`) | cloud WS; Wi‑Fi set up through the device's own AP (§3.2) |
| `nano` | Precision Cooker Nano | – | BLE COBS + protobuf (§1.2) |
| Pro (BLE) | Precision Cooker Pro | – | BLE COBS + protobuf/CLI (§1.3) |
| `a6` | Nano 3.0 | 3 (`isThirdGenerationWifiCooker`) | cloud WS; Wi‑Fi set up over the BLE pairing service (§1.4) |
| `a7` | Precision Cooker 3.0 | 3 | same |
| `a8` | Precision Cooker Mini/Lite | 3 | same, **plus** direct BLE control fallback (§1.5) |
| `a9` | Precision Cooker Pro 3.0 | 3 | same |
| APO | Precision Oven | – | types and schemas are in the bundle (§2.4), but this app has no oven command sender (see Unknowns) |

Two BLE libraries are linked **[O]**: `react-native-ble-manager` (`it.innove.BleManager`, JS mod 697), used by the gen‑1, Nano and Pro paths, and
`react-native-ble-plx` (`com.bleplx`, JS mod 2602), used by the gen‑3 pairing service and the A8 fallback.

---

## 1. BLE protocols

### 1.1 Gen‑1 Precision Cooker (A2/A3) — ASCII over HM‑10‑style serial **[O]** mod 1345/1347/1349

- Service `0000ffe0-0000-1000-8000-00805f9b34fb`. Characteristic `0000ffe1-0000-1000-8000-00805f9b34fb` (both RX and TX) (mod 1347).
- **Write:** `writeWithoutResponse(device, 'ffe0', 'ffe1', bytes, maxByteSize=20, queueSleepTime=200ms)` (`_sendDeviceCommand`).
  The payload is the ASCII command plus `"\r"` (`encode()` → `str2charArray`).
- **Read:** listens for `BleManagerDidUpdateValueForCharacteristic` notifications. It concatenates chunks until a chunk is shorter than 20 bytes
  or ends in `0x00`, then runs `String.fromCharCode(...).trim()` (`resultListener`). Timeout 15 s (`readResponse`).
- **Command strings** (`COMMANDS`, mod 1349):

| constant | string sent |
|---|---|
| START / STOP | `start` / `stop` |
| READ_TARGET_TEMP | `read set temp` |
| READ_TEMP | `read temp` |
| READ_UNIT | `read unit` |
| READ_TIMER | `read timer` |
| START_TIMER / STOP_TIMER | `start time` / `stop time` |
| SET_TIMER(n) | `set timer <n>` (minutes **[I]**) |
| SET_TEMP(t) | `set temp <t>` |
| SET_UNIT(u) | `set unit <c|f>` (lower‑cased) |
| CLEAR_ALARM | `clear alarm` |
| GET_COOKER_ID | `get id card` |
| STATUS | `status` |
| FIRMWARE_VERSION | `version` |
| SET_SPEAKER(x) | `set speaker <x>` |
| **A3 Wi‑Fi only:** SET_WIFI_CREDS(ssid, pw) | `wifi para 2 <ssid> <pw> WPA2PSK AES` |
| SET_COOKER_SECRET(s) | `set number <s>` |
| SEND_SERVER_ADDRESS | `server para pc.anovaculinary.com 8080` |
| SMARTLINK_START | `smartlink start` |

- Response formats (for example what `status` returns) are not parsed in a single place. They are plain text, and some callers use `includes(' ')` checks (mod 699).
  The exact text is **[I]**/unknown without a device.

### 1.2 Nano (BLE) — COBS‑framed protobuf **[O]** mod 1377/1378/1379/1398/1399/1400

- Service `0e140000-0af1-4582-a242-773e63054c68`.
  TX (app→device) `0e140001-…`, RX (device→app) `0e140002-…`, async `0e140003-…` (mod 1378).
  Scales: `targetTemperatureScale=10`, `temperatureScale=100`, `sensorTemperatureScale=1`.
- **Frame:** `[domainId, messageType] ++ protobufBytes`, then COBS‑encoded, then a `0x00` terminator appended (`encode`/`cobsEncode`, mod 1400).
  The frame is written in 20‑byte chunks to TX. The response arrives on RX: chunks are collected, COBS‑decoded (`cobsDecode`, mod 1399), and
  the protobuf type expected for that command is decoded. A blank response is acceptable for setters. Stripping the 2‑byte header before decoding is **[I]**.
- `DomainType`: CONFIG=0, BULK_TRANSFER=1.
- `ConfigDomainMessageType`: LOOPBACK 0, CLI_TEXT 1, SAY_HELLO 2, SET_TEMP_SETPOINT 3, GET_TEMP_SETPOINT 4, GET_SENSORS 5,
  SET_TEMP_UNITS 6, GET_TEMP_UNITS 7, SET_COOKING_POWER_LEVEL 8, GET_COOKING_POWER_LEVEL 9, START_COOKING 10, STOP_COOKING 11,
  SET_SOUND_LEVEL 12, GET_SOUND_LEVEL 13, SET_DISPLAY_BRIGHTNESS 14, GET_DISPLAY_BRIGHTNESS 15, SET_COOKING_TIMER 16,
  STOP_COOKING_TIMER 17, GET_COOKING_TIMER 18, CANCEL_COOKING_TIMER 19, SET_CHANGE_POINT 20, CHANGE_POINT 22,
  SET_BLE_PARAMS 23, BLE_PARAMS 24, GET_DEVICE_INFO 25, GET_FIRMWARE_INFO 26, SYSTEM_ALERT_VECTOR 27, MESSAGE_SPOOF 29.
- `BulkDomainMessageType`: PAGE_GET 0, PAGE_PUT 1, FILE_ERASE 2, FILE_PROPS 3, SYSTEM_RESET 4.
- `UnitType`: DEGREES_POINT_1C 0, DEGREES_POINT_1F 1, MOTOR_SPEED 2, BOOLEAN 3, DEGREES_POINT_01C 4, DEGREES_POINT_01F 5, DEGREES_C 6, DEGREES_F 7.
- Protobuf messages (field number → name):
  - `IntegerValue { 1: int32 value }`
  - `SensorValue { 1: int32 value, 2: int32 units, 3: int32 sensorType }`. SensorType: WaterTemp, HeaterTemp, TriacTemp, UnusedTemp, InternalTemp, WaterLow, WaterLeak, MotorSpeed.
  - `SensorValueList { 1: repeated SensorValue values }`
  - `SysAlertBitVector { 1: uint32 prevSetVector, 2: uint32 currVector }`
  - `BleConnectionParams { 1 slaveLatencyMs, 2 connectionIntervalMinMs, 3 connectionIntervalMaxMs }`
  - `DeviceInfo { 1 revision, 2 modelNumber, 3 boardRevision, 4 bom, 5 platform, 6 cmCode, 7 dateCode, 8: string serialNumber }`
  - `FirmwareInfo { 1: string commitId, 2: string tagId, 3: uint32 dateCode }`
  - `DeviceState { 1: waterTemp, 2: alerts, … }` (only partly read)
- Commands built by the app: START/STOP (no body, response SensorValueList), GET_SENSORS, GET_TEMP_SETPOINT, GET_TEMP_UNITS,
  GET_COOKING_TIMER (→ IntegerValue), GET_FIRMWARE_INFO, `SET_TEMP(t)` = IntegerValue(t×10), `SET_UNIT` = IntegerValue(0=°C / 1=°F),
  `SET_TIMER(n)` = IntegerValue(n).

### 1.3 Precision Cooker Pro (BLE) **[O]** mod 2660/2662/2663/2665

- Same service and characteristic UUIDs as the Nano (mod 2660, `deviceType:'Pro'`).
- Frame: `[domain, msgType] ++ body`, COBS‑encoded with a `0x00` terminator, written to TX in 20‑byte chunks.
  The response is read from **async `0e140003`** by default, or from RX for Wi‑Fi credentials. Timeout ~8 s.
  The end of a response is detected by a trailing `0x00` (binary) or a trailing `$` (CLI text).
- Domains `{Config:0, BulkTransfer:1}`. Types `{CLI:1, GetStatus:12, SetWifiCredentials:30}`.
- `CLI` (domain 0, type 1) with an ASCII body. Commands used: `get-device-id-creds`, `ota-upgrade <url>`, `wlan-scan`, `ping <x>`, `fs-list`.
- `SetWifiCredentials` (0/30) carries protobuf `WlanConnectionParams { ssid, password, type }`, with `EncryptionType` WIFI_SEC_TYPE_OPEN / WEP / WPA_WPA2.
- `GetStatus` (1/12). Status decoder `byteDecoderForProStatusResponse`, after dropping 3 header bytes:
  `int32le[0..4]` flags (bits 0x10000 and 0x20000 are tested); `int32le[4..8]` bit0 = unit °F;
  `int16le[8..10]/100` = current °C; `int16le[20..22]/10` = target temperature.

### 1.4 Gen‑3 Wi‑Fi cookers (A6/A7/A8/A9): BLE pairing service **[O]** mod 2598/2631/2642

Service `910772a8-a5e7-49a7-bc6d-701e9a783a5c` (`GEN_3_SERVICE_UUID`). Connect with `requestMTU: 512`.
**Encoding:** every value is `base64(JSON)`. Characteristics carry the base64 *text* as ASCII bytes (`prepareJson`/`decodeJson`).
Writes use `writeCharacteristicWithResponseForService`; replies are notifications on the same characteristic.

| characteristic | name | app writes | device replies |
|---|---|---|---|
| `1877e8fa-abed-437c-8ae5-f4ec89daa1c2` | HELLO | `{"protocolVersion":"20220101"}` | `{"result":"accepted","class":"A7","deviceType":…,"deviceId":…}`. `class` lower‑cased is the APCCookerType (`confirmDevice`). |
| `c7a9a65b-1e5b-4387-9c0d-d3f1f7e2e254` | READ_PROOF_OF_POSSESSION_CODE | (read) | `{"pin": …}` (shown on the device) |
| `7e29a154-3eae-4ba8-90c3-d0763d57baf5` | CONFIRM_PROOF_OF_POSSESSION | `{"ackButton": <btn>}` | `{"button": "temp"\|"timer"\|"-"\|"+"\|"start"}` when the user presses a button |
| `511232d6-594e-4f90-8c57-c67b28505c6c` | GET_AVAILABLE_NETWORKS | `{"command":"start_scanning","maxSsidCount":16,"scanTimeSeconds":5}` | a header packet `EXPECT.<n>`, then n packets that are concatenated and parsed as JSON `{"ssids":[…]}` |
| `dca82f2c-9406-11ec-b909-0242ac120002` | CONNECT_TO_NETWORK | `{"ssid":…,"password":…,"cloud":"prod"}` (mod 4409/4413 `connectPeripheral`) | `{"status": …, "errorCode": …}`; `success` continues, `failure` is shown as "Incorrect Password", `error` aborts (mod 4415) |
| `9596bdb9-c194-4aa2-b226-2e10b8d901dc` | PAIRING | `{"userId": <Firebase uid>}` (mod 4415, `getAuth().currentUser.uid`) | `{"status","errorCode"}` |
| `c6537d1c-e23b-48b6-8fa6-b0e544561810` | SETUP_DONE | `{"command":"close"}` (mod 4418) | `{"status","errorCode"}` |

Screen order (`Gen3PairingFlow`, mod 4399‑4420): ConnectingToDevice → ProofOfPossession ("Does the below code match the code shown on your …", or for the a8 Mini "Is the LED blinking … press the button on the top") → SelectWifi → EnterWifiPassword / UseSavedWifiPassword → ConnectingToWifi → PAIRING → SETUP_DONE → ConnectionSuccess. **[O]**

Flow (`Bluetooth`, `BluetoothPairingManager`): scan filtered on the service UUID → bond (Android `createBond` with fallback) →
HELLO → PoP (the user presses the button that the app shows) → network scan → CONNECT_TO_NETWORK → PAIRING (binds the device to the Anova user) → SETUP_DONE.
After that, the device is controlled through the cloud (§2).

### 1.5 A8 (Mini/Lite) direct BLE control ("BTLE fallback") **[O]** mod 1741/2642/2643/2656/2657

`isBTLEFallbackDevice(type) === 'a8'`. This runs on the same Gen‑3 service when the WebSocket is down or the device is offline from the cloud.
Encoding is the same: `base64(JSON)` as ASCII (`encodeCommandForBTLE`/`decodeDataFromBTLE`).
Writes are **without response**.

| char | name | use |
|---|---|---|
| `0f5639f7-3c4e-47d0-9496-0672c89ea48a` | SET_TEMPERATURE | write `{"setpoint": <°C>}`; read returns the setpoint |
| `6ffdca46-d6a8-4fb2-8fd9-c6330f1939e3` | CURRENT_TEMPERATURE | read/notify current temperature |
| `a2b179f8-944e-436f-a246-c66caaf7061f` | TIMER | write `{"initial": <seconds>}`; read/notify timer |
| `54e53c60-367a-4783-a5c1-b1770c54142b` | STATE | write `{"command":"start","payload":{"setpoint":°C,"timer":s,"cookableId":"","cookableType":"manual"}}`, `{"command":"stop"}`, `{"command":"changeUnit","payload":{"temperatureUnit":"C"\|"F"}}`; read/notify state |
| `d8a89692-cae8-4b74-96e3-0b99d3637793` | SET_CLOCK | write `{"currentTime": "<ISO‑8601>"}` |
| `153c9432-7c83-4b88-9252-7588229d5473` | SYSTEM_INFO | read |
| `59cff486-ffad-421c-8fc2-b1b246171751` | IDENTIFY | write `{"sound":true,"led":true}` |

On connect, `sendInitialCommands` runs getSystemInfo → getState → getSetTemperature → getCurrentTemperature → getTimer → setClock,
then monitors STATE/TIMER/temperature notifications. The temperature unit in `startCook`/`setTemperature` is always converted to °C before sending.

---

## 2. Cloud protocol

### 2.1 Hosts **[O]** mod 1356
| client | base URL | auth |
|---|---|---|
| `apiClient` | `https://anovaculinary.io` | `Authorization: Bearer <Firebase ID token>` (`setAuthToken`, set on `onAuthStateChanged`) |
| `recipesAPIClient` | `https://anovaculinary.io/v1` | same |
| `a3WiFiClient` | `https://api.anovaculinary.com` | `?secret=` query |
| `s3Client` | `https://s3-us-west-2.amazonaws.com/app.anovacontent.com/production` | none |
| `localWiFiCookerClient` | `http://10.123.45.1` (device soft‑AP) | none |
| WebSocket | `wss://devices.anovaculinary.io` | token in query |

### 2.2 WebSocket **[O]** mod 1404/1414/1415
- **URL:** `wss://devices.anovaculinary.io?token=<Firebase ID token>&supportedAccessories=APC&platform=android|ios`
  (`connect` + `firebaseTokenQueryParam` → `currentUser.getIdToken()`). There is no further handshake message.
  Reconnect runs 5 s after close, and also on app foreground or Wi‑Fi reconnect.
- **Outgoing envelope** (`CommandProcessor.sendCommand`):
  ```json
  {"command":"CMD_APC_START","requestId":"<uuid>","payload":{ ...fields..., "requestId":"<another uuid>"}}
  ```
  The response is matched on the top‑level `requestId`. Responses are messages whose `command` is not one of the known events.
  Live, they are `{"command":"RESPONSE","requestId":"<same uuid>","payload":{"status":"ok"}}` **[L]**. Failures carry
  `payload.error`. Timeout `COMMAND_TIMEOUT_SECONDS = 10`.
  Live `CMD_APC_START` for an AN500: `{"cookerId":…,"type":"a5","targetTemperature":30,"unit":"C","timer":0,"requestId":…}`, answered `ok` **[L]**.
  Sign-in through the Firebase REST API from outside the app works. The client sends the app's `X-Android-Package`/`X-Android-Cert` headers; whether they are required was not tested **[L]**.
- **APC commands and payloads** (`APCWebsocket`):

| method | command | payload |
|---|---|---|
| startCooker | `CMD_APC_START` | `{cookerId, type, targetTemperature, unit, timer (s = minutes×60), cookable}` |
| stopCooker | `CMD_APC_STOP` | `{cookerId, type}` |
| setTargetTemperature | `CMD_APC_SET_TARGET_TEMP` | `{cookerId, type, targetTemperature, unit}` |
| setTemperatureUnit | `CMD_APC_SET_TEMPERATURE_UNIT` | `{cookerId, type, unit}` |
| setTimer | `CMD_APC_SET_TIMER` | `{cookerId, type, timer}` |
| startIceBathMonitor | `CMD_APC_START_ICEBATH_MONITORING` | `{cookerId, type}` |
| nameDevice | `CMD_NAME_WIFI_DEVICE` | `{cookerId, type, name}` |
| OTA | `CMD_APC_OTA` | `{cookerId, type, url}` |
| setA3CredentialsOnServer | `CMD_APC_A3_SET_CREDENTIALS` | `{type:'a3', cookerId, secret}` |
| registerPushNotificationToken | `CMD_APC_REGISTER_PUSH_TOKEN` | `{firebaseMessagingToken, platform, appId:'com.anovaculinary.anova'}` |
| disconnect | `CMD_APC_DISCONNECT` | `{cookerId, type}` |
| setSubscription | `CMD_USER_SET_SUBSCRIPTION` | `{id, type, payload:{productId, appType, transactionReceipt}}` |

  `type` is the APCCookerType string (`a7` etc.). Other known types that the app does not send: `CMD_APC_SET_METADATA`, `CMD_APC_HEALTHCHECK`, `CMD_APC_SET_TARGET_TEMPERATURE`, `CMD_AUTH_TOKEN`, `CMD_AUTH_TOKEN_V2`/`AUTH_TOKEN_V2` (mod 821‑823).
- **Incoming events** (`processMessage` → `EventProcessor`, mod 2658):
  `EVENT_APC_WIFI_LIST` (list of the user's paired cookers: `cookerId`, `type`, `name`, firmware…), `EVENT_APC_STATE` (`{cookerId, type, state}`),
  `EVENT_APC_WIFI_VERSION`, `EVENT_APC_WIFI_ADDED`, `EVENT_APC_WIFI_REMOVED`, `EVENT_USER_STATE` (`sousVideSubscription` membership).
  - **3rd gen (a6‑a9):** the state object follows [`schemas/SousVideState.schema.json`](schemas/SousVideState.schema.json) (`cook`, `nodes.waterTemperatureSensor.{current,setpoint}.celsius`,
    `nodes.timer`, `nodes.lowWater`, `state.mode`, `state.temperatureUnit`, `systemInfo.online/firmwareVersion`…).
  - **2nd gen Wi‑Fi (a4, a5, honey‑badger, pro):** the state is the legacy `WifiCookerState` body. `CookerState.fromAPCStatePayload` (mod 2644) routes these types to `WifiCookerState` (mod 2646‑2655) **[O]**. Live example from an AN500 **[L]**:
    ```json
    {"boot-id":"…",
     "job":{"id":"…","mode":"LOW WATER","target-temperature":30,"temperature-unit":"C","cook-time-seconds":0,"ota-url":""},
     "job-status":{"state":"","cook-time-remaining":0,"job-start-systick":240532,"state-change-systick":240532,"provisioning-pairing-code":8322},
     "pin-info":{"device-safe":1,"water-leak":0,"water-level-critical":1,"water-temp-too-high":0},
     "system-info":{"class":"A5","firmware-version":"1.6.0","type":"MKE15-128"},
     "system-info-details":{"firmware-version-raw":"VM178_A_01.06.00_MKE15-128","systick":384274,"version-string":"VM171_A_01.06.01 MKE15-128"},
     "temperature-info":{"water-temperature":25.53,"heater-temperature":26.19,"triac-temperature":28.76}}
    ```
    - `job.mode` values: `STARTUP`, `IDLE`, `COOK`, `OTA`, `PROVISIONING`, `HIGH TEMP`, `DEVICE FAILURE`, `LOW WATER`.
    - `job-status.state` values: `PREHEATING`, `COOKING`, `MAINTAINING`, `TIMER EXPIRED`, `SET TIMER` (mod 2649/2650).
    - Temperatures are °C. The app also reads `pin-info.water-level-low`, `system-info-3220` and `system-info-nxp` when present.
  - **Gen‑1 A3:** the state is a flat legacy object (`updateLegacyCookerStatus`) **[I]** on the exact field names.
  - **Other events seen live [L]:**
    - `EVENT_APC_WIFI_LIST`: `payload` is an array of `{cookerId, type, name, pairedAt}`.
    - `EVENT_APC_WIFI_VERSION`: `[{cookerId, type, version, ota:{available, required, url, version, description}}]`. The URL is a firmware `.bin` on `storage.googleapis.com/anova-app.appspot.com/…`.
    - `EVENT_USER_STATE`: `{isConnectedToAlexa, isConnectedToGoogleHome, sousVideSubscription:{…}, ovenSubscription:{…}}`.
    - Right after connect, the server sends `EVENT_APC_WIFI_LIST`, `EVENT_APC_WIFI_VERSION` and `EVENT_USER_STATE`, then `EVENT_APC_STATE` about every 2–5 s per online cooker.
- **User commands** (schema [`UserCommand.schema.json`](schemas/UserCommand.schema.json)): `CMD_CREATE_TOKEN`, `CMD_LIST_TOKENS`, `CMD_RENAME_TOKEN`, `CMD_DELETE_TOKEN`
  (personal access tokens), `CMD_GENERATE_NEW_PAIRING`, `CMD_ADD_USER_WITH_PAIRING`, `CMD_LIST_USERS`, `CMD_EXPORT_TELEMETRY`, Alexa pairing, subscriptions.

### 2.3 REST endpoints seen **[O]**
- `POST https://anovaculinary.io/authenticate`, header `Firebase-Token: <id token>` (`registerFirebaseTokenWithAnova`, mod 2781). Called at sign‑up/login.
- `GET /devices/{deviceId}/states/?limit=1&max-age=10s` on apiClient (`checkCookerStatusAPI`, mod 4349). Used to confirm a new Wi‑Fi cooker is online.
- `POST /devices-ota-current` `{device-type, firmware-version}` (mod 2668).
- `GET https://api.anovaculinary.com/cookers/{cookerId}?secret=<secret>` (A3 online check, mod 699).
- `GET/PUT {v1}/users/…`, `/recipes`, `/recipes/{id}`, `/recipes/search`, `/recipes/browse`, `/recipes/slugs/` (recipes API).
- `/v1/subscriptions/status/`, `/v1/subscriptions/entitlements/`, `/v1/subscriptions/bind-user/`, `/v1/products/` (billing).

### 2.4 Oven (APO) **[O]** for schemas, **[I]** for transport
The bundle includes the full command and state schemas (`OvenCommand`, `OvenStateV1/V2`, `OvenRecipeV1/V2`) and command factories (mod 878: `StartCook`, `StopCook`,
`SetTemperatureBulbs`, `SetSteamGenerators`, `SetFan`, `SetLamp`, `SetProbe`, `SetTimer`, `SetVent`, `StartStage`, `UpdateCookStage(s)`, descale, live stream…).
Schema‑defined wire format:
```json
{"command":"CMD_APO_START","requestId":"<uuid>",
 "payload":{"id":"<uuid>","type":"CMD_APO_START",
            "payload":{"cookerId":"…","type":"…","cookableType":"manual","originSource":"android","stages":[StageV2…]}}}
```
This app's WebSocket only advertises `supportedAccessories=APC` and handles only APC/user events. Oven control presumably needs
`supportedAccessories=APO` (or `AUTH_TOKEN_V2` with `{platform, supportedAccessories, token}`, a type that exists in the schema) **[I]**.

---

## 3. Wi‑Fi provisioning

### 3.1 Gen‑1 A3 (BLE text) **[O]** mod 699 / 1349
`get id card` → cookerId. App‑generated secret → `set number <secret>` → `server para pc.anovaculinary.com 8080` →
`wifi para 2 <ssid> <pw> WPA2PSK AES` (or `smartlink start`) → poll `api.anovaculinary.com/cookers/<id>?secret=` →
`CMD_APC_A3_SET_CREDENTIALS {cookerId, secret}` over the WebSocket. The cookerId and secret are stored in the Keychain (`persistCookerIDAndSecret`).
The cooker itself speaks to `pc.anovaculinary.com:8080` (protocol not in this APK).

### 3.2 Gen‑2 Wi‑Fi (A4/A5/Pro, e.g. Precision Cooker Wi‑Fi AN500): device soft‑AP at `http://10.123.45.1` **[O]** mod 4343‑4359

Flow (`WifiPairingController`, mod 4343):
1. The user holds the **target temperature** button for 5 s (`BeginPairingModeView`). The cooker shows a 4‑digit code, which is entered in `EnterDeviceCodeView`.
2. The phone joins the hotspot **SSID `Anova <code>`, WPA2 password `<code><code>`** (computed getters `ssid`/`password`; Android `WifiConnection.connectToSSID`).
3. `getDeviceID` (retried 30× at 1 s), then the Wi‑Fi scan.
4. `connectWifiCookerToAccessPoint`: `profile_add` (retry 5), `add-user-identity` with **body = Firebase uid** (`User.id` → `firebaseUser.uid`), sleep 2 s, `confirm_req`, sleep, then `didConfirmationFail`.
5. `waitForInternetConnection(60)` → `confirmPairing`: polls the account's cooker list (WS) up to 120 s for `cookerId === deviceID`.

All POSTs go through the native `WifiDeviceHttpWrapper.post`, which always sends `Content-Type: application/x-www-form-urlencoded` with the body as a raw string. This is how a cooker linked to another account is moved to the signed‑in one: running this flow while signed in to a new account re-linked an AN500 whose original account was inaccessible **[L]**.

Notes from the live run **[L]**:
- The cooker's web server is **lwIP 2.1.2**. It replies `HTTP/1.0 200 OK`, `Content-Type: text/plain`, with **no `Content-Length`**, and closes the socket to end the reply. POSTs get an empty body. Node's `fetch` (undici) rejects these replies ("other side closed"), while OkHttp and raw sockets accept them.
- `get-device-identity` returns a 22‑character base62 id. It is the same id the cloud then uses as `cookerId`.
- Scan entries look like `2AP_2940131817;`: a security digit, the SSID, then a `;` terminator.
- The hotspot blips while the cooker scans. A Linux client may roam back to a saved network unless the hotspot connection has top priority.
- A new 4‑digit code (and hotspot name) is generated each time the button is held.
This is the TI CC3220 SimpleLink HTTP provisioning API (`WifiSystemInfo3220`). The `__SL_*` token meanings come from TI docs **[I]**.
- `POST /api/1/wlan/en_ap_scan` body `__SL_P_SC2=3&__SL_P_SC1=10` starts a scan. After 3 s, `GET /__SL_G_NW0` returns the first result; `GET /__SL_G_NW1` returns the next one until the first character is `X`. Each result is `<securityType char><ssid><1 trailing char>`. Finally `GET /__SL_G_NW0` again to rewind.
- `POST /api/1/wlan/profile_add` body `__SL_P_P.A=<urlenc ssid>&__SL_P_P.B=<securityType from scan>&__SL_P_P.C=<urlenc password>&__SL_P_P.D=1` (form‑urlencoded).
- `GET /get-device-identity` → device id. `POST /add-user-identity` (body = user id) binds the device to the user.
- `POST /api/1/wlan/confirm_req` triggers the connection. `GET /__SL_G_MCH` checks the result ("Confirmation failed").
- Then `waitForInternetConnection` and poll `GET /devices/{id}/states/` on the cloud.

### 3.3 Gen‑3 (A6‑A9): BLE pairing service, §1.4.

---

## 4. Auth
- **Firebase Auth** (project `anova-app`; `google_api_key` `AIzaSyCGJwHXUhkNBdPkH3OAkjc9-3xMMjvanfU`; app id `1:322173998509:android:a9e5de76bee92127`;
  RTDB `https://anova-app.firebaseio.com`). These come from `resources.arsc` and are public client configuration, not secrets. Sign‑in methods are email/password, Google, Facebook and Apple.
  APK signing certificate (v2/v3 block): SHA‑1 `826E0D4C041DF7BDE2F94446226FDA57160472A9`. Clients outside the app send it as `X-Android-Cert`, together with `X-Android-Package: com.anovaculinary.android`, in case the key is restricted to Android **[O for the values, I for the restriction]**.
- The token is the **Firebase ID token** (`currentUser.getIdToken()`). It is used as the REST `Bearer`, as the WebSocket `token=` query, and in the `Firebase-Token` header for `/authenticate`.
  Refresh is handled by the Firebase SDK (`getIdToken()` returns a cached token or refreshes it; ID tokens last about 1 h) **[I: SDK behaviour]**.
- Personal access tokens: `CMD_CREATE_TOKEN`/`CMD_LIST_TOKENS` exist as user commands. This app has no UI for them, and whether the WS accepts them as `token=` is **[I]**.
- `EncrypedNoMitm` is a react‑native‑ble‑plx/Android pairing security enum value, not Anova crypto **[I]**. There is no app‑layer encryption on any BLE path **[O]**: payloads are plain text, protobuf or base64 JSON.

## 5. Certificate pinning
**Not enforced by the app [O].** `okhttp3.CertificatePinner` is present only as part of the library. No app or React Native code constructs one or calls `.certificatePinner(`.
The manifest has no `networkSecurityConfig`, and `usesCleartextTraffic` is set (needed for `http://10.123.45.1`).
The JS layer uses axios and RN `WebSocket` (OkHttp underneath) with default trust. A user‑installed CA is still **not** trusted on Android 7+ without repackaging or Frida **[I: platform default]**.

---

## Open unknowns
1. ~~Exact JSON body of gen‑3 setup writes~~. Resolved, see §1.4. Still open: whether the cloud `cookerId` equals the HELLO `deviceId`, and whether a cooker that is already linked to another account advertises the setup service.
2. ~~The WS response `command` value~~. Resolved: `RESPONSE` **[L]**.
3. `timer` is seconds (the app multiplies minutes by 60) and `unit:"C"` is accepted **[L]**. Not yet confirmed live: `unit:"F"` and a non-zero timer on gen‑2.
4. Text formats of gen‑1 responses (`status`, `read temp` …).
5. Whether `wss://devices.anovaculinary.io` still accepts `supportedAccessories=APO` and PATs. Oven transport is not exercised by this app.
6. The meaning of the A3 `server para` endpoint protocol (`pc.anovaculinary.com:8080`, device↔cloud) and the A3 secret generation format.
7. Nano response header stripping; meaning of Pro status flag bits 0x10000/0x20000 (probably cooking/running).
8. Whether gen‑3 devices need the account binding (PAIRING) before the cloud accepts commands from a third‑party client. Almost certainly yes.

## Reproduction
The APK is not part of this repository. Analysed build: Hermes bytecode v96, bundle source hash `466106d5a3d2737142c1afd2bf19547b78fd8aa1`, 35,412 functions.
1. Unzip the APK into an empty directory. The logic is in `assets/index.android.bundle`.
2. Decompile with [hermes-dec](https://github.com/P1sec/hermes-dec):
   ```bash
   hbc-decompiler assets/index.android.bundle decomp.js
   ```
3. Map Metro modules by scanning for the `__d(factory, <id>, [deps])` calls. Module ids and function names in this document (Hermes "Original name" annotations) refer to that output.
4. The JSON Schemas in `schemas/` come from evaluating the straight-line object construction in the `*Schema` modules (708, 870, 871, 876, 926, 932, 934, 1328).
5. Java side: `jadx -d out <apk>`. The relevant native modules are `com.anovaculinary.android.wifi.WifiConnection` and `WifiDeviceHttpWrapper`, plus `com.bleplx` and `it.innove` (BLE).
6. The APK signing certificate SHA‑1 comes from the APK Signature Scheme v2/v3 block (`keytool` only reads v1 signatures).
