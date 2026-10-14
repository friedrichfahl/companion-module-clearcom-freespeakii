// Shapes returned by the Clear-Com CCM API (Arcadia and FreeSpeak II base). Both products share one API family
// (`/api/1/...`, `/api/2/...` + socket.io 2.x), but field names differ in places, so everything here is typed
// loosely and read through the tolerant accessors in resolve.ts. Unknown fields are passed through untouched.

export type DeviceKind = 'arcadia' | 'fsii'

export interface KeyState {
	keysetIndex?: number
	currentState?: string // 'off' | 'listen' | 'talk' | 'talk+listen' | ...
	volume?: number
	[key: string]: unknown
}

export interface EndpointLiveStatus {
	status?: 'online' | 'offline' | string
	/** FSII: live role id (65535 while offline). */
	role?: number
	/** Arcadia: the roleset the endpoint is associated with (`dpId` = roleset id). */
	association?: { dpId?: number; gid?: string; [key: string]: unknown }
	/** Arcadia 4.2.83: gid of the roleset the device is using (while online). */
	rolesetAssociation?: string
	antennaIndex?: number
	antennaSlot?: number
	/** FSII sends an array. Arcadia (seen on 4.2.83) sends something else, so read it through `keyStates()`. */
	keyState?: KeyState[] | Record<string, KeyState>
	batteryType?: string
	batteryLevel?: number
	longevity?: { hours: number; minutes: number }
	/** FSII reports `RSSI`, the published schema says `rssi`. */
	RSSI?: number
	rssi?: number
	linkQuality?: number
	frameErrorRate?: number
	callState?: number | boolean
	gid?: string
	[key: string]: unknown
}

export interface Endpoint {
	id: number
	device_id?: number
	label: string
	type: string // 'FSII-BP' | 'FSII-Antenna' | 'FSE-BP' | 'HBP-2X' | 'HMS-4X' | 'V-SERIES' | ...
	res?: string
	gid?: string
	/** Arcadia: transceivers / antennas are flagged as gateways. */
	isGateway?: boolean
	liveStatus?: EndpointLiveStatus
	role?: { id: number; label?: string; isDefault?: boolean; res?: string }
	association?: { dpId?: number; gid?: string; [key: string]: unknown }
	/** `rolesetAssociation`: Arcadia 4.2.83, gid of the roleset assigned to the device. */
	settings?: { default_role?: number; rolesetAssociation?: string; [key: string]: unknown }
	versionSW?: string
	[key: string]: unknown
}

/** One key of a role, normalized from FSII role keysets or Arcadia keysets. */
export interface RoleKey {
	index: number
	/** Connection (channel) ids the key talks/listens to. */
	connections: number[]
	/** Everything the key is assigned to, as resource paths (channels, roles, ports, special/call). */
	entities: string[]
	isReply: boolean
}

/** A role (FSII) or roleset (Arcadia), normalized by the driver. */
export interface Role {
	id: number
	label: string
	/** Device type the role is for (FSII), or '' for Arcadia rolesets that span device types. */
	type: string
	isDefault: boolean
	gid?: string
	res?: string
	/** Keys per keyset type ('*' when the role has a single key layout). */
	keys: Record<string, RoleKey[]>
}

export interface Connection {
	id: number
	label: string
	type: 'partyline' | 'group' | 'direct' | string
	res?: string
	[key: string]: unknown
}

export interface Participant {
	/** FSII: endpoint/port id (number). Arcadia schema: string. */
	id?: number | string
	device_id?: number
	label?: string
	type?: string // 'FSII-BP' | 'SA' | 'PGM' | '2W' | '4W' | 'hbp' | 'hms' | ...
	joinState?: string // 'Listen' | 'Talk' | 'Talk-Listen'
	state?: string
	res?: string
	gid?: string
	events?: { call?: boolean; talk?: boolean; control?: boolean }
	[key: string]: unknown
}

export interface ConnectionLiveStatus {
	id: number
	label?: string
	type?: string
	participants: Participant[]
	events?: { call?: boolean; talk?: boolean; control?: boolean }
	[key: string]: unknown
}

export interface Port {
	port_id: number
	port_hwIndex?: number
	port_label: string
	port_desc?: string
	port_config_type?: string
	audioInterfaceType_shortName?: string
	res?: string
	gid?: string
	port_connections?: Record<string, { connectionState?: number }>
	liveStatus?: { online?: boolean; vox?: { status?: boolean }; [key: string]: unknown }
	[key: string]: unknown
}

export interface Gpio {
	id: number
	device_id?: number
	label?: string
	type: number // 0 = GPI, 1 = GPO
	liveStatus?: { id?: number; status?: boolean; forced?: boolean; [key: string]: unknown }
	[key: string]: unknown
}

/** Base station / central station info, normalized by the driver. */
export interface DeviceInfo {
	label: string
	type: string
	version: string
	state: string
	/** Seconds since boot, or NaN when the device does not report it as a number. */
	uptime: number
}

export interface EndpointUpdatedEvent {
	endpointId: number
	path: string
	value: unknown
}

export const NO_ROLE = 65535

/** FSII port ids encode their location: deviceId<<16 | hwIndex<<8 | portIndex. */
export function decodePortId(portId: number): { deviceId: number; hwIndex: number; portIndex: number } {
	return { deviceId: portId >> 16, hwIndex: (portId >> 8) & 0xff, portIndex: portId & 0xff }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A list from the device. Arrays pass through; an object keyed by index or id gives its values; anything else
 * (missing, null, a string) gives an empty list, so one unexpected payload cannot stop the whole module.
 */
export function asList<T>(v: unknown): T[] {
	if (Array.isArray(v)) return v as T[]
	if (isPlainObject(v)) return Object.values(v) as T[]
	return []
}

/** Connection id from a resource path like `/api/1/connections/3`. */
export function connectionIdFromRes(res: unknown): number | undefined {
	const m = /\/connections\/(\d+)$/.exec(typeof res === 'string' ? res : '')
	return m ? Number(m[1]) : undefined
}
