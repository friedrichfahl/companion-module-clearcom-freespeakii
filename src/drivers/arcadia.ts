import { ApiError, HttpClient, isHttpError } from '../http.js'
import {
	asList,
	connectionIdFromRes,
	type Connection,
	type ConnectionLiveStatus,
	type DeviceInfo,
	type Endpoint,
	type Gpio,
	type Port,
	type Role,
	type RoleKey,
} from '../types.js'
import type { DeviceDriver, SocketOptions } from './driver.js'

/** Refresh interval when the token does not carry an expiry (matches what the clearcom-rest module does). */
const DEFAULT_REFRESH_MS = 30_000
const MIN_REFRESH_MS = 10_000
const MAX_REFRESH_MS = 5 * 60_000

export interface ArcadiaRoleset {
	id: number
	name?: string
	label?: string
	gid?: string
	res?: string
	isDefault?: boolean
	/** Published API schema: one session per device type, pointing at a keyset through `defaultRole`. */
	sessions?: Record<string, { data?: { type?: string; settings?: { defaultRole?: number } } }>
	/** Firmware 4.2.83: the keysets (one per device type) listed directly. */
	keysets?: { id?: number; type?: string; gid?: string; res?: string }[]
	[key: string]: unknown
}

export interface ArcadiaKeyset {
	id: number
	type?: string
	settings?: {
		keysets?: { keysetIndex: number; entities?: { res: string; type?: number }[]; isReplyKey?: boolean }[]
		[key: string]: unknown
	}
	[key: string]: unknown
}

interface ArcadiaDevice {
	device_label?: string
	deviceType_name?: string
	versionSW?: string
	device_versionSW?: string
	uptime?: number | string
	device_liveStatus?: { state?: string; [key: string]: unknown }
	[key: string]: unknown
}

type KeysetSlot = NonNullable<NonNullable<ArcadiaKeyset['settings']>['keysets']>[number]
const slotEntities = (k: KeysetSlot): { res: string; type?: number }[] =>
	asList<{ res: string; type?: number }>(k?.entities).filter((e) => typeof e?.res === 'string')

/** Normalize Arcadia rolesets plus the keysets their sessions point at into roles. */
export function normalizeArcadiaRoles(rolesets: ArcadiaRoleset[], keysets: ArcadiaKeyset[]): Role[] {
	const keysetById = new Map(asList<ArcadiaKeyset>(keysets).map((k) => [k?.id, k]))
	return asList<ArcadiaRoleset>(rolesets)
		.filter((rs) => typeof rs?.id === 'number')
		.map((rs) => {
			const keys: Record<string, RoleKey[]> = {}
			// the keysets of this roleset: [keyset id, device type the roleset names for it]
			const refs: [unknown, string | undefined][] = [
				...asList<NonNullable<ArcadiaRoleset['sessions']>[string]>(rs.sessions).map(
					(s): [unknown, string | undefined] => [s?.data?.settings?.defaultRole, s?.data?.type],
				),
				...asList<NonNullable<ArcadiaRoleset['keysets']>[number]>(rs.keysets).map(
					(k): [unknown, string | undefined] => [k?.id, k?.type],
				),
			]
			for (const [keysetId, refType] of refs) {
				const ks = typeof keysetId === 'number' ? keysetById.get(keysetId) : undefined
				if (!ks) continue
				const slots = asList<KeysetSlot>(ks.settings?.keysets).filter((k) => typeof k === 'object' && k !== null)
				keys[ks.type ?? refType ?? '*'] = slots.map((k, i) => ({
					index: typeof k.keysetIndex === 'number' ? k.keysetIndex : i,
					connections: slotEntities(k)
						.map((e) => connectionIdFromRes(e.res))
						.filter((id) => id !== undefined),
					entities: slotEntities(k).map((e) => e.res),
					isReply: !!k.isReplyKey,
				}))
			}
			return {
				id: rs.id,
				label: rs.label || rs.name || `Role ${rs.id}`,
				type: '',
				isDefault: !!rs.isDefault,
				gid: rs.gid,
				res: rs.res ?? `/api/2/rolesets/${rs.id}`,
				keys,
			}
		})
}

/** Decode the payload of a JWT without verifying it. */
export function decodeJwt(token: string): Record<string, unknown> | undefined {
	const payload = token.split('.')[1]
	if (!payload) return undefined
	try {
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
	} catch {
		return undefined
	}
}

/**
 * Arcadia Central Station. Uses the CCM web UI's REST interface with a JWT from `/auth/local/login`, refreshed
 * through `/auth/refresh`. Request formats follow the companion-module-clearcom-rest module (tested on Arcadia)
 * and the device's own OpenAPI schema (`/api/1/schemas/clearcom_api.json`).
 */
export class ArcadiaDriver implements DeviceDriver {
	readonly kind = 'arcadia' as const
	readonly productName = 'Arcadia'
	readonly gpiActiveLow = true
	readonly supportsGpiTrigger = true
	readonly testedVersions: readonly string[] = []
	readonly http: HttpClient
	sample?: (key: string, data: unknown) => void

	#token = ''
	#login: Promise<void> | null = null
	#refreshTimer: NodeJS.Timeout | null = null
	#authListeners: (() => void)[] = []
	#stopped = false

	constructor(
		host: string,
		private readonly deviceId: number,
		private readonly username: string,
		private readonly password: string,
	) {
		this.http = new HttpClient(host, {
			headers: () => this.#authHeaders(),
			onUnauthorized: async (used) => {
				if (this.#stopped) return false
				// a request sent with an older token: the current one may be fine, so just retry with it
				if (this.#token && used.Authorization && used.Authorization !== `Bearer ${this.#token}`) return true
				await this.#loginOnce()
				return true
			},
		})
	}

	get token(): string {
		return this.#token
	}

	#authHeaders(): Record<string, string> {
		return this.#token ? { Authorization: `Bearer ${this.#token}` } : {}
	}

	async connect(): Promise<void> {
		this.#stopped = false
		await this.#loginOnce()
	}

	disconnect(): void {
		this.#stopped = true
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
		this.#refreshTimer = null
		this.#token = ''
	}

	onAuthChanged(cb: () => void): void {
		this.#authListeners.push(cb)
	}

	socketOptions(): SocketOptions {
		// Start with long-polling (what the clearcom-rest module uses) and let socket.io upgrade to a websocket
		// when the device allows it.
		return {
			transports: ['polling', 'websocket'],
			headers: () => this.#authHeaders(),
		}
	}

	// --- auth ---------------------------------------------------------------------------------------

	/** Log in, sharing one attempt between concurrent callers (e.g. several requests answered with 401). */
	async #loginOnce(): Promise<void> {
		this.#login ??= this.#doLogin().finally(() => (this.#login = null))
		return this.#login
	}

	async #doLogin(): Promise<void> {
		let res: { jwt?: string }
		try {
			res = await this.http.request<{ jwt?: string }>(
				'POST',
				'/auth/local/login',
				{ logemail: this.username, logpassword: this.password },
				true,
			)
		} catch (err) {
			if (err instanceof ApiError && (err.status === 401 || err.status === 403))
				throw new ApiError('Login rejected: check the username and password', err.status)
			throw err
		}
		if (!res?.jwt) throw new Error('Login response did not contain a token')
		this.#setToken(res.jwt)
	}

	async #refresh(): Promise<void> {
		if (this.#stopped) return
		try {
			const ver = decodeJwt(this.#token)?.ver
			if (ver === undefined) throw new Error('token has no version')
			const res = await this.http.request<{ jwt?: string }>('POST', '/auth/refresh', { jwtversion: ver }, true)
			if (!res?.jwt) throw new Error('refresh response did not contain a token')
			this.#setToken(res.jwt)
		} catch {
			// fall back to a full login; if that fails too, try again on the next cycle
			await this.#loginOnce().catch(() => this.#scheduleRefresh(MIN_REFRESH_MS))
		}
	}

	#setToken(token: string): void {
		const changed = token !== this.#token
		this.#token = token
		this.#scheduleRefresh()
		if (changed) for (const cb of this.#authListeners) cb()
	}

	#scheduleRefresh(fixedMs?: number): void {
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
		if (this.#stopped) return
		let ms = fixedMs ?? DEFAULT_REFRESH_MS
		const { exp, iat } = decodeJwt(this.#token) ?? {}
		if (fixedMs === undefined && typeof exp === 'number' && typeof iat === 'number' && exp > iat) {
			// use the token lifetime, not the device clock, which may differ from ours
			ms = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, ((exp - iat) * 1000) / 2))
		}
		this.#refreshTimer = setTimeout(() => void this.#refresh(), ms)
	}

	// --- reads --------------------------------------------------------------------------------------

	async device(): Promise<DeviceInfo> {
		const d = await this.http.get<ArcadiaDevice>(`/api/1/devices/${this.deviceId}`)
		const uptime = typeof d.uptime === 'number' ? d.uptime : Number(d.uptime)
		return {
			label: d.device_label ?? '',
			type: d.deviceType_name ?? 'ARCADIA',
			version: d.versionSW ?? d.device_versionSW ?? '',
			state: d.device_liveStatus?.state ?? 'Connected',
			uptime: Number.isFinite(uptime) ? uptime : Number.NaN,
		}
	}

	async roles(): Promise<Role[]> {
		const [rolesets, keysets] = await Promise.all([
			this.http.get<ArcadiaRoleset[]>('/api/2/rolesets'),
			// keysets only add the key -> channel mapping; a device that refuses them still works without it
			this.http.get<ArcadiaKeyset[]>('/api/2/keysets').catch((err) => {
				if (isHttpError(err)) return [] as ArcadiaKeyset[]
				throw err
			}),
		])
		this.sample?.('rolesets (raw)', asList(rolesets).slice(0, 2))
		this.sample?.('keysets (raw)', asList(keysets).slice(0, 2))
		return normalizeArcadiaRoles(rolesets, keysets)
	}

	async endpoints(): Promise<Endpoint[]> {
		return this.http.get('/api/1/devices/endpoints')
	}

	async connections(): Promise<Connection[]> {
		try {
			return await this.http.get<Connection[]>('/api/1/connections')
		} catch (err) {
			if (!isHttpError(err)) throw err
			// older firmware: derive the list from the live status
			return (await this.connectionsLive()).map((c) => ({
				id: c.id,
				label: c.label ?? `Channel ${c.id}`,
				type: c.type ?? '',
			}))
		}
	}

	async connectionsLive(): Promise<ConnectionLiveStatus[]> {
		return this.http.get('/api/1/connections/liveStatus')
	}

	async ports(): Promise<Port[]> {
		return this.http.get('/api/1/devices/interfaces/ports')
	}

	async gpio(): Promise<Gpio[]> {
		try {
			return await this.http.get<Gpio[]>(`/api/1/devices/${this.deviceId}/gpio`)
		} catch (err) {
			if (isHttpError(err)) return []
			throw err
		}
	}

	// --- writes -------------------------------------------------------------------------------------

	#endpointPath(e: Endpoint, action: string): string {
		const base = e.res ?? `/api/1/devices/${e.device_id ?? this.deviceId}/endpoints/${e.id}`
		return `${base}/${action}`
	}

	#portPath(p: Port, action: string): string {
		if (!p.res) throw new Error(`Port ${p.port_label} has no resource path`)
		return `${p.res}/${action}`
	}

	async call(e: Endpoint, active: boolean, text: string): Promise<unknown> {
		const gid = e.gid ?? e.liveStatus?.gid
		return this.http.write('POST', this.#endpointPath(e, 'call'), gid ? { active, text, gid } : { active, text })
	}

	async rmk(e: Endpoint): Promise<unknown> {
		return this.http.write('POST', this.#endpointPath(e, 'rmk'), {})
	}

	async changeRole(e: Endpoint, role: Role): Promise<unknown> {
		if (role.gid) {
			return this.http.write('POST', this.#endpointPath(e, 'changeassociation'), {
				...(e.gid ? { gid: e.gid } : {}),
				association: { gid: role.gid },
			})
		}
		return this.http.write('POST', this.#endpointPath(e, 'changerole'), { roleId: role.id })
	}

	async portRoute(p: Port, connectionId: number, join: boolean): Promise<unknown> {
		return this.http.write('POST', this.#portPath(p, join ? 'join' : 'leave'), {
			target: `/api/1/connections/${connectionId}`,
		})
	}

	/** The Arcadia API only offers the port GPO route on 4-wire + GPIO ports. */
	canCallPort(p: Port): boolean {
		return String(p.port_config_type ?? p.audioInterfaceType_shortName) === '4WG'
	}

	async portCall(p: Port, on: boolean): Promise<unknown> {
		return this.http.write('POST', this.#portPath(p, 'gpo'), { enabled: on, timeout: 4000 })
	}

	async setGpo(id: number, enabled: boolean | null): Promise<unknown> {
		return this.http.write('POST', `/api/1/devices/${this.deviceId}/setGPO`, { id, enabled })
	}

	async setGpi(id: number, enabled: boolean): Promise<unknown> {
		return this.http.write('POST', `/api/1/devices/${this.deviceId}/setGPI`, { id, enabled })
	}
}
