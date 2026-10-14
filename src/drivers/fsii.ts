import { HttpClient, isHttpError } from '../http.js'
import {
	connectionIdFromRes,
	decodePortId,
	type Connection,
	type ConnectionLiveStatus,
	type DeviceInfo,
	type Endpoint,
	type Gpio,
	type Port,
	type Role,
} from '../types.js'
import type { DeviceDriver, SocketOptions } from './driver.js'

/** Interface hardware indexes on the FSII base (E1 station, 2W, 4W, ...). */
const INTERFACE_HW_INDEXES = [0, 1, 2, 3, 4]

interface FsiiRole {
	id: number
	type: string
	label: string
	isDefault?: boolean
	res?: string
	settings?: {
		keysets?: { keysetIndex: number; connections?: { res: string }[]; isReplyKey?: boolean }[]
		[key: string]: unknown
	}
}

interface FsiiDeviceLiveStatus {
	uptime: number
	version: string
	label: string
	state: string
}

/** Normalize an FSII role (`/api/1/roles`). */
export function normalizeFsiiRole(r: FsiiRole): Role {
	return {
		id: r.id,
		label: r.label ?? `Role ${r.id}`,
		type: r.type ?? '',
		isDefault: !!r.isDefault,
		res: r.res,
		keys: {
			'*': (r.settings?.keysets ?? []).map((k) => ({
				index: k.keysetIndex,
				connections: (k.connections ?? []).map((c) => connectionIdFromRes(c.res)).filter((id) => id !== undefined),
				entities: (k.connections ?? []).map((c) => c.res),
				isReply: !!k.isReplyKey,
			})),
		},
	}
}

/**
 * FreeSpeak II base (FSII-BASE-II). The CCM interface has no authentication. Verified against firmware 1.6.15
 * by the companion-module-clearcom-freespeakii project; this driver keeps its request formats.
 * NOTE: never call GET /api/1/events without an entity id - the base never answers it.
 */
export class FsiiDriver implements DeviceDriver {
	readonly kind = 'fsii' as const
	readonly productName = 'FreeSpeak II base'
	readonly gpiActiveLow = false
	readonly supportsGpiTrigger = false
	readonly testedVersions = ['1.6.15']
	readonly http: HttpClient

	constructor(
		host: string,
		private readonly deviceId: number,
	) {
		this.http = new HttpClient(host)
	}

	async connect(): Promise<void> {
		// no login; the first snapshot request doubles as the reachability check
	}
	disconnect(): void {}
	onAuthChanged(): void {}

	socketOptions(): SocketOptions {
		return { transports: ['websocket'] }
	}

	// --- reads ---
	async device(): Promise<DeviceInfo> {
		const s = await this.http.get<FsiiDeviceLiveStatus>(`/api/1/devices/${this.deviceId}/liveStatus`)
		return {
			label: s.label ?? '',
			type: 'FSII-BASE',
			version: s.version ?? '',
			state: s.state ?? '',
			uptime: typeof s.uptime === 'number' ? s.uptime : Number.NaN,
		}
	}
	async roles(): Promise<Role[]> {
		return (await this.http.get<FsiiRole[]>('/api/1/roles')).map(normalizeFsiiRole)
	}
	async endpoints(): Promise<Endpoint[]> {
		return this.http.get(`/api/1/devices/${this.deviceId}/endpoints`)
	}
	async connections(): Promise<Connection[]> {
		return this.http.get('/api/1/connections')
	}
	async connectionsLive(): Promise<ConnectionLiveStatus[]> {
		return this.http.get('/api/1/connections/liveStatus')
	}
	async gpio(): Promise<Gpio[]> {
		return this.http.get(`/api/1/devices/${this.deviceId}/gpio`)
	}
	async ports(): Promise<Port[]> {
		const lists = await Promise.all(
			INTERFACE_HW_INDEXES.map(async (hw) =>
				this.http.get<Port[]>(`/api/1/devices/${this.deviceId}/interfaces/${hw}/ports`).catch((err) => {
					// interfaces that do not exist answer with an error; timeouts must not look like "no ports"
					if (isHttpError(err)) return [] as Port[]
					throw err
				}),
			),
		)
		return lists.flat()
	}

	// --- writes ---
	#endpoint(e: Endpoint, action: string): string {
		return `/api/1/devices/${this.deviceId}/endpoints/${e.id}/${action}`
	}
	#port(p: Port, action: string): string {
		return `/api/1/devices/${this.deviceId}/interfaces/${decodePortId(p.port_id).hwIndex}/ports/${p.port_id}/${action}`
	}

	async call(e: Endpoint, active: boolean, text: string): Promise<unknown> {
		return this.http.write('POST', this.#endpoint(e, 'call'), { active, text })
	}
	async rmk(e: Endpoint): Promise<unknown> {
		return this.http.write('POST', this.#endpoint(e, 'rmk'), {})
	}
	async changeRole(e: Endpoint, role: Role): Promise<unknown> {
		return this.http.write('POST', this.#endpoint(e, 'changerole'), { id: role.id })
	}
	async portRoute(p: Port, connectionId: number, join: boolean): Promise<unknown> {
		return this.http.write('POST', this.#port(p, join ? 'join' : 'leave'), {
			target: `/api/1/connections/${connectionId}`,
		})
	}
	canCallPort(p: Port): boolean {
		return ['2W', '4W'].includes(String(p.port_config_type ?? p.audioInterfaceType_shortName))
	}
	async portCall(p: Port, on: boolean): Promise<unknown> {
		return this.http.write('POST', this.#port(p, 'gpo'), { enabled: on, timeout: 4000 })
	}
	async setGpo(id: number, enabled: boolean | null): Promise<unknown> {
		return this.http.write('POST', `/api/1/devices/${this.deviceId}/setGPO`, { id, enabled })
	}
	async setGpi(): Promise<unknown> {
		throw new Error('The FreeSpeak II base does not support triggering GPIs')
	}
}
