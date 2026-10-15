import type {
	ButtonGraphicsBoxElement,
	ButtonGraphicsCircleElement,
	ButtonGraphicsGroupElement,
	ButtonGraphicsLineElement,
	ButtonGraphicsTextElement,
	CompanionGraphicsCompositeElementDefinitions,
	CompanionPresetFeedbackStyleOverride,
	SomeButtonGraphicsElement,
} from '@companion-module/base'

// The visual language of the presets. Colours mean the same on every button:
//   red = talking, amber = call signal, orange = low battery, green = routed / active / listening,
//   blue = selected (shown on the role detail page), dim grey = offline.

export const PALETTE = {
	/** Button background. */
	bg: 0x12161c,
	/** Raised surface: chips, tracks, idle switches. */
	panel: 0x222932,
	/** Dim lines and unlit meter segments. */
	track: 0x39414c,
	text: 0xffffff,
	dim: 0x9aa4b2,
	muted: 0x606a77,
	talk: 0xe0362c,
	talkDeep: 0x55130f,
	call: 0xffb000,
	callText: 0x1d1400,
	ok: 0x2ec36a,
	okDeep: 0x0f3b23,
	warn: 0xff7a1a,
	bad: 0xe8453c,
	info: 0x3aa7ff,
	infoDeep: 0x0d2d4a,
	offBg: 0x1e2228,
	offText: 0x5d6570,
	rmk: 0x6e141b,
	rmkHot: 0xb3202b,
	black: 0x000000,
	white: 0xffffff,
} as const

/** CSS colour strings for use inside expressions (expressions return strings, not numbers). */
const css = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

/** A property driven by an expression. */
export const expr = (value: string): { isExpression: true; value: string } => ({ isExpression: true, value })

// --- composite elements ---------------------------------------------------------------------------

export type CompositeElementsSchema = {
	battery: { options: { level: number; low: number; mid: number } }
	signal: { options: { bars: number } }
}

/**
 * Reusable meters, also offered in Companion's element picker ("Add element" on any layered button). The level
 * comes in through an option, so it can be wired to any variable, e.g. `$(arcadia:r12_battery)`.
 */
export const CompositeElements: CompanionGraphicsCompositeElementDefinitions<CompositeElementsSchema> = {
	battery: {
		type: 'composite',
		name: 'Clear-Com: battery meter',
		description: 'A battery icon filled to the level: red below "low", amber below "mid", green above',
		options: [
			{ id: 'level', type: 'number', label: 'Level (%)', default: 0, min: 0, max: 100 },
			{ id: 'low', type: 'number', label: 'Red below (%)', default: 20, min: 0, max: 100 },
			{ id: 'mid', type: 'number', label: 'Amber below (%)', default: 50, min: 0, max: 100 },
		],
		elements: [
			{
				id: 'shell',
				type: 'box',
				x: 0,
				y: 0,
				width: 92,
				height: 100,
				color: 'rgba(0,0,0,0)',
				borderWidth: 6,
				borderColor: css(0xc9ced6),
				borderPosition: 'inside',
				cornerRadius: 30,
			},
			{ id: 'cap', type: 'box', x: 93, y: 30, width: 7, height: 40, color: css(0xc9ced6), cornerRadius: 50 },
			{
				id: 'fill',
				type: 'gauge',
				x: 9,
				y: 22,
				width: 75,
				height: 56,
				orientation: 'horizontal',
				value: expr('$(options:level)'),
				min: 0,
				max: 100,
				fillEnabled: true,
				multiColour: false,
				fillWidth: 100,
				trackWidth: 100,
				trackStyle: 'dimmed',
				trackAmount: 12,
				markerEnabled: false,
				stops: [
					{ value: 0, color: PALETTE.bad, gradient: false },
					{ value: expr('$(options:low)'), color: PALETTE.call, gradient: false },
					{ value: expr('$(options:mid)'), color: PALETTE.ok, gradient: false },
				],
			},
		],
	},
	signal: {
		type: 'composite',
		name: 'Clear-Com: signal bars',
		description: '4 rising bars: 4-3 lit green, 2 amber, 1 red, none lit when the signal is unknown',
		options: [{ id: 'bars', type: 'number', label: 'Bars lit (0-4)', default: 0, min: 0, max: 4 }],
		elements: [1, 2, 3, 4].map((i): ButtonGraphicsBoxElement => ({
			id: `bar${i}`,
			type: 'box',
			x: (i - 1) * 27,
			y: 100 - 25 * i,
			width: 19,
			height: 25 * i,
			cornerRadius: 30,
			color: expr(
				`$(options:bars) >= ${i} ? ($(options:bars) >= 3 ? '${css(PALETTE.ok)}' : ` +
					`($(options:bars) == 2 ? '${css(PALETTE.call)}' : '${css(PALETTE.bad)}')) : '${css(PALETTE.track)}'`,
			),
		})),
	},
}

// --- element helpers ------------------------------------------------------------------------------

/** An element of a preset of this module (may use the module's composite elements). */
export type Element = SomeButtonGraphicsElement<CompositeElementsSchema>
export type Override = CompanionPresetFeedbackStyleOverride

type Bounds = { x: number; y: number; width: number; height: number }

/** A text element. Size is a percentage of the element height; long text shrinks to fit. */
export function text(
	id: string,
	value: string,
	b: Bounds,
	opts: {
		size?: number
		bold?: boolean
		color?: number
		halign?: 'left' | 'center' | 'right'
		valign?: 'top' | 'center' | 'bottom'
		mono?: boolean
	} = {},
): ButtonGraphicsTextElement {
	return {
		id,
		type: 'text',
		text: value,
		...b,
		fontsize: opts.size ?? 80,
		fontsizeAllowShrink: true,
		font: opts.mono ? 'companion-mono' : 'companion-sans',
		weight: opts.bold ? 'bold' : 'normal',
		color: opts.color ?? PALETTE.text,
		halign: opts.halign ?? 'center',
		valign: opts.valign ?? 'center',
	}
}

export function box(
	id: string,
	b: Bounds,
	color: number | string,
	extra: Partial<ButtonGraphicsBoxElement> = {},
): ButtonGraphicsBoxElement {
	return { id, type: 'box', ...b, color, ...extra }
}

/** The full-size background box every preset starts with (feedbacks recolour it). */
export const background = (color: number = PALETTE.bg): ButtonGraphicsBoxElement =>
	box('bg', { x: 0, y: 0, width: 100, height: 100 }, color)

/** A box outline over the whole button, hidden until a feedback enables it (selection, alerts). */
export const ring = (id: string, color: number, width = 5): ButtonGraphicsBoxElement =>
	box(id, { x: 0, y: 0, width: 100, height: 100 }, 'rgba(0,0,0,0)', {
		enabled: false,
		borderWidth: width,
		borderColor: color,
		borderPosition: 'inside',
		cornerRadius: 12,
	})

/** A small rounded label (e.g. key name), drawn as a chip with text. */
export function chip(id: string, value: string, b: Bounds, color: number, textColor: number): Element[] {
	return [
		box(`${id}Bg`, b, color, { cornerRadius: 35 }),
		text(`${id}Text`, value, b, { size: 78, bold: true, color: textColor }),
	]
}

const line = (id: string, fromX: number, fromY: number, toX: number, toY: number, color: number, width: number) =>
	({
		id,
		type: 'line',
		fromX,
		fromY,
		toX,
		toY,
		borderColor: color,
		borderWidth: width,
	}) satisfies ButtonGraphicsLineElement

/** A microphone icon, crossed out when `slashed` (remote mic kill). Square, drawn in `color`. */
export function micIcon(
	id: string,
	b: Bounds,
	color: number,
	slashed: boolean,
	slashBg: number,
): ButtonGraphicsGroupElement<CompositeElementsSchema> {
	const cradle: ButtonGraphicsCircleElement = {
		id: `${id}Cradle`,
		type: 'circle',
		x: 22,
		y: 18,
		width: 56,
		height: 56,
		color: 'rgba(0,0,0,0)',
		startAngle: 270,
		endAngle: 90,
		borderOnlyArc: true,
		borderWidth: 7,
		borderColor: color,
	}
	return {
		id,
		type: 'group',
		...b,
		squareCoords: true,
		children: [
			box(`${id}Capsule`, { x: 35, y: 4, width: 30, height: 54 }, color, { cornerRadius: 100 }),
			cradle,
			line(`${id}Stem`, 50, 74, 50, 88, color, 7),
			line(`${id}Base`, 34, 91, 66, 91, color, 7),
			...(slashed
				? [line(`${id}SlashBg`, 14, 8, 86, 94, slashBg, 17), line(`${id}Slash`, 14, 8, 86, 94, color, 8)]
				: []),
		],
	}
}

/** A switch (pill with a knob): knob left and grey when off; a feedback moves it right and turns it green. */
export function toggle(id: string, b: Bounds): Element[] {
	const knob = b.height - 8
	return [
		box(`${id}Track`, b, PALETTE.track, { cornerRadius: 100 }),
		{
			id: `${id}Knob`,
			type: 'circle',
			x: b.x + 4,
			y: b.y + 4,
			width: (knob * 100) / 100,
			height: knob,
			color: PALETTE.dim,
		},
	]
}

/** Overrides that turn a `toggle` on. */
export const toggleOn = (id: string, b: Bounds): Override[] => [
	{ elementId: `${id}Track`, elementProperty: 'color', override: PALETTE.ok },
	{ elementId: `${id}Knob`, elementProperty: 'color', override: PALETTE.white },
	{ elementId: `${id}Knob`, elementProperty: 'x', override: b.x + b.width - (b.height - 8) - 4 },
]
