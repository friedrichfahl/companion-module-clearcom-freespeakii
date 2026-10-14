import {
	asList,
	isPlainObject,
	type Connection,
	type ConnectionLiveStatus,
	type DeviceInfo,
	type Endpoint,
	type EndpointLiveStatus,
	type EndpointUpdatedEvent,
	type Gpio,
	type Participant,
	type Port,
	type Role,
} from './types.js'
import { isCalling, packName, packRoleId } from './resolve.js'

/** What changed in a state update, so the module only redraws what it must. */
export interface StateChange {
	/** Live values changed: re-check feedbacks and variables. */
	live: boolean
	/** Ids/labels changed: rebuild action/feedback/variable definitions. */
	structure: boolean
}

export interface IncomingCall {
	label: string
	channel: string
	time: Date
}

export const NO_CHANGE: StateChange = { live: false, structure: false }
/** How long a channel call sent from Companion labels the packs it rings (the device does not report the channel). */
const CALL_CHANNEL_MS = 10_000

/** Set `obj.a.b.c = value` for a dotted path, creating intermediate objects. */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.')
	// paths come from the device; never let them reach the prototype chain
	if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) return
	let cur: Record<string, unknown> = obj
	for (const key of parts.slice(0, -1)) {
		if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
		cur = cur[key] as Record<string, unknown>
	}
	cur[parts[parts.length - 1]] = value
}

export class DeviceState {
	endpoints = new Map<number, Endpoint>()
	roles = new Map<number, Role>()
	connections = new Map<number, Connection>()
	connectionLive = new Map<number, ConnectionLiveStatus>()
	ports = new Map<number, Port>()
	gpis = new Map<number, Gpio>()
	gpos = new Map<number, Gpio>()
	device: DeviceInfo | null = null
	lastCall: IncomingCall | null = null
	/** False until the first full snapshot after a (re)connect has arrived. */
	ready = false
	/** GPI `liveStatus.status` is false while asserted (Arcadia), possibly inverted by the user. */
	gpiActiveLow = false

	#endpointJson = new Map<number, string>()
	#roleIdByGid = new Map<string, number>()

	/**
	 * What of an endpoint the definitions and presets depend on: it changes when a device appears, is renamed or
	 * takes another role (presets group roles by whether a device holds them), not on live status.
	 */
	#structureKey(e: Endpoint): string {
		return `${e.id}|${e.label}|${e.type}|${packRoleId(e, this) ?? ''}`
	}
	#callChannels = new Map<number, { label: string; until: number }>()

	/** Remember which channel a Companion channel call was sent on, so the packs it rings report that channel. */
	noteCallChannel(endpointIds: number[], label: string): void {
		const until = Date.now() + CALL_CHANNEL_MS
		for (const id of endpointIds) this.#callChannels.set(id, { label, until })
	}

	/**
	 * A device's call signal (liveStatus.callState) went active: record it as the last call. The device here is
	 * the one being rung, so a call Companion sent is credited to Companion, not to that device.
	 */
	#trackCall(e: Endpoint, wasCalling: boolean): void {
		if (wasCalling || !isCalling(e)) return
		const origin = this.#callChannels.get(e.id)
		const fromCompanion = !!origin && origin.until > Date.now()
		this.lastCall = {
			label: fromCompanion ? 'Companion' : packName(this, e),
			channel: fromCompanion ? origin.label : '',
			time: new Date(),
		}
	}

	/** Full endpoint snapshot (EndpointInit or REST). Redundant broadcasts from other clients are no-ops. */
	setEndpoints(list: Endpoint[]): StateChange {
		let live = false
		let structure = false
		const seen = new Set<number>()
		for (const e of asList<Endpoint>(list)) {
			if (!e || typeof e.id !== 'number') continue
			seen.add(e.id)
			const json = JSON.stringify(e)
			if (this.#endpointJson.get(e.id) === json) continue
			const prev = this.endpoints.get(e.id)
			if (!prev || this.#structureKey(prev) !== this.#structureKey(e)) structure = true
			this.endpoints.set(e.id, e)
			this.#endpointJson.set(e.id, json)
			// devices already calling in the first snapshot are not a new call
			this.#trackCall(e, !prev || isCalling(prev))
			live = true
		}
		for (const id of [...this.endpoints.keys()]) {
			if (!seen.has(id)) {
				this.endpoints.delete(id)
				this.#endpointJson.delete(id)
				live = structure = true
			}
		}
		return { live, structure }
	}

	/**
	 * EndpointUpdated: `{endpointId, path, value}`. FSII sends one object per event, Arcadia an array. A whole
	 * `liveStatus` object is merged, and an empty one means the device went offline (Arcadia).
	 */
	applyEndpointUpdate(evt: EndpointUpdatedEvent): StateChange {
		const e = this.endpoints.get(evt?.endpointId)
		if (!e || typeof evt.path !== 'string' || !evt.path) return NO_CHANGE
		const before = this.#structureKey(e)
		const wasCalling = isCalling(e)
		if (evt.path === 'liveStatus' && isPlainObject(evt.value)) {
			const value = evt.value as EndpointLiveStatus
			e.liveStatus =
				Object.keys(value).length === 0
					? { ...e.liveStatus, status: 'offline', keyState: [], callState: false }
					: { ...e.liveStatus, ...value }
		} else {
			setByPath(e, evt.path, evt.value)
		}
		this.#endpointJson.set(e.id, JSON.stringify(e))
		this.#trackCall(e, wasCalling)
		return { live: true, structure: this.#structureKey(e) !== before }
	}

	addEndpoint(e: Endpoint): StateChange {
		if (!e || typeof e.id !== 'number') return NO_CHANGE
		const prev = this.endpoints.get(e.id)
		const json = JSON.stringify(e)
		if (this.#endpointJson.get(e.id) === json) return NO_CHANGE
		this.endpoints.set(e.id, e)
		this.#endpointJson.set(e.id, json)
		this.#trackCall(e, !prev || isCalling(prev))
		return { live: true, structure: !prev || this.#structureKey(prev) !== this.#structureKey(e) }
	}

	removeEndpoint(id: number): StateChange {
		if (!this.endpoints.delete(id)) return NO_CHANGE
		this.#endpointJson.delete(id)
		return { live: true, structure: true }
	}

	/** The role (Arcadia roleset) with this gid. */
	roleIdByGid(gid: string): number | undefined {
		return this.#roleIdByGid.get(gid)
	}

	setRoles(list: Role[]): StateChange {
		const before = JSON.stringify([...this.roles.values()])
		const change = this.#replaceMap(this.roles, list, (r) => `${r.id}|${r.label}`)
		this.#roleIdByGid = new Map(
			[...this.roles.values()].filter((r) => typeof r.gid === 'string').map((r) => [r.gid as string, r.id]),
		)
		// key layouts are not structural, but talk-per-channel tallies depend on them
		return { live: change.live || before !== JSON.stringify([...this.roles.values()]), structure: change.structure }
	}

	setConnections(list: Connection[]): StateChange {
		return this.#replaceMap(this.connections, list, (c) => `${c.id}|${c.label}|${c.type}`)
	}

	setPorts(list: Port[]): StateChange {
		const change = this.#replaceMap(
			this.ports,
			list,
			(p) => `${p.port_id}|${p.port_label}`,
			(p) => p.port_id,
			false,
		)
		return { live: true, structure: change.structure }
	}

	/** Connection live status carries per-participant talk/call flags; also detects new incoming calls. */
	setConnectionLive(
		list: ConnectionLiveStatus[],
		labelFor: (p: ConnectionLiveStatus['participants'][0]) => string,
	): StateChange {
		const conns = asList<ConnectionLiveStatus>(list).filter((c) => isPlainObject(c))
		for (const conn of conns) {
			const prev = this.connectionLive.get(conn.id)
			// calls already active in the first snapshot are not a new call
			if (!prev) continue
			for (const p of asList<Participant>(conn.participants)) {
				if (!p?.events?.call) continue
				const key = p.id ?? p.gid ?? p.res
				const wasCalling = asList<Participant>(prev.participants).some(
					(q) => (q?.id ?? q?.gid ?? q?.res) === key && q?.events?.call,
				)
				if (!wasCalling)
					this.lastCall = {
						label: labelFor(p),
						channel: conn.label ?? this.connections.get(conn.id)?.label ?? '',
						time: new Date(),
					}
			}
		}
		this.connectionLive = new Map(conns.map((c) => [c.id, c]))
		return { live: true, structure: false }
	}

	/** Full GPIO snapshot for one kind (REST or GpiInit / GpoInit). */
	setGpio(kind: 'gpi' | 'gpo', list: Gpio[]): StateChange {
		const map = kind === 'gpi' ? this.gpis : this.gpos
		const change = this.#replaceMap(
			map,
			list,
			(g) => `${g.id}|${g.label}`,
			(g) => g.id,
			false,
		)
		return { live: true, structure: change.structure }
	}

	/** FSII Gpi/GpoUpdated events: merge whatever fields arrive into the matching entry. */
	updateGpio(kind: 'gpi' | 'gpo', data: Partial<Gpio> & { id: number }): StateChange {
		const map = kind === 'gpi' ? this.gpis : this.gpos
		const cur = map.get(data?.id)
		if (!cur) return NO_CHANGE
		map.set(data.id, { ...cur, ...data, liveStatus: { ...cur.liveStatus, ...data.liveStatus } })
		return { live: true, structure: false }
	}

	/** Arcadia GpiUpdated events: `{gpiId, path, value}`. */
	updateGpioPath(kind: 'gpi' | 'gpo', id: number, path: string, value: unknown): StateChange {
		const map = kind === 'gpi' ? this.gpis : this.gpos
		const cur = map.get(id)
		if (!cur || typeof path !== 'string' || !path) return NO_CHANGE
		const next = structuredClone(cur)
		if (path === 'liveStatus' && isPlainObject(value)) next.liveStatus = { ...next.liveStatus, ...value }
		else setByPath(next, path, value)
		map.set(id, next)
		return { live: true, structure: false }
	}

	/** Returns true when the device appears to have rebooted (uptime went backwards). */
	setDevice(status: DeviceInfo): { change: StateChange; rebooted: boolean } {
		const rebooted =
			!!this.device &&
			Number.isFinite(status.uptime) &&
			Number.isFinite(this.device.uptime) &&
			status.uptime < this.device.uptime
		const changed = JSON.stringify(this.device) !== JSON.stringify(status)
		this.device = status
		return { change: { live: changed, structure: false }, rebooted }
	}

	#replaceMap<T, K>(
		map: Map<K, T>,
		list: T[],
		key: (item: T) => string,
		id: (item: T) => K = (item) => (item as { id: K }).id,
		live = true,
	): StateChange {
		const before = [...map.values()].map(key).join('\n')
		map.clear()
		for (const item of asList<T>(list)) if (item !== null && typeof item === 'object') map.set(id(item), item)
		const after = [...map.values()].map(key).join('\n')
		return { live, structure: before !== after }
	}
}

export function mergeChanges(...changes: StateChange[]): StateChange {
	return { live: changes.some((c) => c.live), structure: changes.some((c) => c.structure) }
}
