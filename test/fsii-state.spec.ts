/* eslint-disable n/no-unpublished-import */
// FreeSpeak II state and resolve tests, replaying real captures from a FreeSpeak II base (firmware 1.6.15).
// Ported from companion-module-clearcom-freespeakii and adapted to the shared device model.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { DeviceState, setByPath } from '../src/state.js'
import {
	channelCallers,
	channelTalkers,
	isCalling,
	isTalking,
	missingRoles,
	packRoleId,
	packsForRole,
	portInChannel,
	resolveTargets,
	talkingKeys,
} from '../src/resolve.js'
import { computeVariableValues } from '../src/variables.js'
import { normalizeFsiiRole } from '../src/drivers/fsii.js'
import type { ConnectionLiveStatus, Endpoint, EndpointUpdatedEvent, Participant } from '../src/types.js'

const fixture = <T>(name: string): T =>
	JSON.parse(readFileSync(new URL(`./fixtures/fsii/${name}.json`, import.meta.url), 'utf8')) as T

function loadedState(): DeviceState {
	const s = new DeviceState()
	s.setRoles(fixture<Parameters<typeof normalizeFsiiRole>[0][]>('roles').map(normalizeFsiiRole))
	s.setConnections(fixture('connections'))
	s.setEndpoints(fixture('endpoints'))
	s.setPorts(fixture('ports'))
	s.setConnectionLive(fixture('connections_liveStatus'), (p) => String(p.label))
	s.ready = true
	return s
}

const ids = (list: { id?: unknown }[]) => list.map((e) => e.id).sort()

describe('FSII state', () => {
	let s: DeviceState
	beforeEach(() => {
		s = loadedState()
	})

	it('ignores redundant EndpointInit broadcasts', () => {
		expect(s.setEndpoints(fixture('endpoints'))).toEqual({ live: false, structure: false })
	})

	it('flags structure changes only for identity changes', () => {
		const upd = (path: string, value: unknown) => s.applyEndpointUpdate({ endpointId: 63184, path, value })
		expect(upd('liveStatus.RSSI', 12)).toEqual({ live: true, structure: false })
		expect(upd('liveStatus.status', 'offline')).toEqual({ live: true, structure: false })
		expect(upd('liveStatus.role', 11)).toEqual({ live: true, structure: false })
		expect(upd('label', 'Renamed')).toEqual({ live: true, structure: true })
	})

	it('ignores updates for unknown endpoints or malformed events', () => {
		expect(s.applyEndpointUpdate({ endpointId: 1, path: 'liveStatus.RSSI', value: 1 }).live).toBe(false)
		expect(s.applyEndpointUpdate({ endpointId: 63184, path: '', value: 1 }).live).toBe(false)
		expect(s.applyEndpointUpdate(undefined as unknown as EndpointUpdatedEvent).live).toBe(false)
	})

	it('replays a 10 minute live capture without errors', () => {
		const events = fixture<{ event: string; data: unknown }[]>('events')
		for (const { event, data } of events) {
			if (event === 'EndpointInit') s.setEndpoints((data as { result: Endpoint[] }).result)
			else s.applyEndpointUpdate(data as EndpointUpdatedEvent)
		}
		expect(s.endpoints.size).toBe(30)
	})

	it('tracks call state from the captured call test', () => {
		const [on, off] = fixture<{ data: EndpointUpdatedEvent }[]>('call_events')
		const pack = s.endpoints.get(63184)!
		expect(isCalling(pack)).toBe(false)
		s.applyEndpointUpdate(on.data)
		expect(isCalling(pack)).toBe(true)
		s.applyEndpointUpdate(off.data)
		expect(isCalling(pack)).toBe(false)
	})

	it('detects a reboot from uptime going backwards', () => {
		const info = (uptime: number) => ({ uptime, version: '1.6.15.0', label: 'x', type: 'FSII-BASE', state: 'Online' })
		s.setDevice(info(1000))
		expect(s.setDevice(info(1010)).rebooted).toBe(false)
		expect(s.setDevice(info(5)).rebooted).toBe(true)
		expect(s.setDevice({ ...info(1), uptime: Number.NaN }).rebooted).toBe(false)
	})

	it('records a new incoming call once, not on every refresh', () => {
		const calling = structuredClone(fixture<ConnectionLiveStatus[]>('connections_liveStatus'))
		calling[0].participants[0].events = { call: true, talk: false, control: false }
		s.setConnectionLive(calling, (p) => `who:${p.id}`)
		const first = s.lastCall
		expect(first?.label).toBe(`who:${calling[0].participants[0].id}`)
		expect(first?.channel).toBe('Channel 1')
		s.setConnectionLive(structuredClone(calling), () => 'someone else')
		expect(s.lastCall).toBe(first)
	})

	it('records a pack call signal as the last call, with the channel Companion called', () => {
		const [on, off] = fixture<{ data: EndpointUpdatedEvent }[]>('call_events')
		s.noteCallChannel([63184], 'Channel 2')
		s.applyEndpointUpdate(on.data)
		const first = s.lastCall
		expect(first?.label).toBe('Companion')
		expect(first?.channel).toBe('Channel 2')
		expect(channelCallers(s, 2).map((p) => p.id)).toContain(63184)
		s.setEndpoints(structuredClone([...s.endpoints.values()]))
		expect(s.lastCall).toBe(first)
		s.applyEndpointUpdate(off.data)
		expect(channelCallers(s, 2)).toEqual([])
		expect(computeVariableValues(s, true, 20).last_caller).toBe('Companion')
	})

	it('leaves the channel blank for calls Companion did not send on a channel', () => {
		const [on] = fixture<{ data: EndpointUpdatedEvent }[]>('call_events')
		s.applyEndpointUpdate(on.data)
		expect(s.lastCall?.label).toBe('Role 35')
		expect(s.lastCall?.channel).toBe('')
	})

	it('setByPath creates intermediate objects', () => {
		const o: Record<string, unknown> = {}
		setByPath(o, 'a.b.c', 1)
		expect(o).toEqual({ a: { b: { c: 1 } } })
	})
})

describe('FSII resolve', () => {
	let s: DeviceState
	beforeEach(() => {
		s = loadedState()
	})

	it('resolves a role to the pack holding it', () => {
		expect(ids(packsForRole(s, 35))).toEqual([63184])
		expect(ids(resolveTargets(s, ['r:35']))).toEqual([63184])
	})

	it('falls back to the assigned role for offline packs', () => {
		expect(ids(packsForRole(s, 11))).toEqual([37044])
	})

	it('does not target transceivers', () => {
		expect(resolveTargets(s, ['p:1000000'])).toEqual([])
	})

	it('resolves free text by role label, pack label or id', () => {
		expect(ids(resolveTargets(s, [], 'role 35'))).toEqual([63184])
		expect(ids(resolveTargets(s, [], 'FSII-BP-37139, 37175'))).toEqual([37139, 37175])
		expect(resolveTargets(s, [], 'nobody')).toEqual([])
		expect(ids(resolveTargets(s, ['p:63184', 'r:35'], 'Role 35'))).toEqual([63184])
	})

	it('only reports talking for online packs', () => {
		// 48106 is offline but still reports a stale talk+listen key
		expect(isTalking(s, s.endpoints.get(48106)!)).toBe(false)
		const live = s.endpoints.get(63206)!
		expect(isTalking(s, live)).toBe(true)
		expect(isTalking(s, live, 1)).toBe(true)
		expect(isTalking(s, live, 0)).toBe(false)
		expect(isTalking(s, live, 'reply')).toBe(false)
		expect(talkingKeys(s, live)).toBe('2')
	})

	it('treats key 5 of a FreeSpeak II pack as the reply key', () => {
		s.applyEndpointUpdate({
			endpointId: 63206,
			path: 'liveStatus.keyState',
			value: [{ keysetIndex: 4, currentState: 'talk+listen', volume: 50 }],
		})
		const e = s.endpoints.get(63206)!
		expect(isTalking(s, e, 'reply')).toBe(true)
		expect(talkingKeys(s, e)).toBe('R')
	})

	it('reads port routing and channel tallies', () => {
		expect(portInChannel(s, 65536, 12)).toBe(true)
		expect(portInChannel(s, 65536, 1)).toBe(false)
		expect(channelTalkers(s, 1)).toEqual([])
	})

	it('finds channel talkers from pack key state, not events.talk', () => {
		// 63185 and 63206 hold key 2 on channel 4; the base reports events.talk=false for both
		const talkers = () =>
			channelTalkers(s, 4)
				.map((p: Participant) => p.id)
				.sort()
		expect(talkers()).toEqual([63185, 63206])

		// with role keysets, the key mapping wins over a stale joinState
		const role = s.roles.get(packRoleId(s.endpoints.get(63185)!, s)!)!
		role.keys = { '*': [{ index: 1, connections: [2], entities: ['/api/1/connections/2'], isReply: false }] }
		expect(talkers()).toEqual([63206])

		// releasing the key clears the tally immediately
		s.applyEndpointUpdate({
			endpointId: 63206,
			path: 'liveStatus.keyState',
			value: [{ keysetIndex: 1, currentState: 'listen', volume: 80 }],
		})
		expect(talkers()).toEqual([])
	})

	it('lists expected roles with no pack online', () => {
		expect(missingRoles(s, [35, 11]).map((r) => r.id)).toEqual([11])
	})
})

describe('FSII variables', () => {
	it('computes pack, role and channel values', () => {
		const v = computeVariableValues(loadedState(), true, 95)
		expect(v.packs_online).toBe(11)
		expect(v.packs_total).toBe(20)
		expect(v.r35_label).toBe('Role 35')
		expect(v.r35_pack).toBe('FSII-BP-63184')
		expect(v.r35_online).toBe(true)
		expect(v.r11_online).toBe(false)
		expect(v.r11_battery).toBe('')
		expect(v.ch1_members).toBe(14)
		expect(v.low_battery_list as string).toContain('Role 7 (71%)')
		expect(v.base_state).toBe('Connected')
	})

	it('reports disconnected state', () => {
		expect(computeVariableValues(new DeviceState(), false, 20).base_state).toBe('Disconnected')
	})
})
