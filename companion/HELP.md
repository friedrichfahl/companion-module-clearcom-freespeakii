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

Each dropdown also lists physical devices (`Device FSII-BP-12345`) for spares with no meaningful role, and
**Selected role (role detail page)**, which follows the role shown on the role detail page.

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
| Role detail: show a role       | Selects the role for the detail page, optionally opening the page     |
| Role detail: previous / next   | Steps through the roles in use                                        |
| Role detail: back              | Asks Companion to switch the surface back to the previous page        |
| Role detail: pick / assign     | Picks another role for the device of the selected role, then applies  |

Reboot, reset, firmware, licence and configuration editing are deliberately not included.

### Feedbacks

- **Role / device:**
  - talking or listening: any key, the reply key, or a specific key
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
- **Role detail:** a role is shown on the detail page, the selected role has a key number, another role is
  picked to assign.

### Variables

Variables use numeric ids, so renaming a role or channel in CCM does not break your buttons.

- **Per role** (`r<roleId>_...`):
  - `label`, `pack`, `online`, `calling`, `state` (`TALK 2`, `CALL`, `ONLINE`, `OFFLINE`, `NO DEVICE`)
  - `battery`, `battery_known`, `time_left`, `antenna`
  - `rssi`, `rssi_known`, `signal` (0-4 bars), `link`, `link_text`
  - `talking`: keys talking, e.g. `1,R` = key 1 and reply
- **Selected role** (`sel_...`): the same fields for the role on the detail page, plus `device`, `type`,
  `firmware`, `antenna_name`, `slot`, `fer`, `index`, `assign`, and per key `sel_key<n>_name`, `_label`, `_state`
- **Page requests:** `nav_seq`, `nav_surface`, `nav_page` (see _Role detail page_)
- **Per channel** (`ch<connectionId>_...`): `label`, `talkers`, `talk_count`, `callers`, `members`, `status`
- **Device:** `base_state`, `base_uptime`, `base_version`, `base_label`, `base_type`
- **Totals and alerts:**
  - `packs_online`, `packs_total`
  - `low_battery_list`, `offline_list`
  - `last_caller`, `last_call_channel`, `last_call_time`
- **GPIO:** `gpi<n>`, `gpo<n>`

### Presets

All presets are layered buttons. Placed as **linked** presets (the Companion 5.1 default) they update themselves
when the module updates. Text comes from variables, so renaming a role, channel or port in CCM updates the
buttons. Colours mean the same everywhere: **red** = talking, **amber** = call signal (breathing),
**green** = routed / active / listening, **blue ring** = shown on the role detail page, **grey** = offline.

- **Crew:** one button per role with its name, state, a **battery meter** and **signal bars** from the RSSI.
  - **Press:** show the role on the role detail page.
  - **Hold 0.8 s:** remote mic kill for whoever holds the role. While you hold, the button says `HOLD: RMK`.
  - Wired devices show the device name instead of meters. Roles in use come first; unused roles are separate.
- **Role detail:** a page about one role (see below): role and device, battery, RSSI, link quality and frame
  errors, antenna and slot, firmware, hold to call, RMK, every key with its tally, previous / next role, and
  **assign another role to the device** (pick with ◀ / ▶, hold 1 s to apply).
- **Battery:** a ring meter per role on a wireless pack, with percentage and time left. Press for details.
- **Key tally:** for each role in use, a button per key with the key name, what it talks to and whether it is a
  channel, direct or reply key. Red while talking, green bar while listening. Unassigned keys are left out.
- **Channels:** who is talking on each channel and how many members it has; hold to call everyone on it.
- **Mic kill:** RMK per role, bright red with a flashing ring while that role talks. **RMK ALL** only appears
  when it is enabled in the connection settings, and needs a 1 second hold.
- **Port routing:** per port, a button showing where it is routed, then a switch for each channel with members.
- **Port call:** hold to send a call signal out of a port (only ports that support it).
- **GPIO:** GPO switches, GPI lamps, and GPI triggers on Arcadia.
- **Status & alerts:** connection and devices online, low batteries, crew check (red when a role that was
  online when you placed the button has no device online), last call (amber while a call is active).

Battery meters are red below the low battery threshold from the connection settings, amber below 50 % and green
above. Signal bars: 4 from _RSSI: solid signal from_ + 10, 3 from that value, 2 down to _RSSI: poor signal
below_, 1 red bar under it. FreeSpeak II / DECT packs report RSSI on a 0-60 scale; Clear-Com recommends 30 or more.

The meters are also offered as elements for your own buttons: **Clear-Com: battery meter** and **Clear-Com:
signal bars** in the element list of any layered button. Wire their level to a variable, e.g.
`$(arcadia:r12_battery)` or `$(arcadia:r12_signal)`.

### Role detail page

1. Make an empty page, e.g. page 2, and place the **Role detail** presets on it (on a Stream Deck XL: the
   first row from the "Role, device, RF and actions" group, the keys below).
2. In the connection settings, set **Role detail page** to that page number.
3. Companion does not let a module switch pages itself, so add one **trigger** (Triggers → Add):
   - **Event:** _On variable change_, variable to watch: `nav_seq` of this connection.
   - **Action:** _Surface: Set to page_. Switch both fields to expressions:
     - Surface / group: `$(arcadia:nav_surface)`
     - Page: `$(arcadia:nav_page)`

Now a short press on a role button opens the detail page on the surface you pressed, and **Back** returns to
the page you came from. Without the trigger, role buttons still select the role; the detail page then shows it
wherever you have placed it.

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
