## Clear-Com Arcadia / FreeSpeak II

_Requires Companion 5.1 or newer._

Monitors and controls a Clear-Com **Arcadia Central Station** or a **FreeSpeak II base station** (FSII-BASE-II)
through the same interface the CCM web page uses. You get:

- live talk tallies per role, key and channel
- battery and signal status
- call signals and remote mic kill
- role changes and port routing
- GPIO

### Setup

1. Choose the **Device**: _Arcadia Central Station_ or _FreeSpeak II base_.
2. Enter the **IP address or hostname** of the device.
3. **Arcadia only:** enter the CCM **username** (default `admin`) and **password**. The admin password is shown in
   the Arcadia front panel menu. The FreeSpeak II base has no login.
4. Leave **Device ID** at `1` unless the device is part of a linked system.

### Targeting roles, not beltpacks

Actions and feedbacks target **roles** (e.g. "Camera 1"), not physical devices. A button follows whoever is using
the role, even when crew swap packs. On Arcadia these are the roles (rolesets) from CCM, and they cover:

- FreeSpeak II, FreeSpeak Edge and FreeSpeak Icon beltpacks
- HelixNet beltpacks and stations
- keypanels

Each dropdown also lists physical devices (`Device FSII-BP-12345`) for spares with no meaningful role.

You can select several roles at once. You can also type names into **Or by name**: comma-separated role labels,
device labels or device ids. This field accepts variables and expressions.

### Actions

| Action                         | Notes                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| Call signal: role / device     | Pulse, on, off or toggle, with optional call text                     |
| Call signal: whole channel     | Calls every device and 2W/4W port on a partyline                      |
| Remote mic kill: role / device | Turns off the talk keys on the selected devices                       |
| Remote mic kill: all devices   | Must be enabled in the connection settings                            |
| Change device role             | _Learn_ fills in the device's current role                            |
| Route port to channel          | Join, leave or toggle a channel for a 2W, 4W, program or station port |
| Call signal: port              | Call signal out of a 2W/4W port (Arcadia: 4-wire + GPIO ports only)   |
| Set GPO                        | Force on/off, toggle, or release back to automatic                    |
| Trigger GPI (Arcadia)          | Assert or release a GPI as if the physical input changed              |

Reboot, reset, firmware, licence and configuration editing are deliberately not included.

### Feedbacks

- **Role / device:**
  - talking: any key, the reply key, or a specific key
  - online
  - call active
  - battery or link quality below a threshold

  Each one takes any mix of roles and devices and is true if any of them match. Stack them on one button, e.g.:
  - grey = offline (via an inverted "is online")
  - orange = low battery
  - amber = calling
  - red = talking

- **Channel:** someone is talking, someone is calling. **Port** is routed to a channel.
- **Any** online device is below a battery threshold. **Any** expected role has no device online.
- **GPI / GPO** state, and **connected** to the device.

### Variables

Variables use numeric ids, so renaming a role or channel in CCM does not break your buttons.

- **Per role** (`r<roleId>_...`):
  - `label`, `pack`, `online`, `calling`
  - `battery`, `time_left`, `rssi`, `link`, `antenna`
  - `talking`: keys talking, e.g. `1,R` = key 1 and reply
- **Per channel** (`ch<connectionId>_...`): `label`, `talkers`, `talk_count`, `callers`, `members`
- **Device:** `base_state`, `base_uptime`, `base_version`, `base_label`, `base_type`
- **Totals and alerts:**
  - `packs_online`, `packs_total`
  - `low_battery_list`, `offline_list`
  - `last_caller`, `last_call_channel`, `last_call_time`
- **GPIO:** `gpi<n>`, `gpo<n>`

### Presets

Button text comes from variables, so renaming a role, channel or port in CCM updates your buttons. Colours mean
the same everywhere: **red** = talking, **amber** = call signal, **orange** = low battery, **grey** = offline,
**green** = routed / active.

- **Crew:** one button per role, showing its name, a status line such as `82%  TALK 2` or `OFFLINE`, and a battery
  bar. Hold the button to call whoever has the role. Roles in use are listed first; unused roles are grouped
  separately.
- **Battery:** a ring meter per role on a wireless pack, with percentage and time left.

  The meters (Companion gauges) are red below the low battery threshold from the connection settings, amber
  below 50 % and green above. They are hidden for wired HelixNet devices and while a pack is offline.

- **Key tally:** for each role in use, a button per key, labelled with what the key talks to (`on Camera`,
  `to Director`, `Reply`). It turns red while that key talks. Keys with nothing assigned are left out.
- **Channels:** who is talking on each channel; hold to call everyone on it.
- **Mic kill:** RMK per role, red while that role talks. **RMK ALL** only appears when it is enabled in the
  connection settings, and needs a 1 second hold.
- **Port routing:** per port, a button showing where it is routed, then a toggle for each channel with members.
- **Port call:** hold to send a call signal out of a port (only ports that support it).
- **GPIO:** GPO toggles, GPI indicators, and GPI triggers on Arcadia.
- **Status & alerts:**
  - connection and devices online
  - low battery list
  - crew check, which turns red when a role that was online when you placed the button has no device online
  - last call, which shows amber while a call is active

### Notes

- **Call signals always end:** pulses and held calls (press = on, release = off) are turned off again even if
  the connection drops or the settings change in between. The "off" goes to exactly the devices that were
  called, even if one has since changed role.
- **Port call signals** are sent with the same 4-second timeout the CCM web page uses, so a held port call may
  end after 4 s on the device.

- **FreeSpeak II security:** the base's control interface has no authentication. Anyone who can reach it on
  port 80 can do everything this module does. Keep it on an isolated production network.
- **Arcadia:** the module logs in with the CCM credentials and refreshes its login token automatically.
- **GPI polarity:** Arcadia reports GPIs active-low, and the module accounts for this. If GPI feedbacks show the
  opposite of the physical input, tick **Invert GPI state** in the connection settings.
- **Firmware:** the FreeSpeak II driver was verified on base firmware 1.6.15. The Arcadia driver was verified on
  Arcadia firmware 4.2.83.11-0. The log shows a warning with your firmware version;
  please report what works and what does not. On untested firmware the module also writes one sample of each
  device message to the log at **Debug** level, so unexpected formats can be spotted and fixed.
- **Module errors:** if the module cannot handle something the device sent, the connection shows a warning
  ("Module error: …") instead of a connection failure, keeps running, and logs the error once.
