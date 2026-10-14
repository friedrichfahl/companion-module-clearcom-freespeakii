import type { DeviceState } from './state.js'
import {
	asList,
	isPlainObject,
	NO_ROLE,
	type Endpoint,
	type Gpio,
	type KeyState,
	type Participant,
	type Port,
	type Role,
	type RoleKey,
} from './types.js'

// Accessors in this file read the raw CCM payloads of both Arcadia and FreeSpeak II, which name some fields
// differently (e.g. `RSSI` vs `rssi`, live role vs association). Everything else goes through them.

/** FSII-BP reply key index (keys A-D are 0-3). */
export const FSII_REPLY_KEY = 4

/** Endpoint types whose keysets carry a different type name on Arcadia. */
const KEYSET_TYPE_ALIASES: Record<string, string[]> = {
	'FSE-BP': ['E-BP', 'FSE-BP'],
	'E-BP': ['E-BP', 'FSE-BP'],
	'V-SERIES': ['V12', 'V12D', 'V24', 'V24D', 'V32', 'V32D'],
}

export const isGateway = (e: Endpoint): boolean =>
	e.isGateway === true || /antenna|tcvr|transceiver|gateway/i.test(e.type ?? '')

/** A user device: beltpack, HelixNet station or keypanel (anything that is not a transceiver/antenna). */
export const isPack = (e: Endpoint): boolean => !isGateway(e)

export const isOnline = (e: Endpoint): boolean => String(e.liveStatus?.status ?? '').toLowerCase() === 'online'

/**
 * The role a device is using now.
 * - Arcadia: the roleset association, as a roleset id (`association.dpId`) or, on 4.2.83, as a roleset gid
 *   (`liveStatus.rolesetAssociation` while online, `settings.rolesetAssociation` for the assigned role).
 * - FSII: the live role while online, else the assigned role.
 */
export function packRoleId(e: Endpoint, state: DeviceState): number | undefined {
	const assoc = e.liveStatus?.association?.dpId ?? e.association?.dpId
	if (typeof assoc === 'number') return assoc
	const byGid = (gid: unknown) => (typeof gid === 'string' && gid ? state.roleIdByGid(gid) : undefined)
	const online = isOnline(e)
	const rolesetId =
		(online ? byGid(e.liveStatus?.rolesetAssociation) : undefined) ??
		byGid(e.settings?.rolesetAssociation) ??
		byGid(e.liveStatus?.rolesetAssociation)
	if (rolesetId !== undefined) return rolesetId
	const live = e.liveStatus?.role
	if (online && typeof live === 'number' && live !== NO_ROLE) return live
	return e.role?.id ?? e.settings?.default_role
}

export function packs(state: DeviceState): Endpoint[] {
	return [...state.endpoints.values()].filter(isPack)
}

const byLabel = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Roles that can be targeted: Arcadia rolesets, and FSII roles for user devices (not transceiver defaults).
 * Sorted by label, numbers by value ("2 Cam" before "10 Cam"), so presets and dropdowns list them by name.
 */
export function packRoles(state: DeviceState): Role[] {
	const packTypes = new Set(packs(state).map((e) => e.type))
	return [...state.roles.values()]
		.filter((r) => r.type === '' || r.type.endsWith('-BP') || packTypes.has(r.type))
		.sort((a, b) => byLabel.compare(a.label, b.label) || a.id - b.id)
}

/** All devices using a role. Online devices first. */
export function packsForRole(state: DeviceState, roleId: number): Endpoint[] {
	return packs(state)
		.filter((e) => packRoleId(e, state) === roleId)
		.sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)))
}

/** Display name for a device: its role label, falling back to the device label. */
export function packName(state: DeviceState, e: Endpoint): string {
	const roleId = packRoleId(e, state)
	return (roleId !== undefined && state.roles.get(roleId)?.label) || e.role?.label || e.label
}

/** The endpoint behind a channel participant (FSII uses numeric ids, Arcadia resource paths / gids). */
export function endpointForParticipant(state: DeviceState, p: Participant): Endpoint | undefined {
	const numericId = typeof p.id === 'number' ? p.id : /^\d+$/.test(String(p.id ?? '')) ? Number(p.id) : undefined
	if (numericId !== undefined) {
		const e = state.endpoints.get(numericId)
		if (e && (!p.res || !e.res || e.res === p.res)) return e
	}
	if (!p.res && !p.gid) return undefined
	for (const e of state.endpoints.values()) {
		if ((p.res && e.res === p.res) || (p.gid && e.gid === p.gid)) return e
	}
	return undefined
}

/** The base port behind a channel participant. */
export function portForParticipant(state: DeviceState, p: Participant): Port | undefined {
	for (const port of state.ports.values()) {
		if ((p.res && port.res === p.res) || (p.gid && port.gid === p.gid)) return port
	}
	const id = Number(/\/ports\/(\d+)$/.exec(p.res ?? '')?.[1] ?? Number.NaN)
	return Number.isFinite(id) ? state.ports.get(id) : undefined
}

/** Label for any connection participant (devices show their role, ports their label). */
export function participantName(state: DeviceState, p: Participant): string {
	const e = endpointForParticipant(state, p)
	if (e) return packName(state, e)
	return p.label ?? portForParticipant(state, p)?.port_label ?? String(p.id ?? '')
}

// --- target selection -------------------------------------------------------------------------

/** Dropdown ids: `r:<roleId>` targets whichever device holds a role, `p:<endpointId>` a physical device. */
export type TargetId = `r:${number}` | `p:${number}`

/**
 * Resolve dropdown targets plus an optional free-text list ("Camera 1, Stage Left, 12345") to devices.
 * Free text matches role labels, device labels or device ids, case-insensitively.
 */
export function resolveTargets(state: DeviceState, targets: unknown, names?: unknown): Endpoint[] {
	const out = new Map<number, Endpoint>()
	const add = (list: Endpoint[]) => list.forEach((e) => out.set(e.id, e))

	for (const t of Array.isArray(targets) ? targets : []) {
		const m = /^([rp]):(\d+)$/.exec(String(t))
		if (!m) continue
		const id = Number(m[2])
		if (m[1] === 'r') add(packsForRole(state, id))
		else {
			const e = state.endpoints.get(id)
			if (e && isPack(e)) add([e])
		}
	}

	for (const raw of (typeof names === 'string' ? names : '').split(',')) {
		const name = raw.trim().toLowerCase()
		if (!name) continue
		const role = packRoles(state).find((r) => r.label.toLowerCase() === name)
		if (role) {
			add(packsForRole(state, role.id))
			continue
		}
		add(packs(state).filter((e) => e.label.toLowerCase() === name || String(e.id) === name))
	}
	return [...out.values()]
}

// --- keys -------------------------------------------------------------------------------------

/** The key layout of a role for a given device type (Arcadia rolesets hold one keyset per device type). */
export function roleKeysFor(role: Role | undefined, endpointType: string): RoleKey[] | undefined {
	if (!role) return undefined
	for (const t of KEYSET_TYPE_ALIASES[endpointType] ?? [endpointType]) if (role.keys[t]) return role.keys[t]
	return role.keys['*'] ?? Object.values(role.keys)[0]
}

/** One key of a device, with its 0-based key index. */
export interface IndexedKeyState {
	k: KeyState
	idx: number
}

/**
 * The key states of a device. FSII sends an array (position = key). Arcadia 4.2.83 does not send an array, so an
 * object keyed by key index is accepted too. `keysetIndex` wins over the position/key when the device sends it.
 */
export function keyStates(e: Endpoint | undefined): IndexedKeyState[] {
	const raw: unknown = e?.liveStatus?.keyState
	const entries: [string, unknown][] = Array.isArray(raw)
		? raw.map((k, i) => [String(i), k])
		: isPlainObject(raw)
			? Object.entries(raw)
			: []
	const out: IndexedKeyState[] = []
	for (const [key, k] of entries) {
		if (!isPlainObject(k)) continue
		const fromKey = Number(key)
		const idx =
			typeof k.keysetIndex === 'number'
				? k.keysetIndex
				: Number.isInteger(fromKey) && fromKey >= 0
					? fromKey
					: out.length
		out.push({ k, idx })
	}
	return out
}

export const isKeyTalking = (k: KeyState): boolean =>
	typeof k.currentState === 'string' && k.currentState.toLowerCase().includes('talk')

export function isReplyKey(state: DeviceState, e: Endpoint, index: number): boolean {
	const roleId = packRoleId(e, state)
	const keys = roleKeysFor(roleId === undefined ? undefined : state.roles.get(roleId), e.type)
	const key = keys?.find((k) => k.index === index)
	if (key) return key.isReply
	return e.type === 'FSII-BP' && index === FSII_REPLY_KEY
}

/** Key selector: 'any', 'reply', or a 0-based key index. */
export type KeySelector = 'any' | 'reply' | number

export function isTalking(state: DeviceState, e: Endpoint, key: KeySelector = 'any'): boolean {
	if (!isOnline(e)) return false
	return keyStates(e).some(({ k, idx }) => {
		if (!isKeyTalking(k)) return false
		if (key === 'any') return true
		if (key === 'reply') return isReplyKey(state, e, idx)
		return idx === key
	})
}

/** Keys currently talking, e.g. "1,R" (1-based, R = reply). */
export function talkingKeys(state: DeviceState, e: Endpoint): string {
	if (!isOnline(e)) return ''
	return keyStates(e)
		.filter(({ k }) => isKeyTalking(k))
		.map(({ idx }) => (isReplyKey(state, e, idx) ? 'R' : String(idx + 1)))
		.join(',')
}

// --- live status helpers ----------------------------------------------------------------------

export const isCalling = (e: Endpoint): boolean => isOnline(e) && !!e.liveStatus?.callState

export function batteryLevel(e: Endpoint): number | undefined {
	const b = e.liveStatus?.batteryLevel
	return isOnline(e) && typeof b === 'number' ? b : undefined
}

export function rssi(e: Endpoint): number | undefined {
	const v = e.liveStatus?.RSSI ?? e.liveStatus?.rssi
	return isOnline(e) && typeof v === 'number' ? v : undefined
}

export function linkQuality(e: Endpoint): number | undefined {
	const v = e.liveStatus?.linkQuality
	return isOnline(e) && typeof v === 'number' ? v : undefined
}

export function timeLeft(e: Endpoint): string {
	const l = e.liveStatus?.longevity
	if (!isOnline(e) || !l) return ''
	return `${l.hours}:${String(l.minutes).padStart(2, '0')}`
}

export function channelParticipants(state: DeviceState, connectionId: number): Participant[] {
	return asList<Participant>(state.connectionLive.get(connectionId)?.participants)
}

/**
 * Whether a device is talking on a channel. FSII leaves `events.talk` false, so use the device's own key state
 * (pushed instantly via EndpointUpdated) mapped through its role's keys. The reply key has no fixed channel,
 * and roles may lack key layouts, so fall back to the participant `joinState` (refetched, can lag ~1 s).
 */
function packTalksOn(state: DeviceState, e: Endpoint, p: Participant, connectionId: number): boolean {
	if (p.events?.talk) return true
	if (!isTalking(state, e)) return false
	const roleId = packRoleId(e, state)
	const keys = roleKeysFor(roleId === undefined ? undefined : state.roles.get(roleId), e.type)
	for (const { k, idx } of keyStates(e)) {
		if (!isKeyTalking(k)) continue
		const key = keys?.find((s) => s.index === idx)
		if (key?.connections.length && !key.isReply) {
			if (key.connections.includes(connectionId)) return true
		} else if (p.joinState?.startsWith('Talk')) return true
	}
	return false
}

export const channelTalkers = (state: DeviceState, connectionId: number): Participant[] =>
	channelParticipants(state, connectionId).filter((p) => {
		const e = endpointForParticipant(state, p)
		return e && isPack(e) ? packTalksOn(state, e, p, connectionId) : !!p.events?.talk
	})

/** Members with a call signal: the participant's own call flag, or a member device whose callState is active. */
export function channelCallers(state: DeviceState, connectionId: number): Participant[] {
	return channelParticipants(state, connectionId).filter((p) => {
		const e = endpointForParticipant(state, p)
		return p.events?.call || (e !== undefined && isCalling(e))
	})
}

export function portInChannel(state: DeviceState, portId: number, connectionId: number): boolean {
	const port = state.ports.get(portId)
	if (!port) return false
	if (String(connectionId) in (port.port_connections ?? {})) return true
	return channelParticipants(state, connectionId).some((p) => portForParticipant(state, p) === port)
}

/** Connection ids a port is currently joined to. */
export function portChannels(state: DeviceState, portId: number): number[] {
	return [...state.connections.keys()].filter((c) => portInChannel(state, portId, c))
}

export function lowBatteryPacks(state: DeviceState, threshold: number): Endpoint[] {
	return packs(state).filter((e) => {
		const b = batteryLevel(e)
		return b !== undefined && b < threshold
	})
}

/** Roles that should be online but have no online device. */
export function missingRoles(state: DeviceState, watchedRoles: number[]): Role[] {
	return watchedRoles
		.map((id) => state.roles.get(id))
		.filter((r): r is Role => !!r && !packsForRole(state, r.id).some(isOnline))
}

/** GPI/GPO active state, honouring the device's GPI polarity. */
export function gpioActive(state: DeviceState, kind: 'gpi' | 'gpo', g: Gpio | undefined): boolean {
	const status = g?.liveStatus?.status
	if (typeof status !== 'boolean') return false
	return kind === 'gpi' && state.gpiActiveLow ? !status : status
}
