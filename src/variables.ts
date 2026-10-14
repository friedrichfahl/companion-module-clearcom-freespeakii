import type { CompanionVariableDefinitions, CompanionVariableValue } from '@companion-module/base'
import type ModuleInstance from './main.js'
import {
	batteryLevel,
	channelCallers,
	channelParticipants,
	channelTalkers,
	gpioActive,
	isCalling,
	isOnline,
	linkQuality,
	lowBatteryPacks,
	packName,
	packRoleId,
	packRoles,
	packs,
	packsForRole,
	participantName,
	portChannels,
	rssi,
	talkingKeys,
	timeLeft,
} from './resolve.js'
import type { DeviceState } from './state.js'
import type { Endpoint } from './types.js'

// Variable ids are built from stable numeric ids (role id, connection id), so renaming a role in CCM
// does not break buttons that reference them.
export type VariablesSchema = Record<string, CompanionVariableValue>

const ROLE_FIELDS: Record<string, string> = {
	label: 'label',
	pack: 'device label(s) using the role',
	online: 'online (true/false)',
	calling: 'call signal active (true/false)',
	battery: 'battery %',
	battery_known: 'battery level reported (true/false, drives the battery gauge)',
	battery_text: 'battery as text (e.g. "82%")',
	time_left: 'battery time left (h:mm)',
	rssi: 'RSSI',
	link: 'link quality',
	talking: 'keys talking (e.g. "1,R")',
	antenna: 'antenna / slot',
	status: 'status line for buttons (e.g. "82%  TALK 1", "OFFLINE")',
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
	}
	for (const role of packRoles(state)) {
		for (const [field, desc] of Object.entries(ROLE_FIELDS)) {
			defs[`r${role.id}_${field}`] = { name: `Role ${role.label}: ${desc}` }
		}
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
	const talking = online
		.map((e) => talkingKeys(state, e))
		.filter(Boolean)
		.join(' ')
	if (talking) parts.push(`TALK ${talking}`)
	else if (online.some(isCalling)) parts.push('CALL')
	return parts.length ? parts.join('  ') : 'online'
}

function formatUptime(seconds: number): string {
	if (!Number.isFinite(seconds)) return ''
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return `${h}:${String(m).padStart(2, '0')}`
}

/** Compute every variable value from the current state. The caller diffs and only sends changes. */
export function computeVariableValues(state: DeviceState, connected: boolean, lowBattery: number): VariablesSchema {
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
		: lowBatteryPacks(state, lowBattery)
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

	for (const role of packRoles(state)) {
		const holders = packsForRole(state, role.id)
		const onlineHolders = live ? holders.filter(isOnline) : []
		const e = live ? (onlineHolders[0] ?? holders[0]) : undefined
		const p = `r${role.id}_`
		v[`${p}label`] = role.label
		v[`${p}pack`] = holders.map((h) => h.label).join(', ')
		v[`${p}online`] = onlineHolders.length > 0
		v[`${p}calling`] = onlineHolders.some(isCalling)
		const battery = e ? batteryLevel(e) : undefined
		v[`${p}battery`] = battery ?? ''
		v[`${p}battery_known`] = battery !== undefined
		v[`${p}battery_text`] = battery !== undefined ? `${battery}%` : ''
		v[`${p}time_left`] = e ? timeLeft(e) : ''
		v[`${p}rssi`] = e ? (rssi(e) ?? '') : ''
		v[`${p}link`] = e ? (linkQuality(e) ?? '') : ''
		v[`${p}talking`] = onlineHolders
			.map((x) => talkingKeys(state, x))
			.filter(Boolean)
			.join(' ')
		v[`${p}antenna`] =
			e && isOnline(e) && typeof e.liveStatus?.antennaIndex === 'number'
				? `${e.liveStatus.antennaIndex + 1}/${(e.liveStatus.antennaSlot ?? 0) + 1}`
				: ''
		v[`${p}status`] = live ? roleStatus(state, holders, onlineHolders) : ''
	}

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
		const p = `ch${c.id}_`
		v[`${p}label`] = c.label
		v[`${p}talkers`] = talkers.map((t) => participantName(state, t)).join(', ')
		v[`${p}talk_count`] = live ? talkers.length : ''
		v[`${p}callers`] = !live
			? ''
			: channelCallers(state, c.id)
					.map((t) => participantName(state, t))
					.join(', ')
		v[`${p}members`] = live ? channelParticipants(state, c.id).length : ''
	}

	for (const g of state.gpis.values()) v[`gpi${g.id}`] = live && gpioActive(state, 'gpi', g)
	for (const g of state.gpos.values()) v[`gpo${g.id}`] = live && gpioActive(state, 'gpo', g)
	return v
}
