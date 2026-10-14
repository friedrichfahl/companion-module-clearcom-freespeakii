import { EventEmitter } from 'node:events'
import io from 'socket.io-client'
import type { SocketOptions } from './drivers/driver.js'

// Topics the CCM UI subscribes to. The server answers each with `live:<topic> {updated:true}` dirty flags.
// Arcadia also announces `rolesets`, `keysets` and `gpios`; subscribing to a topic a device does not know is harmless.
const LIVE_TOPICS = [
	'devices',
	'interfaces',
	'ports',
	'roles',
	'rolesets',
	'keysets',
	'connections',
	'vpl',
	'calls',
	'alerts',
	'endpoints',
	'gpios',
]
const RETRY_AFTER_ERROR_MS = 3000

export interface DeviceSocketEvents {
	connect: []
	disconnect: [reason: string]
	connectError: [message: string]
	/** Every server event, e.g. ('EndpointUpdated', {...}) or ('live:roles', {updated:true}) */
	event: [name: string, data: unknown]
}

type ManagerWithOpts = { opts: { extraHeaders?: Record<string, string> } }

/**
 * socket.io 2.x client for the device (the server speaks Engine.IO v3, so newer clients cannot connect).
 * Re-subscribes and requests fresh snapshots after every (re)connect.
 */
export class DeviceSocket extends EventEmitter<DeviceSocketEvents> {
	#socket: SocketIOClient.Socket | null = null
	#reconnectTimer: NodeJS.Timeout | null = null

	constructor(
		private readonly baseUrl: string,
		private readonly options: SocketOptions,
	) {
		super()
	}

	get connected(): boolean {
		return this.#socket?.connected ?? false
	}

	start(): void {
		const socket = io(`${this.baseUrl}/`, {
			path: '/socket.io',
			transports: this.options.transports,
			forceNew: true,
			reconnection: true,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
			timeout: 5000,
			extraHeaders: this.options.headers?.(),
		} as SocketIOClient.ConnectOpts)
		this.#socket = socket

		// socket.io v2 has no onAny(): wrap onevent to forward every server event.
		const s = socket as unknown as { onevent: (packet: { data: [string, ...unknown[]] }) => void }
		const onevent = s.onevent
		s.onevent = (packet) => {
			const [name, data] = packet.data
			this.emit('event', name, data)
			onevent.call(socket, packet)
		}

		socket.on('connect', () => {
			this.#subscribe()
			this.emit('connect')
		})
		socket.on('disconnect', (reason: string) => {
			this.emit('disconnect', reason)
			// socket.io 2 does not reconnect by itself when the server closed the socket (e.g. web service restart)
			if (reason === 'io server disconnect') this.#retry(1000)
		})
		socket.on('connect_error', (err: Error) => this.emit('connectError', err?.message ?? String(err)))
		// A namespace rejection (e.g. auth middleware) arrives as 'error'; the manager will not retry by itself
		// because the transport is still open, so start over with a fresh handshake.
		socket.on('error', (err: unknown) => {
			this.emit('connectError', err instanceof Error ? err.message : String(err))
			if (!socket.connected) this.#retry(RETRY_AFTER_ERROR_MS)
		})
		// pick up a refreshed auth token before every reconnection attempt
		socket.on('reconnect_attempt', () => this.updateHeaders())
	}

	/** Close and reopen the connection (new engine handshake with the current headers) after a delay. */
	#retry(ms: number): void {
		if (this.#reconnectTimer) return
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null
			const socket = this.#socket
			if (!socket || socket.connected) return
			this.updateHeaders()
			socket.close()
			socket.open()
		}, ms)
	}

	/** Push the current auth headers to the socket.io manager, so the next handshake uses them. */
	updateHeaders(): void {
		const manager = (this.#socket as unknown as { io?: ManagerWithOpts } | null)?.io
		const headers = this.options.headers?.()
		if (manager && headers) manager.opts.extraHeaders = headers
	}

	#subscribe(): void {
		const socket = this.#socket
		if (!socket) return
		for (const topic of LIVE_TOPICS) socket.emit('live:update', { [topic]: 'start' })
		// EndpointInit replies are broadcast to every connected client, so only ask on (re)connect.
		socket.emit('EndpointInit', {})
		socket.emit('GpiInit', {})
		socket.emit('GpoInit', {})
	}

	stop(): void {
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
		this.#reconnectTimer = null
		this.#socket?.removeAllListeners()
		this.#socket?.close()
		this.#socket = null
		this.removeAllListeners()
	}
}
