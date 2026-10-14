const DEFAULT_TIMEOUT_MS = 5000
const WRITE_SPACING_MS = 50

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message)
		this.name = 'ApiError'
	}
}

export interface HttpClientOptions {
	/** Extra headers for every request (e.g. the Arcadia bearer token). */
	headers?: () => Record<string, string>
	/**
	 * Called once when a request is answered with 401, with the headers that request was sent with. Return true
	 * (after re-authenticating, if needed) to retry the request. Not called for requests made with `noAuthRetry`.
	 */
	onUnauthorized?: (usedHeaders: Record<string, string>) => Promise<boolean>
	timeoutMs?: number
}

/**
 * Small JSON REST client for the embedded CCM web server. Reads run in parallel; writes go through a single
 * serialized queue with a short gap, so a mashed button or an "RMK all" loop cannot flood the device.
 */
export class HttpClient {
	#writeChain: Promise<unknown> = Promise.resolve()
	readonly #baseUrl: string

	constructor(
		host: string,
		private readonly options: HttpClientOptions = {},
	) {
		this.#baseUrl = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `http://${host}`
	}

	get baseUrl(): string {
		return this.#baseUrl
	}

	async request<T>(method: string, path: string, body?: unknown, noAuthRetry = false): Promise<T> {
		const headers = this.#headers(body)
		const res = await this.#fetch(method, path, body, headers)
		if (res.status === 401 && !noAuthRetry && this.options.onUnauthorized) {
			await res.body?.cancel()
			if (await this.options.onUnauthorized(headers)) {
				return this.#parse<T>(method, path, await this.#fetch(method, path, body, this.#headers(body)))
			}
			throw new ApiError(`${method} ${path} -> 401: Unauthorized`, 401)
		}
		return this.#parse<T>(method, path, res)
	}

	async get<T>(path: string): Promise<T> {
		return this.request<T>('GET', path)
	}

	/** Queue a write. Resolves/rejects with that write's own result. */
	async write<T = unknown>(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown): Promise<T> {
		const run = async () => {
			try {
				return await this.request<T>(method, path, body)
			} finally {
				await new Promise((r) => setTimeout(r, WRITE_SPACING_MS))
			}
		}
		const result = this.#writeChain.then(run, run)
		this.#writeChain = result.catch(() => undefined)
		return result
	}

	#headers(body: unknown): Record<string, string> {
		const headers: Record<string, string> = { Accept: 'application/json', ...this.options.headers?.() }
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		return headers
	}

	async #fetch(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
		return fetch(`${this.#baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		})
	}

	async #parse<T>(method: string, path: string, res: Response): Promise<T> {
		const text = await res.text()
		let parsed: unknown = text
		try {
			parsed = text ? JSON.parse(text) : undefined
		} catch {
			// some write routes answer with a bare string
		}
		if (!res.ok) {
			const p = parsed as { message?: string; error?: string; msg?: string } | undefined
			const message = (typeof p === 'object' && (p?.message ?? p?.error ?? p?.msg)) || text || res.statusText
			throw new ApiError(`${method} ${path} -> ${res.status}: ${message}`, res.status)
		}
		return parsed as T
	}
}

/** True when the device answered with an HTTP error (as opposed to a timeout or network failure). */
export function isHttpError(err: unknown): err is ApiError {
	return err instanceof ApiError && typeof err.status === 'number'
}
