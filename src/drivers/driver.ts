import type { Connection, ConnectionLiveStatus, DeviceInfo, DeviceKind, Endpoint, Gpio, Port, Role } from '../types.js'

export interface SocketOptions {
	/** socket.io transports, in order of preference. */
	transports: string[]
	/** Headers sent with the socket handshake (read again on every reconnect). */
	headers?: () => Record<string, string>
}

/**
 * Everything that differs between an Arcadia Central Station and a FreeSpeak II base. The rest of the module
 * (state, resolve, actions, feedbacks, variables) only talks to the device through this interface.
 */
export interface DeviceDriver {
	readonly kind: DeviceKind
	/** Short product name for logs and status messages. */
	readonly productName: string
	/** GPI `liveStatus.status` is false while the input is asserted. */
	readonly gpiActiveLow: boolean
	/** The device accepts a "trigger GPI" command (virtual GPI). */
	readonly supportsGpiTrigger: boolean
	/** Firmware versions this driver has been verified against (prefix match). */
	readonly testedVersions: readonly string[]
	/** Set by the module: receives raw payloads the driver normalizes away, for the debug samples on untested firmware. */
	sample?: (key: string, data: unknown) => void

	/** Authenticate (if needed). Throws on bad credentials or an unreachable device. */
	connect(): Promise<void>
	/** Stop timers. The driver can be connected again afterwards. */
	disconnect(): void
	socketOptions(): SocketOptions
	/** Register a callback for when the auth token changes (the socket handshake needs the new one). */
	onAuthChanged(cb: () => void): void

	// --- reads ---
	device(): Promise<DeviceInfo>
	roles(): Promise<Role[]>
	endpoints(): Promise<Endpoint[]>
	connections(): Promise<Connection[]>
	connectionsLive(): Promise<ConnectionLiveStatus[]>
	ports(): Promise<Port[]>
	gpio(): Promise<Gpio[]>

	// --- writes ---
	call(e: Endpoint, active: boolean, text: string): Promise<unknown>
	rmk(e: Endpoint): Promise<unknown>
	changeRole(e: Endpoint, role: Role): Promise<unknown>
	portRoute(p: Port, connectionId: number, join: boolean): Promise<unknown>
	portCall(p: Port, on: boolean): Promise<unknown>
	/** Whether a port can send a call signal (used to pick the ports of a channel call). */
	canCallPort(p: Port): boolean
	/** `enabled: null` releases a forced GPO back to automatic control. */
	setGpo(id: number, enabled: boolean | null): Promise<unknown>
	setGpi(id: number, enabled: boolean): Promise<unknown>
}
