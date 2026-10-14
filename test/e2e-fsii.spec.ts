/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// End-to-end: the real module (in a fake Companion host) against the simulator in FreeSpeak II mode, which
// serves real captures from a FreeSpeak II base.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { Harness, waitFor } from './harness.js'

describe('FreeSpeak II end-to-end', () => {
	let sim: Simulator
	let h: Harness
	const v = (id: string) => h.variables[id]
	const posts = (path: string) => sim.requests.filter((r) => r.method === 'POST' && r.path === path)

	beforeAll(async () => {
		sim = await createSimulator({ mode: 'fsii' })
		h = new Harness()
		await h.init({ deviceType: 'fsii', host: sim.host })
		await waitFor(() => h.status?.status === 'ok', 'status ok')
	})

	afterAll(async () => {
		await h?.destroy()
		await sim?.close()
	})

	it('connects without login and loads the base', () => {
		expect(sim.requests.some((r) => r.path.startsWith('/auth'))).toBe(false)
		expect(h.status?.message).toBe('Connected — 11/20 devices online')
		expect(v('base_version')).toBe('1.6.15.0')
		expect(v('r35_label')).toBe('Role 35')
		expect(v('r35_pack')).toBe('FSII-BP-63184')
		expect(v('ch1_members')).toBe(14)
		expect(h.actions.gpi_trigger).toBeUndefined()
		expect(h.logs.some((l) => l.includes('has not been tested'))).toBe(false)
	})

	it('shows talk tallies from EndpointUpdated', async () => {
		sim.setTalk(63184, 0, true)
		await waitFor(() => v('r35_talking') === '1', 'r35 talking')
		expect(h.feedback('role_talking', { targets: ['r:35'], names: '', key: 0 })).toBe(true)
		sim.setTalk(63184, 0, false)
		await waitFor(() => v('r35_talking') === '', 'r35 released')
	})

	it('calls a role (body without gid) and tracks the call state', async () => {
		await h.action('call_role', { targets: ['r:35'], names: '', mode: 'on', pulseMs: 2000, text: '' })
		expect(posts('/api/1/devices/1/endpoints/63184/call').at(-1)?.body).toEqual({ active: true, text: '' })
		await waitFor(() => v('r35_calling') === true, 'r35 calling')
		await h.action('call_role', { targets: ['r:35'], names: '', mode: 'toggle', pulseMs: 2000, text: '' })
		await waitFor(() => v('r35_calling') === false, 'toggle off')
	})

	it('changes a pack role with changerole', async () => {
		await h.action('change_role', { pack: 63184, role: 11 })
		expect(posts('/api/1/devices/1/endpoints/63184/changerole').at(-1)?.body).toEqual({ id: 11 })
		await waitFor(() => v('r11_pack') === 'FSII-BP-63184, FSII-BP-37044', 'r11 pack (online first)')
		expect(v('r11_online')).toBe(true)
		await h.action('change_role', { pack: 63184, role: 35 })
		await waitFor(() => v('r35_pack') === 'FSII-BP-63184', 'role restored')
	})

	it('routes ports with the hardware index decoded from the port id', async () => {
		expect(h.feedback('port_in_channel', { port: 66305, connection: 2 })).toBe(false)
		await h.action('port_route', { port: 66305, connection: 2, mode: 'join' })
		expect(posts('/api/1/devices/1/interfaces/3/ports/66305/join')).toHaveLength(1)
		await waitFor(() => h.feedback('port_in_channel', { port: 66305, connection: 2 }), 'port joined')
		await waitFor(() => v('ch2_members') === 9, 'member count updated (8 + port)')
		await h.action('port_route', { port: 66305, connection: 2, mode: 'toggle' })
		await waitFor(() => !h.feedback('port_in_channel', { port: 66305, connection: 2 }), 'port left')
	})

	it('calls a whole channel including its 2W/4W ports', async () => {
		const before = sim.requests.length
		await h.action('call_channel', { connection: 1, mode: 'on', pulseMs: 2000, text: '' })
		const paths = sim.requests.slice(before).map((r) => r.path)
		expect(paths).toContain('/api/1/devices/1/interfaces/1/ports/65792/gpo') // Broadcast 2W
		expect(paths).toContain('/api/1/devices/1/interfaces/3/ports/66304/gpo') // 4W-Port 1
		expect(paths.filter((p) => p.endsWith('/call')).length).toBeGreaterThan(0)
		await waitFor(() => v('last_caller') === 'Companion' && v('last_call_channel') === 'Channel 1', 'last call')
		await h.action('call_channel', { connection: 1, mode: 'off', pulseMs: 2000, text: '' })
	})

	it('reads GPIs active-high and toggles GPOs', async () => {
		expect(h.feedback('gpi_state', { gpi: 1 })).toBe(false)
		sim.setGpi(1, true)
		await waitFor(() => h.feedback('gpi_state', { gpi: 1 }), 'gpi asserted')
		await h.action('gpo_set', { gpo: 3, mode: 'toggle' })
		expect(posts('/api/1/devices/1/setGPO').at(-1)?.body).toEqual({ id: 3, enabled: true })
		await waitFor(() => h.feedback('gpo_state', { gpo: 3 }), 'gpo on')
	})

	it('can invert GPI polarity from the config', async () => {
		await h.update({ deviceType: 'fsii', host: sim.host, invertGpi: true })
		await waitFor(() => h.status?.status === 'ok', 'reconnected')
		expect(h.feedback('gpi_state', { gpi: 1 })).toBe(false) // asserted, but inverted
		expect(h.feedback('gpi_state', { gpi: 2 })).toBe(true)
	})

	it('kills all mics only when enabled in the config', async () => {
		await h.update({ deviceType: 'fsii', host: sim.host, rmkAllEnabled: true })
		await waitFor(() => h.status?.status === 'ok', 'reconnected')
		const before = sim.requests.length
		await h.action('rmk_all', {})
		const rmks = sim.requests.slice(before).filter((r) => r.path.endsWith('/rmk'))
		expect(rmks).toHaveLength(11) // every online pack
	})

	it('switches to Arcadia mode and back on a config change', async () => {
		await h.update({ deviceType: 'arcadia', host: sim.host })
		expect(h.status).toEqual({ status: 'bad_config', message: 'Enter the CCM password' })
		await h.update({ deviceType: 'fsii', host: sim.host })
		await waitFor(() => h.status?.status === 'ok', 'fsii again')
		expect(v('r35_label')).toBe('Role 35')
	})
})
