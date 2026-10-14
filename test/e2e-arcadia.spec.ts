/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// End-to-end: the real module (in a fake Companion host) against the simulator in Arcadia mode.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { Harness, sleep, waitFor } from './harness.js'

const PASSWORD = 'secret'

// 'schema' follows the published API schema; '4.2' is the payload format of a real Arcadia on firmware 4.2.83
// (key states as an object, role association by roleset gid).
describe.each(['schema', '4.2'] as const)('Arcadia end-to-end (%s payloads)', (firmware) => {
	let sim: Simulator
	let h: Harness
	const v = (id: string) => h.variables[id]
	const posts = (path: string) => sim.requests.filter((r) => r.method === 'POST' && r.path === path)
	type Section = { id: string; definitions: { id: string; presets: string[] }[] }
	const sectionGroups = (section: string) =>
		(h.presetStructure as Section[]).find((s) => s.id === section)?.definitions.map((g) => g.id) ?? []
	const crewGroup = (group: string) =>
		(h.presetStructure as Section[]).find((s) => s.id === 'crew')?.definitions.find((g) => g.id === group)?.presets ??
		[]

	beforeAll(async () => {
		sim = await createSimulator({ mode: 'arcadia', password: PASSWORD, firmware })
		h = new Harness()
		await h.init({ deviceType: 'arcadia', host: sim.host, username: 'admin' }, { password: PASSWORD })
		await waitFor(() => h.status?.status === 'ok', 'status ok')
	})

	afterAll(async () => {
		await h?.destroy()
		await sim?.close()
	})

	it('connects, logs in and loads the device', () => {
		expect(posts('/auth/local/login')).toHaveLength(1)
		expect(h.status?.message).toBe('Connected — 5/6 devices online')
		expect(v('base_type')).toBe('NEP-ARCADIA')
		expect(v('base_version')).toBe('4.1.83.41')
		expect(v('base_label')).toBe('Arcadia-SIM')
		expect(v('packs_total')).toBe(6)
		expect(v('packs_online')).toBe(5)
		expect(h.logs.some((l) => l.includes('has not been tested'))).toBe(true)
	})

	it('builds role and channel variables from rolesets, associations and keysets', () => {
		expect(v('r1_label')).toBe('Director')
		expect(v('r1_pack')).toBe('FSII-BP-2001')
		expect(v('r1_online')).toBe(true)
		expect(v('r1_battery')).toBe(82)
		expect(v('r1_rssi')).toBe(60)
		expect(v('r1_time_left')).toBe('9:20')
		expect(v('r2_battery')).toBe(15)
		expect(v('r4_battery')).toBe('') // HelixNet beltpack: wired, no battery
		expect(v('r7_online')).toBe(false)
		expect(v('low_battery_list')).toBe('Camera 1 (15%)')
		expect(v('ch1_label')).toBe('Production')
		expect(v('ch2_members')).toBe(5) // Camera 1, Camera 2, Director, Audio, 4W-1
		expect(h.variableDefs.r1_talking?.name).toBe('Role Director: keys talking (e.g. "1,R")')
	})

	it('offers Arcadia-only actions and presets', () => {
		expect(h.actions.gpi_trigger).toBeTruthy()
		expect(Object.keys(h.presets)).toEqual(
			expect.arrayContaining([
				'crew_r1',
				'crew_r7',
				'key_r1_0',
				'ch_1',
				'route_port1_ch1',
				'gpitrigger_1',
				'status_device',
			]),
		)
		expect(h.presets.rmk_all).toBeUndefined() // only offered when enabled in the config
	})

	it('shows talk tallies per role, key and channel (keysets mapped by device type)', async () => {
		sim.setTalk(2001, 0, true) // Director key 1 -> Production
		await waitFor(() => v('r1_talking') === '1', 'r1_talking')
		expect(h.feedback('role_talking', { targets: ['r:1'], names: '', key: 'any' })).toBe(true)
		expect(h.feedback('role_talking', { targets: ['r:1'], names: '', key: 0 })).toBe(true)
		expect(h.feedback('role_talking', { targets: ['r:1'], names: '', key: 1 })).toBe(false)
		expect(h.feedback('channel_talking', { connection: 1 })).toBe(true)
		expect(h.feedback('channel_talking', { connection: 2 })).toBe(false)
		expect(v('ch1_talkers')).toBe('Director')

		// FreeSpeak Edge endpoint (FSE-BP) uses an E-BP keyset: key 1 -> Camera
		sim.setTalk(2002, 0, true)
		await waitFor(() => h.feedback('channel_talking', { connection: 2 }), 'channel 2 talking')
		await waitFor(() => v('ch2_talkers') === 'Camera 1', 'ch2_talkers')

		sim.setTalk(2001, 0, false)
		sim.setTalk(2002, 0, false)
		await waitFor(() => v('r1_talking') === '' && v('r2_talking') === '', 'talk released')
		expect(h.feedback('channel_talking', { connection: 1 })).toBe(false)
	})

	it('sends call signals with the endpoint gid, and shows them', async () => {
		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'on', pulseMs: 2000, text: 'hello' })
		expect(posts('/api/1/devices/1/endpoints/2003/call').at(-1)?.body).toEqual({
			active: true,
			text: 'hello',
			gid: 'EP-2003',
		})
		await waitFor(() => v('r3_calling') === true, 'r3_calling')
		expect(h.feedback('role_calling', { targets: [], names: 'camera 2' })).toBe(true)
		expect(v('last_caller')).toBe('Companion') // sent from Companion
		expect(v('last_call_channel')).toBe('')

		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'off', pulseMs: 2000, text: '' })
		await waitFor(() => v('r3_calling') === false, 'r3 call off')

		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'pulse', pulseMs: 300, text: '' })
		await waitFor(() => v('r3_calling') === true, 'pulse on')
		await waitFor(() => v('r3_calling') === false, 'pulse off')
	})

	it('calls a whole channel and credits the call to Companion', async () => {
		const before = sim.requests.length
		await h.action('call_channel', { connection: 2, mode: 'on', pulseMs: 2000, text: '' })
		const called = sim.requests
			.slice(before)
			.filter((r) => r.path.endsWith('/call'))
			.map((r) => r.path)
			.sort()
		expect(called).toEqual([
			'/api/1/devices/1/endpoints/2001/call',
			'/api/1/devices/1/endpoints/2002/call',
			'/api/1/devices/1/endpoints/2003/call',
			'/api/1/devices/1/endpoints/2006/call',
		])
		await waitFor(() => v('last_caller') === 'Companion' && v('last_call_channel') === 'Camera', 'last call')
		expect(h.feedback('channel_calling', { connection: 2 })).toBe(true)
		await h.action('call_channel', { connection: 2, mode: 'off', pulseMs: 2000, text: '' })
		await waitFor(() => !h.feedback('channel_calling', { connection: 2 }), 'channel call off')
	})

	it('changes a device role through the association, and learns it', async () => {
		await h.action('change_role', { pack: 2003, role: 7 })
		expect(posts('/api/1/devices/1/endpoints/2003/changeassociation').at(-1)?.body).toEqual({
			gid: 'EP-2003',
			association: { gid: 'RS-7' },
		})
		await waitFor(() => v('r7_pack') === 'Edge-2003', 'r7_pack')
		expect(v('r3_pack')).toBe('')
		// presets follow the new role: Spare is now in use (with key tallies), Camera 2 is not
		await waitFor(() => crewGroup('crew_in_use').includes('crew_r7'), 'presets rebuilt for the new role')
		expect(crewGroup('crew_in_use')).not.toContain('crew_r3')
		expect(crewGroup('crew_other')).toContain('crew_r3')
		expect(sectionGroups('keys')).toContain('keys_r7')
		expect(await h.learn('change_role', { pack: 2003, role: 1 })).toEqual({ role: 7 })
		await h.action('change_role', { pack: 2003, role: 3 })
		await waitFor(() => v('r3_pack') === 'Edge-2003', 'role restored')
		await waitFor(() => crewGroup('crew_in_use').includes('crew_r3'), 'presets restored')
		expect(crewGroup('crew_other')).toContain('crew_r7')
	})

	it('routes ports to channels by their resource path', async () => {
		expect(h.feedback('port_in_channel', { port: 2, connection: 3 })).toBe(false)
		await h.action('port_route', { port: 2, connection: 3, mode: 'toggle' })
		expect(posts('/api/1/devices/1/interfaces/1/ports/2/join').at(-1)?.body).toEqual({
			target: '/api/1/connections/3',
		})
		await waitFor(() => h.feedback('port_in_channel', { port: 2, connection: 3 }), 'port joined')
		await h.action('port_route', { port: 2, connection: 3, mode: 'toggle' })
		await waitFor(() => !h.feedback('port_in_channel', { port: 2, connection: 3 }), 'port left')

		// leaving a channel the port is not on sends nothing
		const before = sim.requests.length
		await h.action('port_route', { port: 2, connection: 3, mode: 'leave' })
		expect(sim.requests.slice(before).filter((r) => r.path.endsWith('/leave'))).toEqual([])
		expect(await h.learn('port_route', { port: 1, connection: 5 })).toEqual({ connection: 1 })
	})

	it('reads GPIs active-low and triggers them', async () => {
		expect(h.feedback('gpi_state', { gpi: 1 })).toBe(false)
		expect(v('gpi1')).toBe(false)
		await h.action('gpi_trigger', { gpi: 1, mode: 'on' })
		expect(posts('/api/1/devices/1/setGPI').at(-1)?.body).toEqual({ id: 1, enabled: true })
		await waitFor(() => h.feedback('gpi_state', { gpi: 1 }), 'gpi on')
		await waitFor(() => v('gpi1') === true, 'gpi1 var')
		await h.action('gpi_trigger', { gpi: 1, mode: 'toggle' })
		await waitFor(() => !h.feedback('gpi_state', { gpi: 1 }), 'gpi toggled off')
	})

	it('forces and releases GPOs', async () => {
		await h.action('gpo_set', { gpo: 3, mode: 'on' })
		await waitFor(() => h.feedback('gpo_state', { gpo: 3 }), 'gpo on')
		await h.action('gpo_set', { gpo: 3, mode: 'release' })
		expect(posts('/api/1/devices/1/setGPO').at(-1)?.body).toEqual({ id: 3, enabled: null })
		await waitFor(() => !h.feedback('gpo_state', { gpo: 3 }), 'gpo released')
	})

	it('kills mics per role; RMK all stays off unless enabled', async () => {
		sim.setTalk(2001, 1, true)
		await waitFor(() => v('r1_talking') === '2', 'talking before RMK')
		await h.action('rmk_role', { targets: ['r:1'], names: '' })
		await waitFor(() => v('r1_talking') === '', 'RMK cleared talk')

		const before = posts('/api/1/devices/1/endpoints/2002/rmk').length
		await h.action('rmk_all', {})
		expect(posts('/api/1/devices/1/endpoints/2002/rmk')).toHaveLength(before)
		expect(h.logs.some((l) => l.includes('RMK all is disabled'))).toBe(true)
	})

	it('tracks devices going offline (empty liveStatus) and back', async () => {
		sim.setOnline(2004, false)
		await waitFor(() => v('r4_online') === false, 'r4 offline')
		expect(h.feedback('role_online', { targets: ['r:4'], names: '' })).toBe(false)
		expect(h.feedback('any_role_missing', { roles: [4] })).toBe(true)
		expect(v('packs_online')).toBe(4)
		sim.setOnline(2004, true)
		await waitFor(() => v('r4_online') === true, 'r4 back online')
		expect(h.feedback('any_role_missing', { roles: [4] })).toBe(false)
	})

	it('updates battery feedbacks live', async () => {
		expect(h.feedback('role_battery_below', { targets: ['r:1'], names: '', threshold: 50 })).toBe(false)
		sim.setBattery(2001, 30)
		await waitFor(() => v('r1_battery') === 30, 'battery update')
		expect(h.feedback('role_battery_below', { targets: ['r:1'], names: '', threshold: 50 })).toBe(true)
		expect(h.feedback('any_battery_below', { threshold: 20 })).toBe(true)
	})

	it('logs in again when the token has expired, and retries the request', async () => {
		const logins = posts('/auth/local/login').length
		const calls = posts('/api/1/devices/1/endpoints/2001/call').length
		sim.expireTokens()
		await h.action('call_role', { targets: ['r:1'], names: '', mode: 'on', pulseMs: 2000, text: '' })
		expect(posts('/auth/local/login').length).toBe(logins + 1)
		// the first attempt was rejected with 401, the retry went through
		expect(posts('/api/1/devices/1/endpoints/2001/call')).toHaveLength(calls + 2)
		expect(h.logs.some((l) => l.includes('Call') && l.includes('failed'))).toBe(false)
		await h.action('call_role', { targets: ['r:1'], names: '', mode: 'off', pulseMs: 2000, text: '' })
		expect(posts('/api/1/devices/1/endpoints/2001/call').at(-1)?.body.active).toBe(false)
	})

	it('reconnects and reloads after the socket drops', async () => {
		const loads = sim.requests.filter((r) => r.path === '/api/1/devices/endpoints').length
		sim.dropSockets()
		await waitFor(() => h.statuses.some((s) => s.status === 'connection_failure'), 'disconnect noticed')
		await waitFor(() => h.status?.status === 'ok', 'reconnected')
		expect(sim.requests.filter((r) => r.path === '/api/1/devices/endpoints').length).toBeGreaterThan(loads)
		expect(h.feedback('base_connected')).toBe(true)
	})
})

describe('Arcadia configuration', () => {
	let sim: Simulator
	beforeAll(async () => {
		sim = await createSimulator({ mode: 'arcadia', password: PASSWORD })
	})
	afterAll(async () => sim?.close())

	it('reports a missing password without contacting the device', async () => {
		const h = new Harness()
		await h.init({ deviceType: 'arcadia', host: sim.host })
		expect(h.status).toEqual({ status: 'bad_config', message: 'Enter the CCM password' })
		await h.destroy()
	})

	it('reports rejected credentials, then connects after the password is fixed', async () => {
		const h = new Harness()
		await h.init({ deviceType: 'arcadia', host: sim.host }, { password: 'wrong' })
		await waitFor(() => h.status?.status === 'bad_config', 'bad credentials')
		expect(h.status?.message).toContain('Login rejected')
		await h.update({ deviceType: 'arcadia', host: sim.host }, { password: PASSWORD })
		await waitFor(() => h.status?.status === 'ok', 'connected after fix')
		await h.destroy()
	})

	it('reports an unreachable device', async () => {
		const h = new Harness()
		await h.init({ deviceType: 'arcadia', host: '127.0.0.1:1' }, { password: PASSWORD })
		await waitFor(() => h.status?.status === 'connection_failure', 'connection failure')
		await h.destroy()
	})

	it('stops cleanly without leaking timers', async () => {
		const h = new Harness()
		await h.init({ deviceType: 'arcadia', host: sim.host }, { password: PASSWORD })
		await waitFor(() => h.status?.status === 'ok', 'connected')
		await h.destroy()
		const count = sim.requests.length
		await sleep(400)
		expect(sim.requests.length).toBe(count)
	})
})
