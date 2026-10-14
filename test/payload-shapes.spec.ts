/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// Device payloads in shapes other than the ones the module was written against. An Arcadia on firmware 4.2.83
// did not send `liveStatus.keyState` as an array, which stopped the whole module ("... .some is not a function").
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeArcadiaRoles } from '../src/drivers/arcadia.js'
import { keyStates, isTalking, packRoleId, packRoles, talkingKeys } from '../src/resolve.js'
import { DeviceState } from '../src/state.js'
import { asList, type Endpoint } from '../src/types.js'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { Harness, waitFor } from './harness.js'

const pack = (keyState: unknown): Endpoint =>
	({ id: 1, label: 'P', type: 'FSII-BP', liveStatus: { status: 'online', keyState } }) as Endpoint

describe('keyStates()', () => {
	it('reads an array (FreeSpeak II), using keysetIndex when present', () => {
		const ks = keyStates(pack([{ currentState: 'listen' }, { keysetIndex: 3, currentState: 'talk' }]))
		expect(ks.map(({ idx }) => idx)).toEqual([0, 3])
	})

	it('reads an object keyed by key index', () => {
		const e = pack({ '0': { currentState: 'listen' }, '2': { currentState: 'talk+listen' } })
		expect(keyStates(e).map(({ idx, k }) => [idx, k.currentState])).toEqual([
			[0, 'listen'],
			[2, 'talk+listen'],
		])
		expect(isTalking(new DeviceState(), e, 2)).toBe(true)
		expect(isTalking(new DeviceState(), e, 0)).toBe(false)
		expect(talkingKeys(new DeviceState(), e)).toBe('3')
	})

	it('ignores anything else instead of throwing', () => {
		for (const raw of [undefined, null, 'talk', 42, true, [null, 7, 'x'], { a: null }]) {
			expect(() => keyStates(pack(raw))).not.toThrow()
			expect(isTalking(new DeviceState(), pack(raw))).toBe(false)
		}
		expect(keyStates(undefined)).toEqual([])
	})
})

describe('role order', () => {
	it('sorts roles by label, numbers by value, case-insensitively', () => {
		const s = new DeviceState()
		const labels = ['10 Julius', 'arcadia', '2 Bob', '01 Harry', 'Zed', '06 Micha', '06 Ich']
		s.setRoles(labels.map((label, i) => ({ id: i + 1, label, type: '', isDefault: false, keys: {} })))
		expect(packRoles(s).map((r) => r.label)).toEqual([
			'01 Harry',
			'2 Bob',
			'06 Ich',
			'06 Micha',
			'10 Julius',
			'arcadia',
			'Zed',
		])
	})
})

describe('lists that are not arrays', () => {
	it('asList takes arrays, object values, and nothing else', () => {
		expect(asList([1, 2])).toEqual([1, 2])
		expect(asList({ a: 1, b: 2 })).toEqual([1, 2])
		expect(asList(null)).toEqual([])
		expect(asList('abc')).toEqual([])
	})

	it('state snapshots accept objects keyed by id and skip junk entries', () => {
		const s = new DeviceState()
		s.setEndpoints({ '5': { id: 5, label: 'A', type: 'FSII-BP' }, x: null } as unknown as Endpoint[])
		expect([...s.endpoints.keys()]).toEqual([5])
		s.setConnectionLive({ '1': { id: 1, participants: { a: { label: 'x' } } } } as never, () => '')
		expect(s.connectionLive.get(1)).toBeTruthy()
		s.setPorts([null, { port_id: 9, port_label: 'P' }] as never)
		expect([...s.ports.keys()]).toEqual([9])
	})

	it('Arcadia roles accept keyset slots and entities as objects', () => {
		const roles = normalizeArcadiaRoles(
			{ '1': { id: 1, name: 'Dir', sessions: { a: { data: { settings: { defaultRole: 10 } } } } } } as never,
			[
				{
					id: 10,
					type: 'FSII-BP',
					settings: { keysets: { '0': { entities: { a: { res: '/api/1/connections/3', type: 0 } } } } },
				},
			] as never,
		)
		expect(roles[0].keys['FSII-BP']).toEqual([
			{ index: 0, connections: [3], entities: ['/api/1/connections/3'], isReply: false },
		])
	})
})

describe('Arcadia 4.2.83 payload formats (shapes taken from a real device)', () => {
	// rolesets name their keysets directly; keysets carry the key layout per device type
	const rolesets = [
		{
			id: 2,
			gid: '3.88.X.0000.0002',
			name: 'Crew A',
			label: 'Crew A',
			keysets: [{ gid: '3.23.X.0000.000e', id: 14, type: 'FSII-BP', label: 'FSBP 1', res: '/api/2/roles/14' }],
			res: '/api/2/rolesets/2',
		},
	]
	const keysets = [
		{
			id: 14,
			type: 'FSII-BP',
			label: 'FSBP 1',
			isDefault: false,
			settings: {
				keysets: [
					{ keysetIndex: 0, entities: [{ type: 0, res: '/api/1/connections/1' }], talkBtnMode: 'latching' },
					{ keysetIndex: 1, entities: [{ type: 0, res: '/api/1/connections/2' }], talkBtnMode: 'latching' },
					{ keysetIndex: 4, entities: [], isReplyKey: true },
				],
			},
			gid: '3.23.X.0000.000e',
			res: '/api/2/roles/14',
		},
	]
	const endpoint = (status: 'online' | 'offline', live: Record<string, unknown> = {}): Endpoint => ({
		res: '/api/1/devices/1/endpoints/39588',
		id: 39588,
		gid: '1.04.BP039588.00.000000',
		label: 'FSII-BP-39588',
		type: 'FSII-BP',
		liveStatus: {
			keyState: {
				'0': { keysetIndex: 0, currentState: 'listen', volume: 46 },
				'1': { keysetIndex: 1, currentState: 'talk', volume: 80 },
			},
			status,
			...live,
		},
		settings: { rolesetAssociation: '3.88.X.0000.0002' },
	})

	it('reads key layouts from rolesets that list their keysets', () => {
		const roles = normalizeArcadiaRoles(rolesets, keysets)
		expect(roles[0].keys['FSII-BP']?.map((k) => [k.index, k.connections, k.isReply])).toEqual([
			[0, [1], false],
			[1, [2], false],
			[4, [], true],
		])
	})

	it('maps devices to roles by roleset gid, live while online, assigned while offline', () => {
		const s = new DeviceState()
		s.setRoles([
			...normalizeArcadiaRoles(rolesets, keysets),
			{ id: 7, label: 'Other', type: '', isDefault: false, gid: 'G7', keys: {} },
		])
		s.setEndpoints([endpoint('online', { rolesetAssociation: 'G7' })])
		const e = s.endpoints.get(39588)!
		expect(packRoleId(e, s)).toBe(7)
		s.applyEndpointUpdate({ endpointId: 39588, path: 'liveStatus', value: {} })
		expect(packRoleId(e, s)).toBe(2)
		expect(packRoleId(endpoint('online'), s)).toBe(2)
		expect(talkingKeys(s, endpoint('online'))).toBe('2')
	})
})

describe('Arcadia 4.2.83 payloads end-to-end', () => {
	let sim: Simulator
	let h: Harness
	const v = (id: string) => h.variables[id]

	beforeAll(async () => {
		sim = await createSimulator({ mode: 'arcadia', password: 'pw', firmware: '4.2' })
		h = new Harness()
		await h.init({ deviceType: 'arcadia', host: sim.host, username: 'admin' }, { password: 'pw' })
		await waitFor(() => h.status?.status === 'ok', 'status ok')
	})

	afterAll(async () => {
		await h?.destroy()
		await sim?.close()
	})

	it('connects and loads (the payload that stopped v0.2.0), and maps devices to roles by roleset gid', async () => {
		expect(h.status?.message).toBe('Connected — 5/6 devices online')
		expect(h.logs.some((l) => l.includes('is not a function'))).toBe(false)
		expect(v('r1_pack')).toBe('FSII-BP-2001')
		// an offline device keeps its assigned role (settings.rolesetAssociation)
		sim.setOnline(2003, false)
		await waitFor(() => v('r3_online') === false, 'r3 offline')
		expect(v('r3_pack')).toBe('Edge-2003')
		expect(String(v('offline_list'))).toContain('Camera 2')
		sim.setOnline(2003, true)
		await waitFor(() => v('r3_online') === true, 'r3 online')
	})

	it('logs payload samples on untested firmware, once each, at debug level', () => {
		const samples = h.logs.filter((l) => l.includes('Sample '))
		expect(samples.every((l) => l.startsWith('[debug]'))).toBe(true)
		expect(samples.some((l) => l.includes('Sample payload types') && l.includes('"keyState":"object"'))).toBe(true)
		expect(samples.some((l) => l.includes('Sample rolesets (raw)'))).toBe(true)
		expect(samples.some((l) => l.includes('Sample keysets (raw)'))).toBe(true)
		expect(samples.some((l) => l.includes('Sample event EndpointUpdated liveStatus'))).toBe(true)
		const keys = samples.map((l) => l.replace(/:.*$/, ''))
		expect(new Set(keys).size).toBe(keys.length)
	})

	it('reports an error while drawing as a module error, keeps the connection, and recovers', async () => {
		const original = h.instance.setVariableValues.bind(h.instance)
		let fail = true
		h.instance.setVariableValues = (values) => {
			if (fail) {
				fail = false
				throw new TypeError('simulated drawing failure')
			}
			original(values)
		}
		sim.setTalk(2001, 1, true)
		await waitFor(() => h.status?.status === 'unknown_warning', 'warning status')
		expect(h.status?.message).toBe('Module error: simulated drawing failure')
		expect(h.logs.some((l) => l.startsWith('[error] Module error while drawing the state'))).toBe(true)
		expect(h.instance.socketConnected).toBe(true)

		sim.setTalk(2001, 1, false)
		await waitFor(() => h.status?.status === 'ok', 'status ok again')
		h.instance.setVariableValues = original
	})
})
