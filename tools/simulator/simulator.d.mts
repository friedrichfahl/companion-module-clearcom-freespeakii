// Types for the simulator, so the TypeScript tests can drive it.
export interface SimulatorOptions {
	mode?: 'arcadia' | 'fsii'
	port?: number
	bind?: string
	username?: string
	password?: string
	tokenTtlS?: number
	activity?: boolean
	activityMs?: number
	quiet?: boolean
	/** Hold back responses for these paths (ms); the body is captured when the request arrives. */
	delays?: Record<string, number>
	/** Refuse the first n socket namespace connections, like an auth middleware would. */
	rejectNamespaceTimes?: number
	/** Arcadia payload format: the published API schema (default) or what firmware 4.2.83 sends. */
	firmware?: 'schema' | '4.2'
}

export interface SimRequest {
	method: string
	path: string
	body: any
	time: number
}

export interface Simulator {
	mode: 'arcadia' | 'fsii'
	port: number
	host: string
	url: string
	endpoints: Map<number, any>
	ports: Map<number, any>
	gpio: Map<number, any>
	data: any
	requests: SimRequest[]
	connectionLive(): any[]
	emit(name: string, payload: unknown): void
	setTalk(endpointId: number, keyIndex: number, talking: boolean): void
	setOnline(endpointId: number, online: boolean): void
	setBattery(endpointId: number, level: number): void
	setCall(endpointId: number, active: boolean): void
	setGpi(id: number, asserted: boolean): boolean
	setGpo(id: number, enabled: boolean | null): boolean
	expireTokens(): void
	dropSockets(): void
	close(): Promise<void>
}

export function createSimulator(opts?: SimulatorOptions): Promise<Simulator>
