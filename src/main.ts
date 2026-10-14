import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { DEFAULT_CONFIG, GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions, computeVariableValues, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { ArcadiaDriver } from './drivers/arcadia.js'
import { FsiiDriver } from './drivers/fsii.js'
import type { DeviceDriver } from './drivers/driver.js'
import { ApiError, isHttpError } from './http.js'
import { DeviceSocket } from './socket.js'
import { DeviceState, mergeChanges, NO_CHANGE, type StateChange } from './state.js'
import { isOnline, packs, participantName } from './resolve.js'
import { asList, type Endpoint, type EndpointUpdatedEvent, type Gpio, type Port } from './types.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
	compositeElements: Record<string, never>
}

export { UpgradeScripts }

export type RefreshKind = 'endpoints' | 'roles' | 'connections' | 'connLive' | 'ports' | 'device' | 'gpio'

const REDRAW_MS = 50
const DEFINITIONS_MS = 500
const REFETCH_MS = 250
const RETRY_MS = 10_000
const AUTH_RETRY_MS = 30_000
/** A debounced job runs at the latest this many times its delay after it was first requested. */
const DEBOUNCE_MAX_FACTOR = 4
/** How long stopping waits for pending "call off" commands to reach the device. */
const STOP_FLUSH_MS = 2000
/** Events that carry state and must not be lost (or applied out of order) while a snapshot is loading. */
const BUFFERED_EVENTS = new Set([
	'EndpointInit',
	'EndpointUpdated',
	'EndpointAdded',
	'EndpointRemoved',
	'GpiInit',
	'GpoInit',
	'GpiUpdated',
	'GpoUpdated',
])
const MAX_BUFFERED = 10_000

/** A call signal Companion turned on and has not turned off yet. */
export interface ActiveCall {
	driver: DeviceDriver
	endpoints: Endpoint[]
	ports: Port[]
}

interface ScheduledTask {
	fn: () => unknown
	/** Run the task right away (instead of dropping it) when the module stops. */
	flushOnStop: boolean
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * An error in the module's own code (usually a device payload in a shape the module did not expect), as opposed
 * to a failed request. `fetch` reports network failures as a TypeError too, so those are excluded.
 */
const isBug = (err: unknown): boolean =>
	(err instanceof TypeError && !/fetch failed/i.test(err.message)) ||
	err instanceof RangeError ||
	err instanceof ReferenceError

/** Longest raw payload sample written to the log. */
const SAMPLE_CHARS = 8000

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config: ModuleConfig = { ...DEFAULT_CONFIG }
	secrets: ModuleSecrets = {}
	state = new DeviceState()
	driver: DeviceDriver | null = null

	/** Calls turned on by hold-style actions (on / off), keyed by what was called. */
	activeCalls = new Map<string, ActiveCall>()

	#socket: DeviceSocket | null = null
	#timers = new Map<NodeJS.Timeout, ScheduledTask>()
	#debounces = new Map<string, { timer: NodeJS.Timeout; first: number }>()
	#loading = false
	#loadGeneration = 0
	#buffered: [string, unknown][] = []
	#heartbeat: NodeJS.Timeout | null = null
	#lastValues: VariablesSchema = {}
	#definedVariables = new Set<string>()
	#lastStatus = ''
	#warnedVersion = false
	#unknownEvents = new Set<string>()
	/** Module errors already logged (each message once per config). */
	#reportedBugs = new Set<string>()
	/** Raw payload samples already logged (only on firmware the module has not been verified against). */
	#sampled = new Set<string>()

	constructor(internal: unknown) {
		super(internal)
	}

	get socketConnected(): boolean {
		return this.#socket?.connected ?? false
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets | undefined): Promise<void> {
		this.#applyConfig(config, secrets)
		this.#defineAll()
		this.#start()
	}

	async destroy(): Promise<void> {
		await this.#stop()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets | undefined): Promise<void> {
		await this.#stop()
		this.#applyConfig(config, secrets)
		this.state = new DeviceState()
		this.#lastValues = {}
		this.#warnedVersion = false
		this.#reportedBugs.clear()
		this.#sampled.clear()
		this.#defineAll()
		this.#start()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	/**
	 * setTimeout that is cancelled when the module stops (used for pulses and retries). With `flushOnStop`, the task
	 * runs immediately on stop instead, so e.g. the "off" half of a pulse is never lost.
	 */
	schedule(ms: number, fn: () => unknown, flushOnStop = false): void {
		const t = setTimeout(() => {
			this.#timers.delete(t)
			void fn()
		}, ms)
		this.#timers.set(t, { fn, flushOnStop })
	}

	/** Refetch one part of the state from the device (debounced). */
	refresh(kind: RefreshKind): void {
		const s = this.state
		const jobs: Record<RefreshKind, (d: DeviceDriver) => Promise<StateChange>> = {
			endpoints: async (d) => s.setEndpoints(await d.endpoints()),
			roles: async (d) => s.setRoles(await d.roles()),
			connections: async (d) => s.setConnections(await d.connections()),
			connLive: async (d) => s.setConnectionLive(await d.connectionsLive(), (p) => participantName(s, p)),
			ports: async (d) => s.setPorts(await d.ports()),
			device: async (d) => this.#onDevice(d),
			gpio: async (d) => this.#setGpio(await d.gpio()),
		}
		this.#debounced(kind, REFETCH_MS, async (d) => this.#apply(await jobs[kind](d)))
	}

	#applyConfig(config: ModuleConfig, secrets: ModuleSecrets | undefined): void {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.secrets = { ...secrets }
		this.state.gpiActiveLow = false
	}

	// --- lifecycle ---------------------------------------------------------------------------------

	#start(): void {
		const host = this.config.host?.trim()
		if (!host) {
			this.#setStatus(InstanceStatus.BadConfig, 'Set the IP address or hostname')
			return
		}
		const deviceId = Number(this.config.deviceId) || 1
		if (this.config.deviceType === 'fsii') {
			this.driver = new FsiiDriver(host, deviceId)
		} else {
			if (!this.secrets.password) {
				this.#setStatus(InstanceStatus.BadConfig, 'Enter the CCM password')
				return
			}
			this.driver = new ArcadiaDriver(host, deviceId, this.config.username?.trim() || 'admin', this.secrets.password)
		}
		this.driver.sample = (key, data) => this.#logSample(key, data)
		this.state.gpiActiveLow = this.driver.gpiActiveLow !== !!this.config.invertGpi
		this.#defineAll()
		this.#setStatus(InstanceStatus.Connecting, `Connecting to ${host}`)
		void this.#connect(this.driver)
	}

	async #connect(driver: DeviceDriver): Promise<void> {
		try {
			await driver.connect()
		} catch (err) {
			if (driver !== this.driver) return
			const auth = err instanceof ApiError && (err.status === 401 || err.status === 403)
			this.log('error', `Cannot connect to ${this.config.host}: ${errMsg(err)}`)
			this.#setStatus(auth ? InstanceStatus.BadConfig : InstanceStatus.ConnectionFailure, errMsg(err))
			this.schedule(auth ? AUTH_RETRY_MS : RETRY_MS, () => void (driver === this.driver && this.#connect(driver)))
			return
		}
		if (driver !== this.driver) return

		const socket = new DeviceSocket(this.#baseUrl(driver), driver.socketOptions())
		this.#socket = socket
		driver.onAuthChanged(() => socket.updateHeaders())
		socket.on('connect', () => void this.#onConnect())
		socket.on('disconnect', (reason) => this.#onDisconnect(reason))
		socket.on('connectError', (message) => {
			this.log('debug', `Socket connect error: ${message}`)
			if (!this.socketConnected) this.#setStatus(InstanceStatus.ConnectionFailure, `Cannot reach ${this.config.host}`)
		})
		// a handler error must never reach socket.io: it would break the transport and could crash the module
		socket.on('event', (name, data) => this.#guard(`handling ${name}`, () => this.#onEvent(name, data)))
		socket.start()

		this.#heartbeat = setInterval(
			() => void this.#pollDevice(),
			Math.max(2000, Number(this.config.heartbeatMs) || 10000),
		)
	}

	#baseUrl(driver: DeviceDriver): string {
		return (driver as { http?: { baseUrl: string } }).http?.baseUrl ?? `http://${this.config.host.trim()}`
	}

	async #stop(): Promise<void> {
		// turn off call signals Companion left on (pending pulses, held buttons) while the driver still works
		const flush: Promise<unknown>[] = []
		for (const [t, task] of this.#timers) {
			clearTimeout(t)
			if (task.flushOnStop) flush.push(Promise.resolve().then(task.fn))
		}
		this.#timers.clear()
		for (const call of this.activeCalls.values()) flush.push(releaseCall(call))
		this.activeCalls.clear()
		if (flush.length) {
			await Promise.race([Promise.allSettled(flush), new Promise((r) => setTimeout(r, STOP_FLUSH_MS))])
		}

		this.#socket?.stop()
		this.#socket = null
		this.driver?.disconnect()
		this.driver = null
		if (this.#heartbeat) clearInterval(this.#heartbeat)
		this.#heartbeat = null
		for (const d of this.#debounces.values()) clearTimeout(d.timer)
		this.#debounces.clear()
		this.#loading = false
		this.#buffered = []
	}

	async #onConnect(): Promise<void> {
		this.log('info', `Connected to ${this.driver?.productName ?? 'device'} at ${this.config.host}`)
		this.state.ready = false
		await this.#fullRefresh()
	}

	#onDisconnect(reason: string): void {
		this.log('warn', `Lost connection to ${this.config.host}: ${reason}`)
		this.state.ready = false
		this.#setStatus(InstanceStatus.ConnectionFailure, `Lost connection to ${this.config.host}`)
		this.#apply({ live: true, structure: false })
	}

	/** Fetch every REST snapshot. Called on (re)connect and after a reboot. */
	async #fullRefresh(): Promise<void> {
		const driver = this.driver
		if (!driver) return
		// socket events that arrive while the snapshot loads are newer than parts of it: hold them and replay after
		this.#loading = true
		const generation = ++this.#loadGeneration
		try {
			const [device, roles, connections, live, gpio, endpoints, ports] = await Promise.all([
				driver.device(),
				driver.roles(),
				driver.connections(),
				driver.connectionsLive(),
				// a device without GPIO or ports answers with an HTTP error; timeouts still fail the load (and retry)
				driver.gpio().catch((err) => {
					if (!isHttpError(err)) throw err
					this.log('debug', `GPIO not available: ${errMsg(err)}`)
					return [] as Gpio[]
				}),
				driver.endpoints(),
				driver.ports().catch((err) => {
					if (!isHttpError(err)) throw err
					this.log('debug', `Ports not available: ${errMsg(err)}`)
					return [] as Port[]
				}),
			])
			// config changed while loading (#stop cleared the buffer), or a newer load is in flight
			if (driver !== this.driver || generation !== this.#loadGeneration) return
			const s = this.state
			s.setDevice(device)
			this.#guard('logging payload samples', () =>
				this.#logSamples({ endpoints, connectionsLive: live, ports, gpio, roles }),
			)
			s.setRoles(roles)
			s.setConnections(connections)
			s.setEndpoints(endpoints)
			s.setPorts(ports)
			s.setConnectionLive(live, (p) => participantName(s, p))
			this.#setGpio(gpio)
			s.ready = true
			this.#checkVersion(driver, device.version)
		} catch (err) {
			if (driver !== this.driver || generation !== this.#loadGeneration) return
			this.#loading = false
			this.#buffered = []
			this.state.ready = false
			this.log('error', `Loading state from ${this.config.host} failed: ${errMsg(err)}`)
			this.#setStatus(InstanceStatus.ConnectionFailure, `Cannot load state from ${this.config.host}`)
			this.schedule(5000, () => void (this.socketConnected && !this.state.ready && this.#fullRefresh()))
			return
		}
		// The state is loaded. A problem from here on is in drawing it, not in the connection: report it as a
		// module error and keep the connection (the next update draws again).
		// A full load always redefines everything right away, so values never precede their definitions.
		clearTimeout(this.#debounces.get('definitions')?.timer)
		this.#debounces.delete('definitions')
		this.#loading = false
		this.#replayBuffered()
		this.#guard('drawing the state', () => this.#defineAll())
	}

	/** Run `fn`; an error is reported (see #reportError) instead of propagating. */
	#guard(context: string, fn: () => void): void {
		try {
			fn()
		} catch (err) {
			this.#reportError(context, err)
		}
	}

	/**
	 * Failed requests are routine (timeouts, a reboot) and only logged at debug level. A module error is logged
	 * once per message and shown in the connection status, so it is not mistaken for a connection problem.
	 */
	#reportError(context: string, err: unknown): void {
		const msg = errMsg(err)
		if (!isBug(err)) {
			this.log('debug', `Error while ${context}: ${msg}`)
			return
		}
		if (!this.#reportedBugs.has(msg)) {
			this.#reportedBugs.add(msg)
			this.log('error', `Module error while ${context}: ${msg}. Please report this with the debug log.`)
		}
		this.#setStatus(InstanceStatus.UnknownWarning, `Module error: ${msg}`)
	}

	/** Whether the device runs firmware this module has been verified against (unknown before the first load). */
	#firmwareTested(): boolean {
		const driver = this.driver
		const version = this.state.device?.version
		if (!driver) return true
		if (version === undefined) return driver.testedVersions.length > 0
		return driver.testedVersions.some((v) => version.startsWith(v))
	}

	/**
	 * On untested firmware, log one sample of each payload at debug level, so payload shapes the module does not
	 * expect yet can be seen in Companion's log (Debug filter) and fixed.
	 */
	#logSample(key: string, data: unknown): void {
		if (data === undefined || this.#sampled.has(key) || this.#firmwareTested()) return
		this.#sampled.add(key)
		let json: string
		try {
			json = JSON.stringify(data) ?? 'undefined'
		} catch (err) {
			json = `(not serializable: ${errMsg(err)})`
		}
		const cut = json.length > SAMPLE_CHARS ? `${json.slice(0, SAMPLE_CHARS)}… (${json.length} chars)` : json
		this.log('debug', `Sample ${key}: ${cut}`)
	}

	#logSamples(load: {
		endpoints: unknown
		connectionsLive: unknown
		ports: unknown
		gpio: unknown
		roles: unknown
	}): void {
		if (this.#firmwareTested()) return
		const endpoints = asList<Endpoint>(load.endpoints)
		// a device with live key states shows the most; add a gateway (antenna / transceiver) for its fields
		const withKeys = endpoints.find((e) => e?.liveStatus?.keyState !== undefined)
		const gateway = endpoints.find((e) => e?.isGateway)
		const shape = (v: unknown) => (Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v)
		this.#logSample('payload types', {
			endpoints: shape(load.endpoints),
			keyState: shape(withKeys?.liveStatus?.keyState),
			connectionsLive: shape(load.connectionsLive),
			ports: shape(load.ports),
			gpio: shape(load.gpio),
		})
		this.#logSample('endpoint (with key states)', withKeys ?? endpoints[0])
		this.#logSample('endpoint (gateway)', gateway)
		this.#logSample('channel live status', asList(load.connectionsLive).slice(0, 2))
		this.#logSample('ports', asList(load.ports).slice(0, 2))
		this.#logSample('gpio', asList(load.gpio).slice(0, 2))
		this.#logSample('role (parsed)', asList(load.roles)[0])
	}

	#setGpio(gpio: Gpio[]): StateChange {
		const list = asList<Gpio>(gpio)
		return mergeChanges(
			this.state.setGpio(
				'gpi',
				list.filter((g) => g?.type === 0),
			),
			this.state.setGpio(
				'gpo',
				list.filter((g) => g?.type === 1),
			),
		)
	}

	async #onDevice(driver: DeviceDriver): Promise<StateChange> {
		const { change, rebooted } = this.state.setDevice(await driver.device())
		if (rebooted) {
			this.log('warn', `${driver.productName} rebooted (uptime went backwards), reloading state`)
			this.state.ready = false
			void this.#fullRefresh()
		}
		return change
	}

	async #pollDevice(): Promise<void> {
		const driver = this.driver
		if (!driver) return
		try {
			this.#apply(await this.#onDevice(driver))
		} catch (err) {
			if (!this.socketConnected)
				this.#setStatus(InstanceStatus.ConnectionFailure, `No response from ${this.config.host}`)
			this.log('debug', `Heartbeat failed: ${errMsg(err)}`)
		}
	}

	#checkVersion(driver: DeviceDriver, version: string): void {
		if (this.#warnedVersion || driver.testedVersions.some((v) => version.startsWith(v))) return
		this.#warnedVersion = true
		const tested = driver.testedVersions.length ? `tested: ${driver.testedVersions.join(', ')}` : 'none verified yet'
		this.log('warn', `${driver.productName} firmware ${version} has not been tested with this module (${tested})`)
	}

	// --- socket events -----------------------------------------------------------------------------

	#replayBuffered(): void {
		const events = this.#buffered
		this.#buffered = []
		for (const [name, data] of events) this.#guard(`handling ${name}`, () => this.#onEvent(name, data))
	}

	#onEvent(name: string, data: unknown): void {
		const first = (Array.isArray(data) ? data[0] : data) as { path?: unknown } | undefined
		this.#logSample(`event ${name}${typeof first?.path === 'string' ? ` ${first.path}` : ''}`, data)
		if (this.#loading && BUFFERED_EVENTS.has(name)) {
			if (this.#buffered.length < MAX_BUFFERED) this.#buffered.push([name, data])
			return
		}
		const s = this.state
		const d = data as Record<string, unknown> | undefined
		switch (name) {
			case 'EndpointInit': {
				const list = Array.isArray(d?.result)
					? (d.result as Endpoint[])
					: Array.isArray(data)
						? (data as Endpoint[])
						: null
				if (!list) return
				// FSII sends the full list; on Arcadia it is not known to be complete, so only merge there
				if (this.driver?.kind === 'fsii') this.#apply(s.setEndpoints(list))
				else this.#apply(mergeChanges(NO_CHANGE, ...list.map((e) => s.addEndpoint(e))))
				return
			}
			case 'EndpointUpdated': {
				const events = (Array.isArray(data) ? data : [data]) as EndpointUpdatedEvent[]
				this.#apply(mergeChanges(NO_CHANGE, ...events.map((evt) => s.applyEndpointUpdate(evt))))
				// an endpoint we do not know yet: fetch the list
				if (events.some((evt) => evt && typeof evt.endpointId === 'number' && !s.endpoints.has(evt.endpointId)))
					this.refresh('endpoints')
				return
			}
			case 'EndpointAdded':
				this.#apply(s.addEndpoint(((d?.result ?? d?.endpoint ?? d) as Endpoint) ?? null))
				return
			case 'EndpointRemoved':
				this.#apply(s.removeEndpoint(Number(d?.endpointId ?? d?.id)))
				return
			case 'GpiInit':
			case 'GpoInit':
				if (Array.isArray(d?.result)) this.#apply(s.setGpio(name === 'GpiInit' ? 'gpi' : 'gpo', d.result as Gpio[]))
				return
			case 'GpiUpdated':
			case 'GpoUpdated': {
				const kind = name === 'GpiUpdated' ? 'gpi' : 'gpo'
				for (const evt of (Array.isArray(data) ? data : [data]) as Record<string, unknown>[]) {
					const pathId = evt?.gpiId ?? evt?.gpoId
					if (typeof pathId === 'number' && typeof evt.path === 'string') {
						this.#apply(s.updateGpioPath(kind, pathId, evt.path, evt.value))
						continue
					}
					const g = (evt?.result ?? evt) as (Partial<Gpio> & { id: number }) | undefined
					if (g && typeof g.id === 'number') this.#apply(s.updateGpio(kind, g))
				}
				return
			}
			case 'live:connections':
				this.refresh('connections')
				this.refresh('connLive')
				return
			case 'live:calls':
				return this.refresh('connLive')
			case 'live:roles':
			case 'live:rolesets':
				return this.refresh('roles')
			case 'live:vpl':
				return this.refresh('connections')
			case 'live:ports':
			case 'live:interfaces':
				return this.refresh('ports')
			case 'live:endpoints':
				return this.refresh('endpoints')
			case 'live:devices':
				return this.refresh('device')
			case 'live:gpios':
				return this.refresh('gpio')
			case 'init':
			case 'DiscoveryInit':
			case 'User:connected':
			case 'User:disconnected':
			case 'live:alerts':
			case 'live:statistics':
			case 'GpiEventAdded':
			case 'GpiEventUpdated':
			case 'GpiEventRemoved':
			case 'GpoEventAdded':
			case 'GpoEventUpdated':
			case 'GpoEventRemoved':
				return
			default:
				if (!this.#unknownEvents.has(name)) {
					this.#unknownEvents.add(name)
					this.log('debug', `Unhandled event from device: ${name} ${JSON.stringify(data)?.slice(0, 300)}`)
				}
		}
	}

	/** Trailing debounce with a maximum wait, so a constant stream of events cannot postpone the job forever. */
	#debounced(key: string, ms: number, fn: (driver: DeviceDriver) => Promise<void>): void {
		const now = Date.now()
		const prev = this.#debounces.get(key)
		const first = prev?.first ?? now
		if (prev) clearTimeout(prev.timer)
		const delay = Math.max(0, Math.min(ms, first + ms * DEBOUNCE_MAX_FACTOR - now))
		const timer = setTimeout(() => {
			this.#debounces.delete(key)
			const driver = this.driver
			if (!driver) return
			fn(driver).catch((err) => this.#reportError(key === 'redraw' ? 'drawing the state' : `refreshing ${key}`, err))
		}, delay)
		this.#debounces.set(key, { timer, first })
	}

	// --- output to Companion -----------------------------------------------------------------------

	#apply(change: StateChange): void {
		if (change.structure) this.#debounced('definitions', DEFINITIONS_MS, async () => this.#defineAll())
		if (change.live) this.#debounced('redraw', REDRAW_MS, async () => this.#redraw())
	}

	#defineAll(): void {
		UpdateActions(this)
		UpdateFeedbacks(this)
		this.#definedVariables = UpdateVariableDefinitions(this)
		UpdatePresets(this)
		this.#lastValues = {}
		this.#redraw()
	}

	#redraw(): void {
		const values = computeVariableValues(this.state, this.socketConnected, this.config.lowBattery)
		const changed: VariablesSchema = {}
		for (const [k, val] of Object.entries(values)) {
			// new roles/channels get values once their definitions are in (structure changes are debounced)
			if (this.#lastValues[k] !== val && this.#definedVariables.has(k)) changed[k] = val
		}
		this.#lastValues = Object.fromEntries(Object.entries(values).filter(([k]) => this.#definedVariables.has(k)))
		if (Object.keys(changed).length) this.setVariableValues(changed)
		this.checkAllFeedbacks()

		if (this.socketConnected && this.state.ready) {
			const all = packs(this.state)
			this.#setStatus(InstanceStatus.Ok, `Connected — ${all.filter(isOnline).length}/${all.length} devices online`)
		}
	}

	#setStatus(status: InstanceStatus, message: string): void {
		const key = `${status}|${message}`
		if (key === this.#lastStatus) return
		this.#lastStatus = key
		this.updateStatus(status, message)
	}
}

/** Turn off everything an active call turned on. Errors are ignored: this runs on release and on shutdown. */
export async function releaseCall(call: ActiveCall): Promise<void> {
	await Promise.allSettled([
		...call.endpoints.map(async (e) => call.driver.call(e, false, '')),
		...call.ports.map(async (p) => call.driver.portCall(p, false)),
	])
}
