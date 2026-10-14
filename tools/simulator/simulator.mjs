// Clear-Com CCM simulator for developing and testing the Companion module without hardware.
//
//   node tools/simulator/simulator.mjs --mode arcadia --port 8080 [--password admin] [--ttl 600] [--firmware 4.2] [--quiet]
//   node tools/simulator/simulator.mjs --mode fsii --port 8081
//
// It serves the REST routes and socket.io 2.x events the module uses. FreeSpeak II mode replays real captures
// from a FreeSpeak II base (test/fixtures/fsii); Arcadia mode uses a synthetic dataset built from the published
// API schema. With --activity (default on the command line) packs talk, call and drain batteries at random.

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// eslint-disable-next-line n/no-unpublished-import -- dev tool, socket.io is a dev dependency
import socketIo from 'socket.io'
import { arcadiaData } from './data-arcadia.mjs'

const clone = (v) => structuredClone(v)
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

function fsiiData() {
	const dir = new URL('../../test/fixtures/fsii/', import.meta.url)
	const load = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'))
	return {
		endpoints: load('endpoints'),
		roles: load('roles'),
		connections: load('connections'),
		connectionLive: load('connections_liveStatus'),
		ports: load('ports'),
		gpio: [
			{ id: 1, device_id: 1, label: 'GPI 1', type: 0, liveStatus: { id: 1, status: false } },
			{ id: 2, device_id: 1, label: 'GPI 2', type: 0, liveStatus: { id: 2, status: false } },
			{ id: 3, device_id: 1, label: 'GPO 1', type: 1, liveStatus: { id: 3, status: false, forced: false } },
			{ id: 4, device_id: 1, label: 'GPO 2', type: 1, liveStatus: { id: 4, status: false, forced: false } },
		],
		device: { label: 'FSII-SIM', version: '1.6.15.0', state: 'Connected' },
	}
}

export async function createSimulator(opts = {}) {
	const mode = opts.mode === 'fsii' ? 'fsii' : 'arcadia'
	const username = opts.username ?? 'admin'
	const password = opts.password ?? 'admin'
	const tokenTtlS = opts.tokenTtlS ?? 600
	const log = opts.quiet === false ? (...a) => console.log('[sim]', ...a) : () => {}
	const startedAt = Date.now()
	// Arcadia payload format. '4.2' is what an Arcadia on 4.2.83 sends: key states as an object keyed by key index,
	// and the role as a roleset gid (`liveStatus.rolesetAssociation` while online, `settings.rolesetAssociation`)
	// instead of `association.dpId`. The default follows the published API schema (1.0.1).
	const firmware = mode === 'arcadia' && opts.firmware === '4.2' ? '4.2' : 'schema'

	const data = mode === 'arcadia' ? arcadiaData() : fsiiData()
	const endpoints = new Map(data.endpoints.map((e) => [e.id, e]))
	const ports = new Map(data.ports.map((p) => [p.port_id, p]))
	const gpio = new Map(data.gpio.map((g) => [g.id, g]))
	const savedLive = new Map() // arcadia: liveStatus of packs taken offline
	const requests = []
	const tokens = new Map() // token -> expiry ms
	let tokenVersion = 0

	// ---------------------------------------------------------------------------------------------- auth
	function issueToken() {
		tokenVersion++
		const iat = Math.floor(Date.now() / 1000)
		const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: username, ver: tokenVersion, iat, exp: iat + tokenTtlS })}.sim${tokenVersion}`
		tokens.set(token, Date.now() + tokenTtlS * 1000)
		return token
	}
	function authorized(req) {
		if (mode !== 'arcadia') return true
		const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
		const exp = m && tokens.get(m[1])
		return !!exp && exp > Date.now()
	}

	// ---------------------------------------------------------------------------------------------- derived state
	const keysetFor = (roleId, endpointType) => {
		const rs = data.rolesets?.find((r) => r.id === roleId)
		const ids = Object.values(rs?.sessions ?? {}).map((s) => s.data.settings.defaultRole)
		const alias = { 'FSE-BP': 'E-BP' }[endpointType] ?? endpointType
		const list = ids.map((id) => data.keysets.find((k) => k.id === id)).filter(Boolean)
		return list.find((k) => k.type === alias) ?? list[0]
	}

	function arcadiaConnectionLive() {
		const byConn = new Map(data.connections.map((c) => [c.id, []]))
		for (const e of endpoints.values()) {
			const ls = e.liveStatus ?? {}
			if (e.isGateway || ls.status !== 'online' || !ls.association) continue
			const ks = keysetFor(ls.association.dpId, e.type)
			for (const key of ks?.settings.keysets ?? []) {
				const talking = (ls.keyState ?? []).some(
					(k) => k.keysetIndex === key.keysetIndex && String(k.currentState).includes('talk'),
				)
				for (const ent of key.entities) {
					if (!ent.res.includes('/connections/')) continue // direct keys to roles/ports are not channels
					const cid = Number(ent.res.split('/').pop())
					const list = byConn.get(cid)
					if (!list) continue
					const existing = list.find((p) => p.gid === e.gid)
					if (existing) {
						if (talking) existing.joinState = 'Talk-Listen'
						continue
					}
					list.push({
						id: e.gid,
						gid: e.gid,
						res: e.res,
						device_id: 1,
						label: e.label,
						type: e.type.toLowerCase().replace(/-.*/, ''),
						joinState: talking ? 'Talk-Listen' : 'Listen',
						state: 'connected',
						events: { call: false, talk: false, control: false },
					})
				}
			}
		}
		for (const p of ports.values()) {
			for (const cid of Object.keys(p.port_connections ?? {})) {
				byConn.get(Number(cid))?.push({
					id: p.gid,
					gid: p.gid,
					res: p.res,
					device_id: 1,
					label: p.port_label,
					type: String(p.port_config_type).toLowerCase(),
					joinState: 'Talk-Listen',
					state: 'connected',
					events: { call: false, talk: false, control: false },
				})
			}
		}
		return data.connections.map((c) => ({ id: c.id, label: c.label, type: c.type, participants: byConn.get(c.id) }))
	}

	const connectionLive = () => (mode === 'arcadia' ? arcadiaConnectionLive() : data.connectionLive)

	// ---------------------------------------------------------------------------------------------- events
	let io = null
	const emit = (name, payload) => {
		log('emit', name, JSON.stringify(payload).slice(0, 160))
		io?.emit(name, payload)
	}
	const rolesetGid = (roleId) => data.rolesets?.find((r) => r.id === roleId)?.gid
	const outKeys = (keys) =>
		firmware === '4.2' && Array.isArray(keys)
			? Object.fromEntries(keys.map((k, i) => [String(k.keysetIndex ?? i), k]))
			: keys
	const outLive = (ls) => {
		if (firmware !== '4.2' || !ls) return ls
		const { association, ...rest } = ls
		const out = { ...rest }
		if (ls.keyState !== undefined) out.keyState = outKeys(ls.keyState)
		if (association && ls.status === 'online') out.rolesetAssociation = rolesetGid(association.dpId)
		return out
	}
	const outEndpoint = (e) => {
		if (firmware !== '4.2' || !e.liveStatus) return e
		const roleId = e.liveStatus.association?.dpId ?? savedLive.get(e.id)?.association?.dpId
		const settings = roleId === undefined ? e.settings : { ...e.settings, rolesetAssociation: rolesetGid(roleId) }
		return { ...e, liveStatus: outLive(e.liveStatus), ...(settings ? { settings } : {}) }
	}
	// 4.2.83 lists a roleset's keysets directly instead of through sessions
	const outRoleset = (rs) => {
		if (firmware !== '4.2') return rs
		const { sessions, ...rest } = rs
		const keysets = Object.values(sessions ?? {}).map((s) => {
			const id = s.data.settings.defaultRole
			return { gid: `KS-${id}`, id, type: s.data.type, label: rs.label, res: `/api/2/roles/${id}` }
		})
		return { ...rest, keysets }
	}
	const outValue = (path, value) =>
		path === 'liveStatus.keyState' ? outKeys(value) : path === 'liveStatus' ? outLive(value) : value
	const endpointUpdated = (endpointId, path, raw) => {
		const value = outValue(path, raw)
		emit('EndpointUpdated', mode === 'arcadia' ? [{ endpointId, path, value }] : { endpointId, path, value })
	}
	const live = (topic, extra = {}) => emit(`live:${topic}`, { updated: true, ...extra })

	// ---------------------------------------------------------------------------------------------- control (tests/activity)
	const control = {
		setTalk(endpointId, keyIndex, talking) {
			const e = endpoints.get(endpointId)
			const keys = e?.liveStatus?.keyState
			const k = keys?.find((x) => x.keysetIndex === keyIndex)
			if (!k) return
			k.currentState = talking ? 'talk+listen' : 'listen'
			endpointUpdated(endpointId, 'liveStatus.keyState', clone(keys))
			if (mode === 'arcadia') live('connections')
		},
		setOnline(endpointId, online) {
			const e = endpoints.get(endpointId)
			if (!e) return
			if (mode === 'arcadia') {
				if (!online) {
					savedLive.set(endpointId, e.liveStatus)
					e.liveStatus = {}
				} else e.liveStatus = savedLive.get(endpointId) ?? { status: 'online' }
				endpointUpdated(endpointId, 'liveStatus', clone(e.liveStatus))
				live('connections')
			} else {
				e.liveStatus.status = online ? 'online' : 'offline'
				endpointUpdated(endpointId, 'liveStatus.status', e.liveStatus.status)
			}
		},
		setBattery(endpointId, level) {
			const e = endpoints.get(endpointId)
			if (!e?.liveStatus) return
			e.liveStatus.batteryLevel = level
			endpointUpdated(endpointId, 'liveStatus.batteryLevel', level)
		},
		setCall(endpointId, active) {
			const e = endpoints.get(endpointId)
			if (!e?.liveStatus) return
			e.liveStatus.callState = mode === 'arcadia' ? active : active ? 1 : 0
			endpointUpdated(endpointId, 'liveStatus.callState', e.liveStatus.callState)
		},
		setGpi(id, asserted) {
			const g = gpio.get(id)
			if (!g || g.type !== 0) return false
			// Arcadia reports GPIs active-low
			g.liveStatus.status = mode === 'arcadia' ? !asserted : asserted
			if (mode === 'arcadia')
				emit('GpiUpdated', { gpiId: id, path: 'liveStatus', value: { status: g.liveStatus.status } })
			else emit('GpiUpdated', { id, liveStatus: clone(g.liveStatus) })
			return true
		},
		setGpo(id, enabled) {
			const g = gpio.get(id)
			if (!g || g.type !== 1) return false
			g.liveStatus = { ...g.liveStatus, status: enabled === null ? false : !!enabled, forced: enabled !== null }
			if (mode === 'arcadia') emit('GpoUpdated', { gpoId: id, path: 'liveStatus', value: clone(g.liveStatus) })
			else emit('GpoUpdated', { id, liveStatus: clone(g.liveStatus) })
			return true
		},
		expireTokens() {
			for (const t of tokens.keys()) tokens.set(t, 0)
		},
		dropSockets() {
			for (const s of Object.values(io?.sockets.sockets ?? {})) s.disconnect(true)
		},
	}

	// ---------------------------------------------------------------------------------------------- REST
	// Responses are serialized when the request arrives and may be held back (opts.delays: { [path]: ms }) to
	// reproduce a snapshot that is older than the socket events sent meanwhile.
	const json = (res, status, body) => {
		const text = body === undefined ? '' : JSON.stringify(body)
		const send = () => {
			res.writeHead(status, { 'Content-Type': 'application/json' })
			res.end(text)
		}
		const delay = opts.delays?.[res.simPath]
		if (delay) setTimeout(send, delay)
		else send()
	}
	const ok = { status: 'success' }
	const deviceUptime = () => Math.floor((Date.now() - startedAt) / 1000) + 3600

	function findEndpointByPath(path, action) {
		const m = new RegExp(`^/api/1/devices/\\d+/endpoints/(\\d+)/${action}$`).exec(path)
		return m ? endpoints.get(Number(m[1])) : undefined
	}
	function findPortByPath(path, action) {
		for (const p of ports.values()) if (path === `${p.res}/${action}`) return p
		return undefined
	}

	function routePort(p, target, join) {
		const cid = Number(/\/connections\/(\d+)$/.exec(String(target ?? ''))?.[1])
		if (!data.connections.some((c) => c.id === cid))
			return [404, { message: `failed to find connection at index(${cid})` }]
		p.port_connections ??= {}
		if (join) p.port_connections[String(cid)] = { connectionState: 0 }
		else delete p.port_connections[String(cid)]
		if (mode === 'fsii') {
			const conn = data.connectionLive.find((c) => c.id === cid)
			if (conn) {
				conn.participants = conn.participants.filter((x) => x.res !== p.res)
				if (join)
					conn.participants.push({
						device_id: 1,
						id: p.port_userId ?? p.port_id,
						joinState: 'Talk-Listen',
						label: p.port_label,
						res: p.res,
						state: 'connected',
						type: p.port_config_type,
						events: { call: false, talk: false, control: false },
					})
			}
		}
		live('ports', mode === 'arcadia' ? { gids: [p.gid] } : {})
		live('connections')
		return [200, mode === 'arcadia' ? { status: 'success', joined: join } : ok]
	}

	function handleArcadia(method, path, body, res) {
		if (method === 'GET') {
			if (path === '/api/1/devices/1') return json(res, 200, { ...data.device, uptime: deviceUptime() })
			if (path === '/api/2/rolesets') return json(res, 200, data.rolesets.map(outRoleset))
			if (path === '/api/2/keysets') return json(res, 200, data.keysets)
			if (path === '/api/1/devices/endpoints') return json(res, 200, [...endpoints.values()].map(outEndpoint))
			if (path === '/api/1/connections') return json(res, 200, data.connections)
			if (path === '/api/1/connections/liveStatus') return json(res, 200, arcadiaConnectionLive())
			if (path === '/api/1/devices/interfaces/ports') return json(res, 200, [...ports.values()])
			if (path === '/api/1/devices/1/gpio') return json(res, 200, [...gpio.values()])
			return json(res, 404, { message: `No route ${path}` })
		}
		if (method !== 'POST') return json(res, 405, { message: 'Method not allowed' })
		let e
		if ((e = findEndpointByPath(path, 'call'))) {
			control.setCall(e.id, !!body.active)
			return json(res, 200, ok)
		}
		if ((e = findEndpointByPath(path, 'rmk'))) {
			for (const k of e.liveStatus?.keyState ?? [])
				if (String(k.currentState).includes('talk')) k.currentState = 'listen'
			endpointUpdated(e.id, 'liveStatus.keyState', clone(e.liveStatus?.keyState ?? []))
			return json(res, 200, ok)
		}
		if ((e = findEndpointByPath(path, 'changeassociation'))) {
			const rs = data.rolesets.find((r) => r.gid === body?.association?.gid)
			if (body?.association?.gid && !rs) return json(res, 400, { message: 'Association entity not found' })
			if (e.liveStatus?.status === 'online') {
				e.liveStatus.association = rs ? { dpId: rs.id, gid: rs.gid } : undefined
				endpointUpdated(e.id, 'liveStatus', clone(e.liveStatus))
			}
			live('endpoints', { gids: [e.gid] })
			live('connections')
			return json(res, 200, ok)
		}
		let p
		if ((p = findPortByPath(path, 'join'))) {
			const [s, b] = routePort(p, body?.target, true)
			return json(res, s, b)
		}
		if ((p = findPortByPath(path, 'leave'))) {
			const [s, b] = routePort(p, body?.target, false)
			return json(res, s, b)
		}
		if ((p = findPortByPath(path, 'gpo'))) {
			if (p.port_config_type !== '4WG') return json(res, 404, { message: 'The port could not be found.' })
			return json(res, 200, ok)
		}
		if (path === '/api/1/devices/1/setGPI') {
			return control.setGpi(body?.id, !!body?.enabled) ? json(res, 200, ok) : json(res, 404, { message: 'No such GPI' })
		}
		if (path === '/api/1/devices/1/setGPO') {
			return control.setGpo(body?.id, body?.enabled) ? json(res, 200, ok) : json(res, 404, { message: 'No such GPO' })
		}
		return json(res, 404, { message: `No route ${path}` })
	}

	function handleFsii(method, path, body, res) {
		if (method === 'GET') {
			if (path === '/api/1/devices/1/liveStatus') return json(res, 200, { ...data.device, uptime: deviceUptime() })
			if (path === '/api/1/roles') return json(res, 200, data.roles)
			if (path === '/api/1/devices/1/endpoints') return json(res, 200, [...endpoints.values()].map(outEndpoint))
			if (path === '/api/1/connections') return json(res, 200, data.connections)
			if (path === '/api/1/connections/liveStatus') return json(res, 200, data.connectionLive)
			if (path === '/api/1/devices/1/gpio') return json(res, 200, [...gpio.values()])
			const m = /^\/api\/1\/devices\/1\/interfaces\/(\d+)\/ports$/.exec(path)
			if (m)
				return json(
					res,
					200,
					[...ports.values()].filter((p) => ((p.port_id >> 8) & 0xff) === Number(m[1])),
				)
			return json(res, 404, { message: `No route ${path}` })
		}
		if (method !== 'POST') return json(res, 405, { message: 'Method not allowed' })
		let e
		if ((e = findEndpointByPath(path, 'call'))) {
			control.setCall(e.id, !!body.active)
			return json(res, 200, ok)
		}
		if ((e = findEndpointByPath(path, 'rmk'))) {
			for (const k of e.liveStatus?.keyState ?? [])
				if (String(k.currentState).includes('talk')) k.currentState = 'listen'
			endpointUpdated(e.id, 'liveStatus.keyState', clone(e.liveStatus?.keyState ?? []))
			return json(res, 200, ok)
		}
		if ((e = findEndpointByPath(path, 'changerole'))) {
			const role = data.roles.find((r) => r.id === body?.id)
			if (!role) return json(res, 400, { message: 'Role not found' })
			e.role = { id: role.id, isDefault: !!role.isDefault, label: role.label, res: `/api/1/roles/${role.id}` }
			e.settings = { ...e.settings, default_role: role.id }
			if (e.liveStatus?.status === 'online') {
				e.liveStatus.role = role.id
				endpointUpdated(e.id, 'liveStatus.role', role.id)
			}
			live('endpoints')
			return json(res, 200, ok)
		}
		const pm = /^\/api\/1\/devices\/1\/interfaces\/(\d+)\/ports\/(\d+)\/(join|leave|gpo)$/.exec(path)
		if (pm) {
			const p = ports.get(Number(pm[2]))
			if (!p || ((p.port_id >> 8) & 0xff) !== Number(pm[1]))
				return json(res, 404, { message: 'The port could not be found.' })
			if (pm[3] === 'gpo') return json(res, 200, ok)
			const [s, b] = routePort(p, body?.target, pm[3] === 'join')
			return json(res, s, b)
		}
		if (path === '/api/1/devices/1/setGPO') {
			return control.setGpo(body?.id, body?.enabled) ? json(res, 200, ok) : json(res, 404, { message: 'No such GPO' })
		}
		return json(res, 404, { message: `No route ${path}` })
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://sim')
		if (url.pathname.startsWith('/socket.io')) return // handled by socket.io
		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			let body
			try {
				body = raw ? JSON.parse(raw) : undefined
			} catch {
				return json(res, 400, { message: 'Invalid JSON' })
			}
			const path = url.pathname
			res.simPath = path
			requests.push({ method: req.method, path, body, time: Date.now() })
			log(req.method, path, raw.slice(0, 120))

			if (mode === 'arcadia' && path === '/auth/local/login' && req.method === 'POST') {
				if (body?.logemail !== username || body?.logpassword !== password)
					return json(res, 401, { message: 'Invalid username or password' })
				return json(res, 200, { jwt: issueToken() })
			}
			if (mode === 'arcadia' && path === '/auth/refresh' && req.method === 'POST') {
				if (!authorized(req)) return json(res, 401, { message: 'Unauthorized' })
				return json(res, 200, { jwt: issueToken() })
			}
			if (!authorized(req)) return json(res, 401, { message: 'Unauthorized' })
			return mode === 'arcadia' ? handleArcadia(req.method, path, body, res) : handleFsii(req.method, path, body, res)
		})
	})

	io = socketIo(server, {
		path: '/socket.io',
		serveClient: false,
		allowRequest: (req, cb) => cb(null, authorized(req)),
	})
	// opts.rejectNamespaceTimes: refuse the first n namespace connections (auth middleware style)
	let rejectsLeft = opts.rejectNamespaceTimes ?? 0
	io.use((socket, next) => {
		if (rejectsLeft > 0) {
			rejectsLeft--
			return next(new Error('Unauthorized'))
		}
		next()
	})
	io.on('connection', (socket) => {
		log('socket connected', socket.id)
		socket.on('live:update', (topics) => log('subscribe', JSON.stringify(topics)))
		if (mode === 'fsii') {
			// the FSII base answers snapshot requests by broadcasting to every client
			socket.on('EndpointInit', () => emit('EndpointInit', { result: [...endpoints.values()].map(outEndpoint) }))
			socket.on('GpiInit', () => emit('GpiInit', { result: [...gpio.values()].filter((g) => g.type === 0) }))
			socket.on('GpoInit', () => emit('GpoInit', { result: [...gpio.values()].filter((g) => g.type === 1) }))
		}
		socket.emit('init', { server: 'clearcom-ccm-simulator', mode })
	})

	// ---------------------------------------------------------------------------------------------- activity
	let activityTimer = null
	if (opts.activity) {
		const rand = (n) => Math.floor(Math.random() * n)
		activityTimer = setInterval(() => {
			const packs = [...endpoints.values()].filter(
				(e) => !e.isGateway && !/antenna/i.test(e.type) && e.liveStatus?.status === 'online',
			)
			if (!packs.length) return
			const e = packs[rand(packs.length)]
			const r = Math.random()
			if (r < 0.6) {
				const keys = e.liveStatus.keyState ?? []
				const k = keys[rand(Math.min(keys.length, 4))]
				if (k) control.setTalk(e.id, k.keysetIndex, !String(k.currentState).includes('talk'))
			} else if (r < 0.75 && typeof e.liveStatus.batteryLevel === 'number') {
				control.setBattery(e.id, Math.max(1, e.liveStatus.batteryLevel - 1))
			} else if (r < 0.9) {
				const key = e.liveStatus.RSSI !== undefined ? 'RSSI' : 'rssi'
				e.liveStatus.linkQuality = 20 + rand(70)
				endpointUpdated(e.id, 'liveStatus.linkQuality', e.liveStatus.linkQuality)
				endpointUpdated(e.id, `liveStatus.${key}`, 30 + rand(50))
			} else {
				control.setCall(e.id, true)
				setTimeout(() => control.setCall(e.id, false), 2000)
			}
		}, opts.activityMs ?? 1500)
	}

	await new Promise((resolve) => server.listen(opts.port ?? 0, opts.bind ?? '127.0.0.1', resolve))
	const port = server.address().port

	return {
		mode,
		port,
		host: `127.0.0.1:${port}`,
		url: `http://127.0.0.1:${port}`,
		endpoints,
		ports,
		gpio,
		data,
		requests,
		connectionLive,
		emit,
		...control,
		async close() {
			if (activityTimer) clearInterval(activityTimer)
			io?.close()
			await new Promise((resolve) => server.close(() => resolve()))
		},
	}
}

// ------------------------------------------------------------------------------------------------ CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2)
	const arg = (name, def) => {
		const i = args.indexOf(`--${name}`)
		return i >= 0 ? args[i + 1] : def
	}
	const sim = await createSimulator({
		mode: arg('mode', 'arcadia'),
		port: Number(arg('port', '8080')),
		bind: arg('bind', '0.0.0.0'),
		password: arg('password', 'admin'),
		tokenTtlS: Number(arg('ttl', '600')),
		firmware: arg('firmware', 'schema'),
		activity: !args.includes('--no-activity'),
		quiet: args.includes('--quiet'),
	})
	console.log(
		`Clear-Com ${sim.mode === 'arcadia' ? 'Arcadia' : 'FreeSpeak II'} simulator listening on port ${sim.port}`,
	)
	console.log(
		`In Companion: host 127.0.0.1:${sim.port}${sim.mode === 'arcadia' ? ', username admin, password admin' : ''}`,
	)
	process.on('SIGINT', () => void sim.close())
}
