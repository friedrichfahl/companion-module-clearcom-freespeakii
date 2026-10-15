import type { CompanionVariableDefinitions, CompanionVariableValue } from '@companion-module/base'
import type ModuleInstance from './main.js'
import {
	antennaName,
	batteryLevel,
	channelCallers,
	channelParticipants,
	channelTalkers,
	frameErrors,
	gpioActive,
	isCalling,
	isOnline,
	keyState,
	linkQuality,
	lowBatteryPacks,
	packName,
	packRoleId,
	packRoles,
	packs,
	packsForRole,
	participantName,
	portChannels,
	roleKeySlots,
	rssi,
	signalBars,
	talkingKeys,
	timeLeft,
	type SignalThresholds,
} from './resolve.js'
import type { DeviceState } from './state.js'
import type { Endpoint, Role } from './types.js'

// Variable ids are built from stable numeric ids (role id, connection id), so renaming a role in CCM
// does not break buttons that reference them.
export type VariablesSchema = Record<string, CompanionVariableValue>

/** How many keys the role detail page shows (FreeSpeak Edge has 9, V-Series panels more). */
export const DETAIL_KEYS = 12

const ROLE_FIELDS: Record<string, string> = {
	label: 'label',
	pack: 'device label(s) using the role',
	online: 'online (true/false)',
	calling: 'call signal active (true/false)',
	state: 'state word for buttons ("TALK 2", "CALL", "ONLINE", "OFFLINE", "NO DEVICE")',
	battery: 'battery %',
	battery_known: 'battery level reported (true/false, drives the battery meter)',
	battery_text: 'battery as text (e.g. "82%")',
	time_left: 'battery time left (h:mm)',
	rssi: 'RSSI',
	rssi_known: 'RSSI reported (true/false, drives the signal meter)',
	signal: 'signal bars 0-4 from the RSSI (0 = unknown)',
	link: 'link quality',
	link_text: 'link quality as text (e.g. "61%")',
	talking: 'keys talking (e.g. "1,R")',
	antenna: 'antenna / slot',
	status: 'status line for buttons (e.g. "82%  TALK 1", "OFFLINE")',
}

/** Extra fields of the role selected for the detail page (`sel_*`), on top of the role fields. */
const SELECTED_FIELDS: Record<string, string> = {
	role: 'role id (empty when none is selected)',
	device: 'device label',
	type: 'device type (e.g. FSII-BP)',
	firmware: 'device firmware',
	antenna_name: 'antenna (transceiver) the device is connected through',
	slot: 'radio slot on the antenna',
	fer: 'frame error rate',
	battery_type: 'battery type (Li-Ion / Alkaline)',
	index: 'position among the roles in use (e.g. "3/18")',
	key_count: 'number of keys',
	assign: 'role picked to assign to the device (detail page)',
	assign_changed: 'a different role is picked (true/false)',
}

const PORT_FIELDS: Record<string, string> = {
	label: 'label',
	channels: 'channels it is routed to ("none" if none)',
}

const CHANNEL_FIELDS: Record<string, string> = {
	label: 'label',
	talkers: 'who is talking',
	talk_count: 'number of talkers',
	callers: 'who is calling',
	members: 'number of members',
	status: 'status line for buttons: who is talking, else the member count',
}

/** Page navigation requests, for a Companion trigger that runs "Surface: Set to page". */
export interface NavRequest {
	/** Counts up with every request: the trigger watches this. */
	seq: number
	/** The surface that asked (from the button press). */
	surface: string
	/** The page to show: a page number, or 'back'. */
	page: string
}

export interface VariableOptions extends SignalThresholds {
	lowBattery: number
	nav: NavRequest
}

/** Define all variables; returns the ids defined. */
export function UpdateVariableDefinitions(self: ModuleInstance): Set<string> {
	const state = self.state
	const defs: CompanionVariableDefinitions<VariablesSchema> = {
		base_state: { name: 'Device: state' },
		base_uptime: { name: 'Device: uptime (h:mm)' },
		base_version: { name: 'Device: firmware version' },
		base_label: { name: 'Device: label' },
		base_type: { name: 'Device: type' },
		packs_online: { name: 'Devices (beltpacks, stations, panels) online' },
		packs_total: { name: 'Devices registered' },
		low_battery_list: { name: 'Online devices below the low battery threshold' },
		offline_list: { name: 'Offline devices holding a non-default role' },
		last_caller: { name: 'Last call signal: calling device (role), or Companion' },
		last_call_channel: { name: 'Last call signal: channel (when known)' },
		last_call_time: { name: 'Last call signal: time (HH:MM:SS)' },
		nav_seq: { name: 'Page request: counter (a trigger on this switches pages, see help)' },
		nav_surface: { name: 'Page request: surface that asked' },
		nav_page: { name: 'Page request: page number, or "back"' },
	}
	for (const role of packRoles(state)) {
		for (const [field, desc] of Object.entries(ROLE_FIELDS)) {
			defs[`r${role.id}_${field}`] = { name: `Role ${role.label}: ${desc}` }
		}
	}
	for (const [field, desc] of Object.entries({ ...ROLE_FIELDS, ...SELECTED_FIELDS })) {
		defs[`sel_${field}`] = { name: `Selected role (detail page): ${desc}` }
	}
	for (let n = 1; n <= DETAIL_KEYS; n++) {
		defs[`sel_key${n}_name`] = { name: `Selected role: key ${n} name (A-D, 1-n, R = reply)` }
		defs[`sel_key${n}_label`] = { name: `Selected role: key ${n} target ("—" when unassigned)` }
		defs[`sel_key${n}_state`] = { name: `Selected role: key ${n} state (talk / listen / off)` }
	}
	for (const c of state.connections.values()) {
		for (const [field, desc] of Object.entries(CHANNEL_FIELDS)) {
			defs[`ch${c.id}_${field}`] = { name: `Channel ${c.label}: ${desc}` }
		}
	}
	for (const port of state.ports.values()) {
		for (const [field, desc] of Object.entries(PORT_FIELDS)) {
			defs[`port${port.port_id}_${field}`] = { name: `Port ${port.port_label}: ${desc}` }
		}
	}
	for (const g of state.gpis.values()) defs[`gpi${g.id}`] = { name: `GPI ${g.label || g.id}` }
	for (const g of state.gpos.values()) defs[`gpo${g.id}`] = { name: `GPO ${g.label || g.id}` }
	self.setVariableDefinitions(defs)
	return new Set(Object.keys(defs))
}

/** A short word for what a role is doing: talking wins over calling. */
function roleState(state: DeviceState, holders: Endpoint[], online: Endpoint[]): string {
	if (!holders.length) return 'NO DEVICE'
	if (!online.length) return 'OFFLINE'
	const talking = online
		.map((e) => talkingKeys(state, e))
		.filter(Boolean)
		.join(' ')
	if (talking) return `TALK ${talking}`
	if (online.some(isCalling)) return 'CALL'
	return 'ONLINE'
}

/**
 * One short status line for a role button: battery and what the device is doing, or why there is nothing to
 * show. Talking wins over calling; colours on the button carry the rest.
 */
function roleStatus(state: DeviceState, holders: Endpoint[], online: Endpoint[]): string {
	// (on Arcadia an offline pack does not report its role, so "no device" rather than "unassigned")
	if (!holders.length) return 'no device'
	if (!online.length) return 'OFFLINE'
	const parts: string[] = []
	const battery = batteryLevel(online[0])
	if (battery !== undefined) parts.push(`${battery}%`)
	const word = roleState(state, holders, online)
	if (word !== 'ONLINE') parts.push(word)
	return parts.length ? parts.join('  ') : 'online'
}

function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds)) return ''
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return `${h}:${String(m).padStart(2, '0')}`
}

/** The role fields (see ROLE_FIELDS) of one role. `live` false blanks everything that is live status. */
function roleValues(state: DeviceState, role: Role, live: boolean, opts: VariableOptions): VariablesSchema {
	const holders = packsForRole(state, role.id)
	const onlineHolders = live ? holders.filter(isOnline) : []
	const e = live ? (onlineHolders[0] ?? holders[0]) : undefined
	const battery = e ? batteryLevel(e) : undefined
	const level = e ? rssi(e) : undefined
	const link = e ? linkQuality(e) : undefined
	return {
		label: role.label,
		pack: holders.map((h) => h.label).join(', '),
		online: onlineHolders.length > 0,
		calling: onlineHolders.some(isCalling),
		state: live ? roleState(state, holders, onlineHolders) : '',
		battery: battery ?? '',
		battery_known: battery !== undefined,
		battery_text: battery !== undefined ? `${battery}%` : '',
		time_left: e ? timeLeft(e) : '',
		rssi: level ?? '',
		rssi_known: level !== undefined,
		signal: signalBars(level, opts),
		link: link ?? '',
		link_text: link !== undefined ? `${link}%` : '',
		talking: onlineHolders
			.map((x) => talkingKeys(state, x))
			.filter(Boolean)
			.join(' '),
		antenna:
			e && isOnline(e) && typeof e.liveStatus?.antennaIndex === 'number'
				? `${e.liveStatus.antennaIndex + 1}/${(e.liveStatus.antennaSlot ?? 0) + 1}`
				: '',
		status: live ? roleStatus(state, holders, onlineHolders) : '',
	}
}

/** Blank values for every field of the selected role, for when nothing is selected (or the role is gone). */
function blankSelected(): VariablesSchema {
	const v: VariablesSchema = {}
	for (const field of Object.keys({ ...ROLE_FIELDS, ...SELECTED_FIELDS })) v[`sel_${field}`] = ''
	for (const flag of ['online', 'calling', 'battery_known', 'rssi_known', 'assign_changed']) v[`sel_${flag}`] = false
	v.sel_signal = 0
	v.sel_label = 'No role selected'
	v.sel_state = 'SELECT A ROLE'
	for (let n = 1; n <= DETAIL_KEYS; n++) {
		v[`sel_key${n}_name`] = ''
		v[`sel_key${n}_label`] = ''
		v[`sel_key${n}_state`] = ''
	}
	return v
}

/** The `sel_*` variables: the role fields of the selected role plus device details and its keys. */
function selectedValues(state: DeviceState, live: boolean, opts: VariableOptions): VariablesSchema {
	const v = blankSelected()
	const role = state.selectedRole === undefined ? undefined : state.roles.get(state.selectedRole)
	if (!role || !packRoles(state).includes(role)) return v
	for (const [field, value] of Object.entries(roleValues(state, role, live, opts))) v[`sel_${field}`] = value

	const holder = packsForRole(state, role.id)[0]
	const e = live ? holder : undefined
	const inUse = packRoles(state).filter((r) => packsForRole(state, r.id).length > 0)
	const pos = inUse.indexOf(role)
	v.sel_role = role.id
	v.sel_device = holder?.label ?? ''
	v.sel_type = holder?.type ?? ''
	v.sel_firmware = holder?.versionSW ?? ''
	v.sel_antenna_name = e ? antennaName(state, e) : ''
	v.sel_slot = e && isOnline(e) && typeof e.liveStatus?.antennaSlot === 'number' ? e.liveStatus.antennaSlot + 1 : ''
	const fer = e ? frameErrors(e) : undefined
	v.sel_fer = fer ?? ''
	v.sel_battery_type = e && isOnline(e) && typeof e.liveStatus?.batteryType === 'string' ? e.liveStatus.batteryType : ''
	v.sel_index = pos >= 0 ? `${pos + 1}/${inUse.length}` : ''

	const slots = roleKeySlots(state, role, holder)
	v.sel_key_count = slots.length
	slots.slice(0, DETAIL_KEYS).forEach((slot, i) => {
		v[`sel_key${i + 1}_name`] = slot.name
		v[`sel_key${i + 1}_label`] = slot.label
		v[`sel_key${i + 1}_state`] = live ? keyState(holder, slot.index) : ''
	})

	const assign = state.assignRole === undefined ? undefined : state.roles.get(state.assignRole)
	v.sel_assign = (assign ?? role).label
	v.sel_assign_changed = !!assign && assign.id !== role.id
	return v
}

/** Compute every variable value from the current state. The caller diffs and only sends changes. */
export function computeVariableValues(state: DeviceState, connected: boolean, opts: VariableOptions): VariablesSchema {
	const v: VariablesSchema = {}
	// while disconnected or reloading, live values are unknown: show blanks instead of stale tallies
	const live = connected && state.ready
	const all = packs(state)
	const online = live ? all.filter(isOnline) : []

	v.base_state = connected ? state.device?.state || 'Connected' : 'Disconnected'
	v.base_uptime = state.device ? formatUptime(state.device.uptime) : ''
	v.base_version = state.device?.version ?? ''
	v.base_label = state.device?.label ?? ''
	v.base_type = state.device?.type ?? ''
	v.packs_online = live ? online.length : ''
	v.packs_total = all.length
	v.low_battery_list = !live
		? ''
		: lowBatteryPacks(state, opts.lowBattery)
				.map((e) => `${packName(state, e)} (${batteryLevel(e)}%)`)
				.join(', ')
	v.offline_list = !live
		? ''
		: all
				.filter((e) => {
					if (isOnline(e)) return false
					// FSII: the assigned role is flagged default; Arcadia: any associated roleset that is not the default
					if (e.role) return !e.role.isDefault
					const roleId = packRoleId(e, state)
					const role = roleId === undefined ? undefined : state.roles.get(roleId)
					return role !== undefined && !role.isDefault
				})
				.map((e) => packName(state, e))
				.join(', ')
	v.last_caller = state.lastCall?.label ?? ''
	v.last_call_channel = state.lastCall?.channel ?? ''
	v.last_call_time = state.lastCall ? state.lastCall.time.toTimeString().slice(0, 8) : ''
	v.nav_seq = opts.nav.seq
	v.nav_surface = opts.nav.surface
	v.nav_page = opts.nav.page

	for (const role of packRoles(state)) {
		for (const [field, value] of Object.entries(roleValues(state, role, live, opts))) v[`r${role.id}_${field}`] = value
	}
	Object.assign(v, selectedValues(state, live, opts))

	for (const port of state.ports.values()) {
		const p = `port${port.port_id}_`
		v[`${p}label`] = port.port_label
		v[`${p}channels`] = !live
			? ''
			: portChannels(state, port.port_id)
					.map((id) => state.connections.get(id)?.label ?? `#${id}`)
					.join(', ') || 'none'
	}

	for (const c of state.connections.values()) {
		const talkers = live ? channelTalkers(state, c.id) : []
		const members = live ? channelParticipants(state, c.id).length : undefined
		const p = `ch${c.id}_`
		v[`${p}label`] = c.label
		v[`${p}talkers`] = talkers.map((t) => participantName(state, t)).join(', ')
		v[`${p}talk_count`] = live ? talkers.length : ''
		v[`${p}callers`] = !live
			? ''
			: channelCallers(state, c.id)
					.map((t) => participantName(state, t))
					.join(', ')
		v[`${p}members`] = members ?? ''
		v[`${p}status`] =
			members === undefined
				? ''
				: talkers.length
					? v[`${p}talkers`]
					: members === 1
						? '1 member'
						: members
							? `${members} members`
							: 'empty'
	}

	for (const g of state.gpis.values()) v[`gpi${g.id}`] = live && gpioActive(state, 'gpi', g)
	for (const g of state.gpos.values()) v[`gpo${g.id}`] = live && gpioActive(state, 'gpo', g)
	return v
}
