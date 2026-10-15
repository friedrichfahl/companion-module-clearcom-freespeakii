import type {
	CompanionInputFieldMultiDropdown,
	CompanionInputFieldTextInput,
	DropdownChoice,
} from '@companion-module/base'
import { packRoles, packs, SELECTED_TARGET } from './resolve.js'
import type { DeviceState } from './state.js'
import type { Port } from './types.js'

/** Key selector values: 'any', 'reply', or a 0-based key index. */
export const KEY_CHOICES: DropdownChoice[] = [
	{ id: 'any', label: 'Any key' },
	{ id: 'reply', label: 'Reply key' },
	...Array.from({ length: 12 }, (_, i) => ({
		id: i,
		label: i < 4 ? `Key ${i + 1} (${'ABCD'[i]} on FreeSpeak)` : `Key ${i + 1}`,
	})),
]

// Choice labels only use ids and configured labels, never live status, so devices going in and out of range do
// not force a rebuild of every definition. Live status is shown through variables and feedbacks instead.

/**
 * The role selected for the role detail page, then roles (target whoever holds the role), then physical
 * devices as a fallback.
 */
export function targetChoices(state: DeviceState): DropdownChoice<string>[] {
	const roles = packRoles(state).map((r) => ({ id: `r:${r.id}`, label: r.label }))
	const devices = packs(state)
		.sort((a, b) => a.label.localeCompare(b.label))
		.map((e) => ({ id: `p:${e.id}`, label: `Device ${e.label}` }))
	return [{ id: SELECTED_TARGET, label: 'Selected role (role detail page)' }, ...roles, ...devices]
}

export function roleChoices(state: DeviceState): DropdownChoice<number>[] {
	return packRoles(state).map((r) => ({ id: r.id, label: r.label }))
}

export function packChoices(state: DeviceState): DropdownChoice<number>[] {
	return packs(state)
		.sort((a, b) => a.label.localeCompare(b.label))
		.map((e) => ({ id: e.id, label: `${e.label} (${e.type})` }))
}

export function connectionChoices(state: DeviceState): DropdownChoice<number>[] {
	return [...state.connections.values()]
		.sort((a, b) => a.id - b.id)
		.map((c) => ({ id: c.id, label: c.type ? `${c.label} (${c.type})` : c.label }))
}

export function portLabel(p: Port): string {
	const kind = p.port_config_type ?? p.audioInterfaceType_shortName
	const details = [p.port_desc !== p.port_label ? p.port_desc : undefined, kind].filter(Boolean)
	return details.length ? `${p.port_label} (${details.join(', ')})` : p.port_label
}

export function portChoices(state: DeviceState): DropdownChoice<number>[] {
	return [...state.ports.values()]
		.sort((a, b) => a.port_id - b.port_id)
		.map((p) => ({ id: p.port_id, label: portLabel(p) }))
}

export function gpioChoices(list: Iterable<{ id: number; label?: string }>): DropdownChoice<number>[] {
	return [...list].map((g) => ({ id: g.id, label: g.label || `#${g.id}` }))
}

export const firstId = <T extends string | number>(choices: DropdownChoice<T>[], fallback: T): T =>
	choices[0]?.id ?? fallback

/** The "Roles / devices" multi-select plus free-text name field shared by actions and feedbacks. */
export function targetFields(
	choices: DropdownChoice<string>[],
): [CompanionInputFieldMultiDropdown<'targets'>, CompanionInputFieldTextInput<'names'>] {
	return [
		{ id: 'targets', type: 'multidropdown', label: 'Roles / devices', choices, default: [], minChoicesForSearch: 8 },
		{
			id: 'names',
			type: 'textinput',
			label: 'Or by name (comma separated role labels, device labels or ids)',
			default: '',
			useVariables: true,
		},
	]
}
