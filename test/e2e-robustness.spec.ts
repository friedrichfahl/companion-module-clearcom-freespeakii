/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// Live-show robustness: call signals never stay latched, live state survives reconnects, and busy devices or
// rejected sockets do not freeze the module.
import { afterEach, describe, expect, it } from 'vitest'
import { createSimulator, type Simulator, type SimulatorOptions } from '../tools/simulator/simulator.mjs'
import { Harness, sleep, waitFor } from './harness.js'

const PASSWORD = 'pw'
let sim: Simulator | undefined
let h: Harness | undefined

async function start(opts: SimulatorOptions = {}): Promise<{ sim: Simulator; h: Harness }> {
	sim = await createSimulator({ mode: 'arcadia', password: PASSWORD, ...opts })
	h = new Harness()
	await h.init({ deviceType: 'arcadia', host: sim.host }, { password: PASSWORD })
	await waitFor(() => h!.status?.status === 'ok', 'connected', 8000)
	return { sim, h }
}

afterEach(async () => {
	await h?.destroy()
	await sim?.close()
	h = sim = undefined
})

const callState = (s: Simulator, id: number): unknown => s.endpoints.get(id)?.liveStatus?.callState
const callPosts = (s: Simulator, id: number) =>
	s.requests.filter((r) => r.path === `/api/1/devices/1/endpoints/${id}/call`).map((r) => r.body.active)

describe('call signals never stay latched', () => {
	it('sends the pulse "off" even when the live connection dropped meanwhile', async () => {
		const { sim, h } = await start()
		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'pulse', pulseMs: 300, text: '' })
		expect(callState(sim, 2003)).toBe(true)
		sim.dropSockets()
		await waitFor(() => callState(sim, 2003) === false, 'pulse off delivered')
		expect(callPosts(sim, 2003)).toEqual([true, false])
	})

	it('sends pending pulse "off" commands before a config change restarts the connection', async () => {
		const { sim, h } = await start()
		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'pulse', pulseMs: 10_000, text: '' })
		await h.update({ deviceType: 'arcadia', host: sim.host, lowBattery: 30 }, { password: PASSWORD })
		expect(callState(sim, 2003)).toBe(false)
		expect(callPosts(sim, 2003)).toEqual([true, false])
	})

	it('releases a held call on the device it was sent to, even after that device changed role', async () => {
		const { sim, h } = await start()
		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'on', pulseMs: 0, text: '' })
		await h.action('change_role', { pack: 2003, role: 7 })
		await waitFor(() => h.variables.r7_pack === 'Edge-2003', 'role changed')
		await h.action('call_role', { targets: ['r:3'], names: '', mode: 'off', pulseMs: 0, text: '' })
		expect(callState(sim, 2003)).toBe(false)
	})

	it('releases held calls when the module is destroyed', async () => {
		const { sim, h } = await start()
		await h.action('call_channel', { connection: 2, mode: 'on', pulseMs: 0, text: '' })
		expect(callState(sim, 2002)).toBe(true)
		await h.destroy()
		expect(callState(sim, 2002)).toBe(false)
		expect(callState(sim, 2001)).toBe(false)
	})

	it('only calls ports that support a call signal on Arcadia (4-wire + GPIO)', async () => {
		const { sim, h } = await start()
		const before = sim.requests.length
		await h.action('call_channel', { connection: 2, mode: 'pulse', pulseMs: 100, text: '' })
		expect(sim.requests.slice(before).filter((r) => r.path.endsWith('/gpo'))).toEqual([]) // 4W-1 is a plain 4W
		await h.action('port_route', { port: 4, connection: 2, mode: 'join' })
		await waitFor(() => h.feedback('port_in_channel', { port: 4, connection: 2 }), '4WG joined')
		await h.action('call_channel', { connection: 2, mode: 'pulse', pulseMs: 100, text: '' })
		await waitFor(
			() => sim.requests.filter((r) => r.path === '/api/1/devices/1/interfaces/3/ports/4/gpo').length === 2,
			'4WG port called on and off',
		)
	})
})

describe('live state across reconnects', () => {
	it('keeps socket events that arrive while the snapshot is loading', async () => {
		const { sim, h } = await start({ delays: { '/api/1/devices/endpoints': 400 } })
		const loads = () => sim.requests.filter((r) => r.path === '/api/1/devices/endpoints').length
		const before = loads()
		sim.dropSockets()
		await waitFor(() => loads() > before, 'reload started')
		// the snapshot was taken now; Director starts talking while it is still in flight
		sim.setTalk(2001, 0, true)
		await waitFor(() => h.status?.status === 'ok' && h.variables.r1_talking === '1', 'talk survives the reload')
	})

	it('blanks live variables while disconnected', async () => {
		const { sim, h } = await start()
		expect(h.variables.packs_online).toBe(5)
		await sim.close()
		await waitFor(() => h.status?.status === 'connection_failure', 'disconnected')
		await waitFor(() => h.variables.packs_online === '', 'packs_online blank')
		expect(h.variables.r1_online).toBe(false)
		expect(h.variables.r1_battery).toBe('')
		expect(h.variables.base_state).toBe('Disconnected')
		expect(h.feedback('role_online', { targets: ['r:1'], names: '' })).toBe(false)
	})

	it('does not let a constant event stream hold back tallies', async () => {
		const { sim, h } = await start()
		let level = 90
		const flood = setInterval(() => sim.setBattery(2001, (level = level > 10 ? level - 1 : 90)), 20)
		try {
			await sleep(200)
			sim.setTalk(2001, 0, true)
			const t0 = Date.now()
			await waitFor(() => h.variables.r1_talking === '1', 'talk shown during flood', 2000)
			expect(Date.now() - t0).toBeLessThan(600)
		} finally {
			clearInterval(flood)
		}
	})

	it('recovers when the device rejects the socket connection', async () => {
		const { h } = await start({ rejectNamespaceTimes: 1 })
		expect(h.status?.status).toBe('ok')
		expect(h.logs.some((l) => l.includes('Unauthorized'))).toBe(true)
	})
})
